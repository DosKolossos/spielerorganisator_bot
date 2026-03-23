
const {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  StringSelectMenuBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  MessageFlags
} = require('discord.js');
const db = require('../db/database');
const { todayInBerlin, isValidTime } = require('../utils/time');
const { playerDisplay, getPlayerById } = require('../utils/playerUtils');
const { isAdminInteraction } = require('../utils/permissions');

const WEEKLY_SOURCE = 'weekly_checkin';
const WEEKLY_PREFIX = 'verf';

const WEEKDAY_SHORT = ['So', 'Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa'];
const WEEKDAY_LONG = ['Sonntag', 'Montag', 'Dienstag', 'Mittwoch', 'Donnerstag', 'Freitag', 'Samstag'];

function addDaysIso(dateStr, daysToAdd) {
  const [year, month, day] = dateStr.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  date.setUTCDate(date.getUTCDate() + daysToAdd);
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, '0');
  const d = String(date.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function getDateWindow(startDate, numberOfDays = 7) {
  return Array.from({ length: numberOfDays }, (_, index) => addDaysIso(startDate, index));
}

function getWeekStartDate() {
  return addDaysIso(todayInBerlin(), 1);
}

function extractTimePart(dateTime) {
  return String(dateTime).slice(11, 16);
}

function formatDateShort(dateStr) {
  return `${dateStr.slice(8, 10)}.${dateStr.slice(5, 7)}.`;
}

function getWeekdayIndexFromIsoDate(dateStr) {
  const [year, month, day] = dateStr.split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, day)).getUTCDay();
}

function formatDayLabel(dateStr) {
  const weekday = WEEKDAY_SHORT[getWeekdayIndexFromIsoDate(dateStr)];
  return `${weekday}, ${formatDateShort(dateStr)}`;
}

function formatWeekRangeLabel(weekStartDate) {
  const weekEndDate = addDaysIso(weekStartDate, 6);
  return `${formatDateShort(weekStartDate)} – ${formatDateShort(weekEndDate)}`;
}

function getDailyCardRows(playerId, weekStartDate) {
  return db.prepare(`
    SELECT id, start_at, end_at
    FROM availability_entries
    WHERE player_id = ?
      AND source = ?
      AND source_ref = ?
    ORDER BY start_at ASC, end_at ASC, id ASC
  `).all(playerId, WEEKLY_SOURCE, weekStartDate);
}

function getEntriesForDate(rows, dateStr) {
  return rows.filter(row => String(row.start_at).slice(0, 10) === dateStr);
}

function deriveDayState(rowsForDate) {
  if (rowsForDate.length === 0) {
    return { kind: 'available', icon: '✅', text: 'verfügbar' };
  }

  const first = rowsForDate[0];
  const startTime = extractTimePart(first.start_at);
  const endTime = extractTimePart(first.end_at);

  if (startTime === '00:00' && endTime === '23:59') {
    return { kind: 'unavailable', icon: '❌', text: 'nicht verfügbar' };
  }

  const parts = [];

  if (startTime !== '00:00') {
    parts.push(`bis ${startTime} Uhr`);
  }

  if (endTime !== '23:59') {
    parts.push(`ab ${endTime} Uhr`);
  }

  return {
    kind: 'partial',
    icon: '🕒',
    text: parts.length ? parts.join(', ') : 'eingeschränkt verfügbar'
  };
}

function buildWeeklyStatusMap(playerId, weekStartDate) {
  const dates = getDateWindow(weekStartDate, 7);
  const rows = getDailyCardRows(playerId, weekStartDate);
  const map = new Map();

  for (const dateStr of dates) {
    map.set(dateStr, deriveDayState(getEntriesForDate(rows, dateStr)));
  }

  return map;
}

function getWeeklyCardRecord(playerId, weekStartDate) {
  return db.prepare(`
    SELECT *
    FROM weekly_availability_cards
    WHERE player_id = ? AND week_start_date = ?
  `).get(playerId, weekStartDate);
}

function upsertWeeklyCardRecord(playerId, weekStartDate, channelId, messageId) {
  const now = new Date().toISOString();

  db.prepare(`
    INSERT INTO weekly_availability_cards (
      player_id,
      week_start_date,
      channel_id,
      message_id,
      created_at,
      updated_at
    )
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(player_id, week_start_date)
    DO UPDATE SET
      channel_id = excluded.channel_id,
      message_id = excluded.message_id,
      updated_at = excluded.updated_at
  `).run(playerId, weekStartDate, channelId, messageId, now, now);
}

function getPlannedEvents(weekStartDate) {
  const weekEndDate = addDaysIso(weekStartDate, 6);
  return db.prepare(`
    SELECT id, title, opponent_name, event_type, status, option_date,
           COALESCE(scheduled_start_at, window_start_at) AS sort_at
    FROM team_calendar_events
    WHERE option_date >= ?
      AND option_date <= ?
      AND status <> 'cancelled'
    ORDER BY option_date ASC, COALESCE(scheduled_start_at, window_start_at) ASC, id ASC
  `).all(weekStartDate, weekEndDate);
}

function eventTypeLabel(eventType) {
  switch (eventType) {
    case 'primeleague':
      return 'PRM';
    case 'scrim':
      return 'Scrim';
    case 'open':
      return 'Offen';
    case 'other':
      return 'Sonstiges';
    default:
      return eventType || 'Termin';
  }
}

function buildPlannedEventLines(weekStartDate) {
  const events = getPlannedEvents(weekStartDate);
  if (events.length === 0) {
    return ['Keine geplanten Termine in den kommenden 7 Tagen.'];
  }

  return events.map(event => {
    const timePart = event.sort_at ? `${extractTimePart(event.sort_at)} Uhr` : 'Zeit offen';
    const opponent = event.opponent_name?.trim() ? ` vs ${event.opponent_name.trim()}` : '';
    return `• ${formatDayLabel(event.option_date)} — ${timePart} — ${eventTypeLabel(event.event_type)}${opponent}`;
  });
}

function buildWeeklyAvailabilityPayload(player, weekStartDate) {
  const statusMap = buildWeeklyStatusMap(player.id, weekStartDate);
  const dates = getDateWindow(weekStartDate, 7);
  const statusLines = dates.map(dateStr => {
    const state = statusMap.get(dateStr);
    return `${formatDayLabel(dateStr)} — ${state.icon} ${state.text}`;
  });

  const embed = new EmbedBuilder()
    .setTitle(`🗓️ Verfügbarkeit – ${playerDisplay(player)}`)
    .setDescription([
      `**Woche:** ${formatWeekRangeLabel(weekStartDate)}`,
      '',
      '**Geplante Termine**',
      ...buildPlannedEventLines(weekStartDate),
      '',
      '**Dein Status**',
      ...statusLines,
      '',
      'Klicke direkt auf einen Tag für **✅ / ❌**.',
      'Für Uhrzeiten nutze **🕒 Zeitfenster**.'
    ].join('\n'));

  const buttons = dates.map(dateStr => {
    const state = statusMap.get(dateStr);
    return new ButtonBuilder()
      .setCustomId(`${WEEKLY_PREFIX}:day:${player.id}:${weekStartDate}:${dateStr}`)
      .setLabel(`${WEEKDAY_SHORT[getWeekdayIndexFromIsoDate(dateStr)]} ${formatDateShort(dateStr)} ${state.icon}`)
      .setStyle(
        state.kind === 'available'
          ? ButtonStyle.Success
          : state.kind === 'unavailable'
            ? ButtonStyle.Danger
            : ButtonStyle.Secondary
      );
  });

  const rows = [
    new ActionRowBuilder().addComponents(...buttons.slice(0, 5)),
    new ActionRowBuilder().addComponents(
      ...buttons.slice(5, 7),
      new ButtonBuilder()
        .setCustomId(`${WEEKLY_PREFIX}:allyes:${player.id}:${weekStartDate}`)
        .setLabel('Alle ✅')
        .setStyle(ButtonStyle.Success),
      new ButtonBuilder()
        .setCustomId(`${WEEKLY_PREFIX}:allno:${player.id}:${weekStartDate}`)
        .setLabel('Alle ❌')
        .setStyle(ButtonStyle.Danger),
      new ButtonBuilder()
        .setCustomId(`${WEEKLY_PREFIX}:reset:${player.id}:${weekStartDate}`)
        .setLabel('Reset')
        .setStyle(ButtonStyle.Secondary)
    ),
    new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`${WEEKLY_PREFIX}:time:${player.id}:${weekStartDate}`)
        .setLabel('🕒 Zeitfenster')
        .setStyle(ButtonStyle.Primary)
    )
  ];

  return { embeds: [embed], components: rows };
}

async function upsertWeeklyAvailabilityCard(channel, player, weekStartDate) {
  const payload = buildWeeklyAvailabilityPayload(player, weekStartDate);
  const existing = getWeeklyCardRecord(player.id, weekStartDate);

  if (existing?.message_id) {
    try {
      const message = await channel.messages.fetch(existing.message_id);
      if (message) {
        await message.edit(payload);
        return { action: 'updated', message };
      }
    } catch (_) {
      // send new below
    }
  }

  const sentMessage = await channel.send(payload);
  upsertWeeklyCardRecord(player.id, weekStartDate, channel.id, sentMessage.id);
  return { action: 'created', message: sentMessage };
}

async function postOrRefreshWeeklyAvailabilityCards(client) {
  const channelId = process.env.WEEKLY_AVAILABILITY_CHANNEL_ID;
  if (!channelId) {
    return { sent: false, reason: 'missing_channel_id' };
  }

  const channel = await client.channels.fetch(channelId);
  if (!channel || !channel.isTextBased()) {
    return { sent: false, reason: 'invalid_channel' };
  }

  const weekStartDate = getWeekStartDate();
  const players = db.prepare(`
    SELECT id, discord_user_id, username, global_name, alias
    FROM players
    WHERE is_archived = 0
    ORDER BY id ASC
  `).all();

  let created = 0;
  let updated = 0;
  let failed = 0;

  for (const player of players) {
    try {
      const result = await upsertWeeklyAvailabilityCard(channel, player, weekStartDate);
      if (result.action === 'created') created++;
      else updated++;
    } catch (error) {
      failed++;
      console.error(`[WeeklyAvailability] Karte für ${playerDisplay(player)} fehlgeschlagen:`, error);
    }
  }

  return {
    sent: true,
    weekStartDate,
    created,
    updated,
    failed,
    playerCount: players.length
  };
}

function ensureOwnerOrAdmin(interaction, player) {
  if (!player) return false;
  if (isAdminInteraction(interaction)) return true;
  return interaction.user.id === player.discord_user_id;
}

async function denyWrongUser(interaction) {
  const payload = {
    content: 'Diese Wochenkarte gehört nicht dir.',
    flags: MessageFlags.Ephemeral
  };

  if (interaction.isButton() || interaction.isStringSelectMenu() || interaction.isModalSubmit()) {
    if (interaction.replied || interaction.deferred) {
      await interaction.followUp(payload).catch(() => null);
    } else {
      await interaction.reply(payload).catch(() => null);
    }
  }
}

function deleteWeeklyEntriesForDate(playerId, weekStartDate, dateStr) {
  db.prepare(`
    DELETE FROM availability_entries
    WHERE player_id = ?
      AND source = ?
      AND source_ref = ?
      AND start_at >= ?
      AND start_at <= ?
  `).run(playerId, WEEKLY_SOURCE, weekStartDate, `${dateStr} 00:00`, `${dateStr} 23:59`);
}

function insertWeeklyBlockedEntry(playerId, dateStr, startTime, endTime, actorDiscordUserId, weekStartDate) {
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO availability_entries (
      player_id,
      entry_type,
      start_at,
      end_at,
      reason,
      approval_status,
      reviewed_by_discord_user_id,
      reviewed_at,
      review_note,
      source,
      source_ref,
      created_by_discord_user_id,
      updated_by_discord_user_id,
      created_at,
      updated_at
    )
    VALUES (?, 'absence', ?, ?, ?, 'approved', ?, ?, NULL, ?, ?, ?, ?, ?, ?)
  `).run(
    playerId,
    `${dateStr} ${startTime}`,
    `${dateStr} ${endTime}`,
    'Wochencheck-in',
    actorDiscordUserId,
    now,
    WEEKLY_SOURCE,
    weekStartDate,
    actorDiscordUserId,
    actorDiscordUserId,
    now,
    now
  );
}

function setDayAvailability(playerId, dateStr, weekStartDate, mode, actorDiscordUserId) {
  deleteWeeklyEntriesForDate(playerId, weekStartDate, dateStr);

  if (mode === 'available') return;

  if (mode === 'unavailable') {
    insertWeeklyBlockedEntry(playerId, dateStr, '00:00', '23:59', actorDiscordUserId, weekStartDate);
  }
}

function applyTimeWindow(playerId, dateStr, weekStartDate, availableUntil, availableFrom, actorDiscordUserId) {
  deleteWeeklyEntriesForDate(playerId, weekStartDate, dateStr);

  const until = availableUntil?.trim() || '';
  const from = availableFrom?.trim() || '';

  if (!until && !from) {
    return { ok: true, mode: 'available' };
  }

  if (until && !isValidTime(until)) {
    return { ok: false, error: '„Verfügbar bis“ muss im Format HH:MM sein.' };
  }

  if (from && !isValidTime(from)) {
    return { ok: false, error: '„Verfügbar ab“ muss im Format HH:MM sein.' };
  }

  if (until && from && until >= from) {
    return { ok: false, error: '„Verfügbar bis“ muss vor „Verfügbar ab“ liegen.' };
  }

  if (until && until !== '23:59' && !from) {
    insertWeeklyBlockedEntry(playerId, dateStr, until, '23:59', actorDiscordUserId, weekStartDate);
    return { ok: true, mode: 'partial' };
  }

  if (from && from !== '00:00' && !until) {
    insertWeeklyBlockedEntry(playerId, dateStr, '00:00', from, actorDiscordUserId, weekStartDate);
    return { ok: true, mode: 'partial' };
  }

  if (until && from) {
    insertWeeklyBlockedEntry(playerId, dateStr, until, from, actorDiscordUserId, weekStartDate);
    return { ok: true, mode: 'partial' };
  }

  return { ok: true, mode: 'available' };
}

function clearWeekEntries(playerId, weekStartDate) {
  db.prepare(`
    DELETE FROM availability_entries
    WHERE player_id = ?
      AND source = ?
      AND source_ref = ?
  `).run(playerId, WEEKLY_SOURCE, weekStartDate);
}

function setWholeWeek(playerId, weekStartDate, mode, actorDiscordUserId) {
  clearWeekEntries(playerId, weekStartDate);
  if (mode !== 'unavailable') return;

  for (const dateStr of getDateWindow(weekStartDate, 7)) {
    insertWeeklyBlockedEntry(playerId, dateStr, '00:00', '23:59', actorDiscordUserId, weekStartDate);
  }
}

async function refreshWeeklyAvailabilityCard(client, playerId, weekStartDate) {
  const player = getPlayerById(playerId);
  if (!player) return false;
  const record = getWeeklyCardRecord(playerId, weekStartDate);
  if (!record?.channel_id) return false;

  try {
    const channel = await client.channels.fetch(record.channel_id);
    if (!channel || !channel.isTextBased()) return false;
    await upsertWeeklyAvailabilityCard(channel, player, weekStartDate);
    return true;
  } catch (error) {
    console.error('[WeeklyAvailability] Refresh fehlgeschlagen:', error);
    return false;
  }
}

function buildTimeWindowDaySelect(playerId, weekStartDate) {
  const options = getDateWindow(weekStartDate, 7).map(dateStr => ({
    label: formatDayLabel(dateStr),
    value: dateStr,
    description: `Zeitfenster für ${WEEKDAY_LONG[getWeekdayIndexFromIsoDate(dateStr)]} setzen`
  }));

  return new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId(`${WEEKLY_PREFIX}:timeday:${playerId}:${weekStartDate}`)
      .setPlaceholder('Tag für Zeitfenster auswählen')
      .addOptions(options)
  );
}

async function handleDayButton(interaction, playerId, weekStartDate, dateStr) {
  const player = getPlayerById(playerId);
  if (!ensureOwnerOrAdmin(interaction, player)) {
    return denyWrongUser(interaction);
  }

  const currentState = buildWeeklyStatusMap(playerId, weekStartDate).get(dateStr);
  const nextMode = currentState.kind === 'unavailable' ? 'available' : 'unavailable';
  setDayAvailability(playerId, dateStr, weekStartDate, nextMode, interaction.user.id);

  await refreshWeeklyAvailabilityCard(interaction.client, playerId, weekStartDate);
  return interaction.deferUpdate();
}

async function handleMassButton(interaction, playerId, weekStartDate, mode) {
  const player = getPlayerById(playerId);
  if (!ensureOwnerOrAdmin(interaction, player)) {
    return denyWrongUser(interaction);
  }

  if (mode === 'reset' || mode === 'allyes') {
    clearWeekEntries(playerId, weekStartDate);
  } else if (mode === 'allno') {
    setWholeWeek(playerId, weekStartDate, 'unavailable', interaction.user.id);
  }

  await refreshWeeklyAvailabilityCard(interaction.client, playerId, weekStartDate);
  return interaction.deferUpdate();
}

async function handleTimeButton(interaction, playerId, weekStartDate) {
  const player = getPlayerById(playerId);
  if (!ensureOwnerOrAdmin(interaction, player)) {
    return denyWrongUser(interaction);
  }

  return interaction.reply({
    content: 'Wähle zuerst den Tag aus, für den du ein Zeitfenster setzen möchtest.',
    components: [buildTimeWindowDaySelect(playerId, weekStartDate)],
    flags: MessageFlags.Ephemeral
  });
}

async function handleTimeDaySelect(interaction, playerId, weekStartDate) {
  const player = getPlayerById(playerId);
  if (!ensureOwnerOrAdmin(interaction, player)) {
    return denyWrongUser(interaction);
  }

  const dateStr = interaction.values[0];
  const state = buildWeeklyStatusMap(playerId, weekStartDate).get(dateStr);
  const existingUntil = state.kind === 'partial' && state.text.includes('bis ') ? state.text.match(/bis (\d{2}:\d{2}) Uhr/)?.[1] || '' : '';
  const existingFrom = state.kind === 'partial' && state.text.includes('ab ') ? state.text.match(/ab (\d{2}:\d{2}) Uhr/)?.[1] || '' : '';

  const modal = new ModalBuilder()
    .setCustomId(`${WEEKLY_PREFIX}:timemodal:${playerId}:${weekStartDate}:${dateStr}`)
    .setTitle(`Zeitfenster – ${formatDayLabel(dateStr)}`)
    .addComponents(
      new ActionRowBuilder().addComponents(
        (() => {
          const input = new TextInputBuilder()
            .setCustomId('available_until')
            .setLabel('Verfügbar bis (HH:MM)')
            .setStyle(TextInputStyle.Short)
            .setRequired(false)
            .setPlaceholder('z. B. 15:00');
          if (existingUntil) input.setValue(existingUntil);
          return input;
        })()
      ),
      new ActionRowBuilder().addComponents(
        (() => {
          const input = new TextInputBuilder()
            .setCustomId('available_from')
            .setLabel('Verfügbar ab (HH:MM)')
            .setStyle(TextInputStyle.Short)
            .setRequired(false)
            .setPlaceholder('z. B. 18:00');
          if (existingFrom) input.setValue(existingFrom);
          return input;
        })()
      )
    );

  return interaction.showModal(modal);
}

async function handleTimeModal(interaction, playerId, weekStartDate, dateStr) {
  const player = getPlayerById(playerId);
  if (!ensureOwnerOrAdmin(interaction, player)) {
    return denyWrongUser(interaction);
  }

  const availableUntil = interaction.fields.getTextInputValue('available_until');
  const availableFrom = interaction.fields.getTextInputValue('available_from');
  const result = applyTimeWindow(playerId, dateStr, weekStartDate, availableUntil, availableFrom, interaction.user.id);

  if (!result.ok) {
    return interaction.reply({ content: result.error, flags: MessageFlags.Ephemeral });
  }

  await refreshWeeklyAvailabilityCard(interaction.client, playerId, weekStartDate);
  return interaction.reply({
    content: `Zeitfenster für **${formatDayLabel(dateStr)}** gespeichert.`,
    flags: MessageFlags.Ephemeral
  });
}

function canHandleInteraction(interaction) {
  return interaction.customId?.startsWith(`${WEEKLY_PREFIX}:`);
}

async function handleInteraction(interaction) {
  const parts = interaction.customId.split(':');
  const action = parts[1];
  const playerId = Number(parts[2]);
  const weekStartDate = parts[3];
  const dateStr = parts[4];

  if (interaction.isButton()) {
    if (action === 'day') return handleDayButton(interaction, playerId, weekStartDate, dateStr);
    if (action === 'allyes' || action === 'allno' || action === 'reset') {
      return handleMassButton(interaction, playerId, weekStartDate, action);
    }
    if (action === 'time') return handleTimeButton(interaction, playerId, weekStartDate);
  }

  if (interaction.isStringSelectMenu()) {
    if (action === 'timeday') return handleTimeDaySelect(interaction, playerId, weekStartDate);
  }

  if (interaction.isModalSubmit()) {
    if (action === 'timemodal') return handleTimeModal(interaction, playerId, weekStartDate, dateStr);
  }
}

module.exports = {
  WEEKLY_PREFIX,
  getWeekStartDate,
  postOrRefreshWeeklyAvailabilityCards,
  refreshWeeklyAvailabilityCard,
  canHandleInteraction,
  handleInteraction
};
