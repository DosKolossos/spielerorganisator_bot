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
const { upsertPlayer, playerDisplay } = require('../utils/playerUtils');

const PREFIX = 'wavail';

function addDaysIso(dateStr, days) {
  const [year, month, day] = dateStr.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  date.setUTCDate(date.getUTCDate() + days);
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, '0');
  const d = String(date.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function getWeekStartDate(baseDate = todayInBerlin()) {
  return addDaysIso(baseDate, 1);
}

function getWeekDates(weekStartDate) {
  return Array.from({ length: 7 }, (_, index) => addDaysIso(weekStartDate, index));
}

function formatDateShort(dateStr) {
  const [year, month, day] = dateStr.split('-');
  return `${day}.${month}.`;
}

function formatDateRange(startDate, endDate) {
  return `${formatDateShort(startDate)} – ${formatDateShort(endDate)}`;
}

function getWeekdayShort(dateStr) {
  const [year, month, day] = dateStr.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  const weekday = date.getUTCDay();
  const labels = ['So', 'Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa'];
  return labels[weekday];
}

function formatDayButtonLabel(dateStr, icon) {
  return `${getWeekdayShort(dateStr)} ${formatDateShort(dateStr)} ${icon}`;
}

function formatDayLine(dateStr, state) {
  const prefix = `${getWeekdayShort(dateStr)}, ${formatDateShort(dateStr)}`;
  if (state.kind === 'unavailable') {
    return `${prefix} ❌ nicht verfügbar`;
  }
  if (state.kind === 'window') {
    return `${prefix} 🕒 ${state.from}–${state.until}`;
  }
  if (state.kind === 'partial') {
    if (state.until && state.from) {
      return `${prefix} 🕒 bis ${state.until}, ab ${state.from}`;
    }
    if (state.until) {
      return `${prefix} 🕒 bis ${state.until}`;
    }
    if (state.from) {
      return `${prefix} 🕒 ab ${state.from}`;
    }
  }
  return `${prefix} ✅ verfügbar`;
}

function getEntryReasonForState(state) {
  if (state.kind === 'unavailable') {
    return 'Wochen-Check-in: ganztägig nicht verfügbar';
  }
  if (state.kind === 'window') {
    return `Wochen-Check-in: verfügbar von ${state.from} bis ${state.until}`;
  }
  if (state.kind === 'partial') {
    if (state.until && state.from) {
      return `Wochen-Check-in: verfügbar bis ${state.until}, ab ${state.from}`;
    }
    if (state.until) {
      return `Wochen-Check-in: verfügbar bis ${state.until}`;
    }
    if (state.from) {
      return `Wochen-Check-in: verfügbar ab ${state.from}`;
    }
  }
  return 'Wochen-Check-in';
}

function getCurrentWeekPost(weekStartDate) {
  return db.prepare(`
    SELECT *
    FROM weekly_availability_posts
    WHERE week_start_date = ?
  `).get(weekStartDate);
}

function buildPublicPromptEmbed(weekStartDate) {
  const weekDates = getWeekDates(weekStartDate);
  const weekEndDate = weekDates[weekDates.length - 1];

  return new EmbedBuilder()
    .setTitle(`📅 Verfügbarkeitscheck – ${formatDateRange(weekStartDate, weekEndDate)}`)
    .setDescription(
      'Klicke auf **Meine Woche öffnen** und markiere deine Verfügbarkeit für die kommenden 7 Tage.\n\n' +
      'Normale Klicks setzen einen Tag auf **✅ verfügbar** oder **❌ nicht verfügbar**.\n' +
      'Über **🕒 Zeitfenster** kannst du z. B. **bis 15:00** oder **ab 18:00** angeben.'
    );
}

function buildPublicPromptComponents(weekStartDate) {
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`${PREFIX}:open:${weekStartDate}`)
        .setLabel('Meine Woche öffnen')
        .setStyle(ButtonStyle.Primary)
    )
  ];
}

async function publishWeeklyAvailabilityPrompt(client, options = {}) {
  const weekStartDate = options.weekStartDate || getWeekStartDate();
  const channelId = process.env.WEEKLY_AVAILABILITY_CHANNEL_ID;

  if (!channelId) {
    return { sent: false, reason: 'missing_channel_id' };
  }

  const channel = await client.channels.fetch(channelId).catch(() => null);
  if (!channel || !channel.isTextBased()) {
    return { sent: false, reason: 'invalid_channel' };
  }

  const payload = {
    embeds: [buildPublicPromptEmbed(weekStartDate)],
    components: buildPublicPromptComponents(weekStartDate)
  };

  const existing = getCurrentWeekPost(weekStartDate);
  const now = new Date().toISOString();

  if (existing?.message_id) {
    const existingMessage = await channel.messages.fetch(existing.message_id).catch(() => null);
    if (existingMessage) {
      await existingMessage.edit(payload);
      db.prepare(`
        UPDATE weekly_availability_posts
        SET channel_id = ?, updated_at = ?
        WHERE id = ?
      `).run(channel.id, now, existing.id);

      return { sent: true, mode: 'updated', weekStartDate, messageId: existingMessage.id };
    }
  }

  const sentMessage = await channel.send(payload);

  if (existing) {
    db.prepare(`
      UPDATE weekly_availability_posts
      SET channel_id = ?, message_id = ?, updated_at = ?
      WHERE id = ?
    `).run(channel.id, sentMessage.id, now, existing.id);
  } else {
    db.prepare(`
      INSERT INTO weekly_availability_posts (
        week_start_date,
        channel_id,
        message_id,
        created_at,
        updated_at
      )
      VALUES (?, ?, ?, ?, ?)
    `).run(weekStartDate, channel.id, sentMessage.id, now, now);
  }

  return { sent: true, mode: 'created', weekStartDate, messageId: sentMessage.id };
}

function getWeeklyEntries(playerId, weekStartDate) {
  const weekEndDate = addDaysIso(weekStartDate, 6);
  return db.prepare(`
    SELECT *
    FROM availability_entries
    WHERE player_id = ?
      AND source = 'weekly_checkin'
      AND end_at >= ?
      AND start_at <= ?
    ORDER BY start_at ASC
  `).all(playerId, `${weekStartDate} 00:00`, `${weekEndDate} 23:59`);
}

function getWeeklyEntriesForDate(entries, dateStr) {
  return entries
    .filter(entry => entry.start_at.startsWith(`${dateStr} `) || entry.end_at.startsWith(`${dateStr} `))
    .sort((a, b) => a.start_at.localeCompare(b.start_at));
}

function deriveStateFromEntries(dayEntries) {
  if (!dayEntries || dayEntries.length === 0) {
    return { kind: 'available', icon: '✅' };
  }

  const entries = [...dayEntries].sort((a, b) => a.start_at.localeCompare(b.start_at));
  const first = entries[0];
  const last = entries[entries.length - 1];
  const firstStart = first.start_at.slice(11, 16);
  const firstEnd = first.end_at.slice(11, 16);
  const lastStart = last.start_at.slice(11, 16);
  const lastEnd = last.end_at.slice(11, 16);

  if (entries.length === 1) {
    if (firstStart === '00:00' && firstEnd === '23:59') {
      return { kind: 'unavailable', icon: '❌' };
    }

    if (firstStart === '00:00') {
      return { kind: 'partial', from: firstEnd, icon: '🕒' };
    }

    if (firstEnd === '23:59') {
      return { kind: 'partial', until: firstStart, icon: '🕒' };
    }

    return { kind: 'partial', until: firstStart, from: firstEnd, icon: '🕒' };
  }

  if (entries.length === 2 && firstStart === '00:00' && lastEnd === '23:59' && firstEnd <= lastStart) {
    return { kind: 'window', from: firstEnd, until: lastStart, icon: '🕒' };
  }

  if (firstStart === '00:00' && lastEnd === '23:59') {
    return { kind: 'unavailable', icon: '❌' };
  }

  if (firstStart === '00:00') {
    return { kind: 'partial', from: firstEnd, icon: '🕒' };
  }

  if (lastEnd === '23:59') {
    return { kind: 'partial', until: lastStart, icon: '🕒' };
  }

  return { kind: 'partial', until: firstStart, from: lastEnd, icon: '🕒' };
}

function buildEditorEmbed(player, weekStartDate) {
  const weekDates = getWeekDates(weekStartDate);
  const entries = getWeeklyEntries(player.id, weekStartDate);
  const lines = weekDates.map(dateStr => {
    const dayEntries = getWeeklyEntriesForDate(entries, dateStr);
    return formatDayLine(dateStr, deriveStateFromEntries(dayEntries));
  });

  return new EmbedBuilder()
    .setTitle(`🗓️ Deine Woche – ${playerDisplay(player)}`)
    .setDescription(lines.join('\n'))
    .setFooter({ text: 'Tagesbutton = ✅/❌ umschalten · Zeitfenster für eingeschränkte Verfügbarkeit' });
}

function buildEditorComponents(player, weekStartDate, options = {}) {
  const weekDates = getWeekDates(weekStartDate);
  const entries = getWeeklyEntries(player.id, weekStartDate);
  const withTimeSelect = options.withTimeSelect === true;

  const dayButtons = weekDates.map(dateStr => {
    const dayEntries = getWeeklyEntriesForDate(entries, dateStr);
    const state = deriveStateFromEntries(dayEntries);

    return new ButtonBuilder()
      .setCustomId(`${PREFIX}:toggle:${weekStartDate}:${dateStr}`)
      .setLabel(formatDayButtonLabel(dateStr, state.icon))
      .setStyle(
        state.kind === 'available'
          ? ButtonStyle.Success
          : state.kind === 'unavailable'
            ? ButtonStyle.Danger
            : ButtonStyle.Secondary
      );
  });

  const rows = [];
  rows.push(new ActionRowBuilder().addComponents(dayButtons.slice(0, 4)));
  rows.push(new ActionRowBuilder().addComponents(dayButtons.slice(4, 7)));

  rows.push(new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`${PREFIX}:allyes:${weekStartDate}`)
      .setLabel('Alle ✅')
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId(`${PREFIX}:allno:${weekStartDate}`)
      .setLabel('Alle ❌')
      .setStyle(ButtonStyle.Danger),
    new ButtonBuilder()
      .setCustomId(`${PREFIX}:reset:${weekStartDate}`)
      .setLabel('Reset')
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(`${PREFIX}:time:${weekStartDate}`)
      .setLabel('🕒 Zeitfenster')
      .setStyle(ButtonStyle.Primary)
  ));

  if (withTimeSelect) {
    rows.push(new ActionRowBuilder().addComponents(
      new StringSelectMenuBuilder()
        .setCustomId(`${PREFIX}:timeday:${weekStartDate}`)
        .setPlaceholder('Tag für Zeitfenster auswählen')
        .addOptions(weekDates.map(dateStr => ({
          label: `${getWeekdayShort(dateStr)}, ${formatDateShort(dateStr)}`,
          value: dateStr
        })))
    ));
  }

  return rows;
}

function buildEditorPayload(player, weekStartDate, options = {}) {
  return {
    embeds: [buildEditorEmbed(player, weekStartDate)],
    components: buildEditorComponents(player, weekStartDate, options)
  };
}

function deleteWeeklyCheckinForDay(playerId, dateStr) {
  db.prepare(`
    DELETE FROM availability_entries
    WHERE player_id = ?
      AND source = 'weekly_checkin'
      AND start_at >= ?
      AND start_at <= ?
  `).run(playerId, `${dateStr} 00:00`, `${dateStr} 23:59`);
}

function insertWeeklyCheckinEntryRange({ playerId, actorDiscordUserId, startAt, endAt, reason }) {
  const now = new Date().toISOString();

  db.prepare(`
    INSERT INTO availability_entries (
      player_id,
      entry_type,
      start_at,
      end_at,
      reason,
      source,
      approval_status,
      created_by_discord_user_id,
      updated_by_discord_user_id,
      created_at,
      updated_at
    )
    VALUES (?, 'absence', ?, ?, ?, 'weekly_checkin', 'approved', ?, ?, ?, ?)
  `).run(
    playerId,
    startAt,
    endAt,
    reason,
    actorDiscordUserId,
    actorDiscordUserId,
    now,
    now
  );
}

function insertWeeklyCheckinEntries({ playerId, actorDiscordUserId, dateStr, state }) {
  const reason = getEntryReasonForState(state);

  if (state.kind === 'unavailable') {
    insertWeeklyCheckinEntryRange({
      playerId,
      actorDiscordUserId,
      startAt: `${dateStr} 00:00`,
      endAt: `${dateStr} 23:59`,
      reason
    });
    return;
  }

  if (state.kind === 'window') {
    insertWeeklyCheckinEntryRange({
      playerId,
      actorDiscordUserId,
      startAt: `${dateStr} 00:00`,
      endAt: `${dateStr} ${state.from}`,
      reason
    });
    insertWeeklyCheckinEntryRange({
      playerId,
      actorDiscordUserId,
      startAt: `${dateStr} ${state.until}`,
      endAt: `${dateStr} 23:59`,
      reason
    });
    return;
  }

  if (state.kind === 'partial') {
    if (state.until && state.from) {
      insertWeeklyCheckinEntryRange({
        playerId,
        actorDiscordUserId,
        startAt: `${dateStr} ${state.until}`,
        endAt: `${dateStr} ${state.from}`,
        reason
      });
      return;
    }

    if (state.until) {
      insertWeeklyCheckinEntryRange({
        playerId,
        actorDiscordUserId,
        startAt: `${dateStr} ${state.until}`,
        endAt: `${dateStr} 23:59`,
        reason
      });
      return;
    }

    if (state.from) {
      insertWeeklyCheckinEntryRange({
        playerId,
        actorDiscordUserId,
        startAt: `${dateStr} 00:00`,
        endAt: `${dateStr} ${state.from}`,
        reason
      });
    }
  }
}

function setDayState(playerId, actorDiscordUserId, dateStr, state) {
  deleteWeeklyCheckinForDay(playerId, dateStr);
  if (state.kind !== 'available') {
    insertWeeklyCheckinEntries({ playerId, actorDiscordUserId, dateStr, state });
  }
}

function toggleDayState(player, actorDiscordUserId, dateStr, weekStartDate) {
  const entries = getWeeklyEntries(player.id, weekStartDate);
  const current = deriveStateFromEntries(getWeeklyEntriesForDate(entries, dateStr));

  let nextState;
  if (current.kind === 'available') {
    nextState = { kind: 'unavailable' };
  } else if (current.kind === 'partial') {
    nextState = { kind: 'unavailable' };
  } else {
    nextState = { kind: 'available' };
  }

  setDayState(player.id, actorDiscordUserId, dateStr, nextState);
}

function setAllDays(playerId, actorDiscordUserId, weekStartDate, state) {
  for (const dateStr of getWeekDates(weekStartDate)) {
    setDayState(playerId, actorDiscordUserId, dateStr, state);
  }
}

function resetWeek(playerId, weekStartDate) {
  const weekEndDate = addDaysIso(weekStartDate, 6);
  db.prepare(`
    DELETE FROM availability_entries
    WHERE player_id = ?
      AND source = 'weekly_checkin'
      AND start_at >= ?
      AND start_at <= ?
  `).run(playerId, `${weekStartDate} 00:00`, `${weekEndDate} 23:59`);
}

function parseCustomId(customId) {
  const parts = String(customId || '').split(':');
  if (parts[0] !== PREFIX) return null;
  return parts;
}

function canHandleInteraction(interaction) {
  return Boolean(parseCustomId(interaction.customId));
}

async function openEditor(interaction, weekStartDate, options = {}) {
  const player = upsertPlayer(interaction.user);
  const payload = buildEditorPayload(player, weekStartDate, options);

  if (interaction.isButton() && !interaction.replied && !interaction.deferred) {
    return interaction.reply({ ...payload, flags: MessageFlags.Ephemeral });
  }

  if (interaction.isStringSelectMenu() || interaction.isButton()) {
    return interaction.update(payload);
  }

  return interaction.reply({ ...payload, flags: MessageFlags.Ephemeral });
}

function buildTimeWindowModal(weekStartDate, dateStr) {
  const modal = new ModalBuilder()
    .setCustomId(`${PREFIX}:timemodal:${weekStartDate}:${dateStr}`)
    .setTitle(`Zeitfenster – ${getWeekdayShort(dateStr)}, ${formatDateShort(dateStr)}`);

  modal.addComponents(
    new ActionRowBuilder().addComponents(
      new TextInputBuilder()
        .setCustomId('available_from')
        .setLabel('Verfügbar ab (HH:MM, optional)')
        .setRequired(false)
        .setStyle(TextInputStyle.Short)
        .setPlaceholder('z. B. 19:30')
    ),
    new ActionRowBuilder().addComponents(
      new TextInputBuilder()
        .setCustomId('available_until')
        .setLabel('Verfügbar bis (HH:MM, optional)')
        .setRequired(false)
        .setStyle(TextInputStyle.Short)
        .setPlaceholder('z. B. 22:00')
    )
  );

  return modal;
}

function buildStateFromTimes(from, until) {
  if (!from && !until) {
    return { kind: 'available' };
  }

  if (from && !isValidTime(from)) {
    return { error: '„Verfügbar ab“ ist ungültig. Nutze HH:MM.' };
  }

  if (until && !isValidTime(until)) {
    return { error: '„Verfügbar bis“ ist ungültig. Nutze HH:MM.' };
  }

  if (from && until) {
    if (from >= until) {
      return { error: '„Verfügbar ab“ muss vor „Verfügbar bis“ liegen.' };
    }

    if (from === '00:00' && until === '23:59') {
      return { kind: 'available' };
    }

    if (from === '00:00') {
      return { kind: 'partial', until };
    }

    if (until === '23:59') {
      return { kind: 'partial', from };
    }

    return { kind: 'window', from, until };
  }

  if (from) {
    if (from === '00:00') {
      return { kind: 'available' };
    }
    return { kind: 'partial', from };
  }

  if (until === '23:59') {
    return { kind: 'available' };
  }

  return { kind: 'partial', until };
}

async function handleInteraction(interaction) {
  const parts = parseCustomId(interaction.customId);
  if (!parts) return false;

  const action = parts[1];
  const weekStartDate = parts[2];

  if (interaction.isButton()) {
    if (action === 'open') {
      await openEditor(interaction, weekStartDate);
      return true;
    }

    if (action === 'toggle') {
      const dateStr = parts[3];
      const player = upsertPlayer(interaction.user);
      toggleDayState(player, interaction.user.id, dateStr, weekStartDate);
      await openEditor(interaction, weekStartDate);
      return true;
    }

    if (action === 'allyes') {
      const player = upsertPlayer(interaction.user);
      resetWeek(player.id, weekStartDate);
      await openEditor(interaction, weekStartDate);
      return true;
    }

    if (action === 'allno') {
      const player = upsertPlayer(interaction.user);
      setAllDays(player.id, interaction.user.id, weekStartDate, { kind: 'unavailable' });
      await openEditor(interaction, weekStartDate);
      return true;
    }

    if (action === 'reset') {
      const player = upsertPlayer(interaction.user);
      resetWeek(player.id, weekStartDate);
      await openEditor(interaction, weekStartDate);
      return true;
    }

    if (action === 'time') {
      await openEditor(interaction, weekStartDate, { withTimeSelect: true });
      return true;
    }
  }

  if (interaction.isStringSelectMenu()) {
    if (action === 'timeday') {
      const dateStr = interaction.values[0];
      await interaction.showModal(buildTimeWindowModal(weekStartDate, dateStr));
      return true;
    }
  }

  if (interaction.isModalSubmit()) {
    if (action === 'timemodal') {
      const dateStr = parts[3];
      const from = interaction.fields.getTextInputValue('available_from').trim();
      const until = interaction.fields.getTextInputValue('available_until').trim();
      const player = upsertPlayer(interaction.user);
      const nextState = buildStateFromTimes(from || null, until || null);

      if (nextState.error) {
        await interaction.reply({ content: nextState.error, flags: MessageFlags.Ephemeral });
        return true;
      }

      setDayState(player.id, interaction.user.id, dateStr, nextState);
      await interaction.reply({
        ...buildEditorPayload(player, weekStartDate),
        flags: MessageFlags.Ephemeral
      });
      return true;
    }
  }

  return false;
}

module.exports = {
  PREFIX,
  addDaysIso,
  getWeekStartDate,
  getWeekDates,
  publishWeeklyAvailabilityPrompt,
  canHandleInteraction,
  handleInteraction
};
