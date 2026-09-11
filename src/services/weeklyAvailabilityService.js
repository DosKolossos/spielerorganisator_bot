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
const { requireAdmin } = require('../utils/permissions');
const { getTeamById, resolveTeamForInteraction } = require('./teamService');

const PREFIX = 'wavail';
const DAYS_PER_WEEK = 7;
const MAX_RANGE_DAYS = 35;
const plannerRefreshQueues = new Map();

function schedulePlannerRefresh(client, teamId, dates) {
  if (!client || !teamId) return;

  let queue = plannerRefreshQueues.get(teamId);
  if (!queue) {
    queue = { dates: new Set(), timer: null };
    plannerRefreshQueues.set(teamId, queue);
  }

  for (const dateStr of dates || []) {
    if (dateStr) queue.dates.add(dateStr);
  }

  if (queue.timer) clearTimeout(queue.timer);
  queue.timer = setTimeout(async () => {
    const queuedDates = [...queue.dates];
    plannerRefreshQueues.delete(teamId);

    try {
      // Lazy laden, damit weeklyAvailabilityService und sundayPlanner sich
      // beim Programmstart nicht gegenseitig als Modul benötigen.
      const { refreshPlannerDates } = require('../jobs/sundayPlanner');
      const { refreshStoredAdminCardsForDates } = require('../commands/spieltermin');
      const result = await refreshPlannerDates(client, { teamId, dates: queuedDates });
      const refreshedAdminCards = await refreshStoredAdminCardsForDates(client, teamId, queuedDates);
      if (result.refreshed > 0 || refreshedAdminCards > 0) {
        console.log(
          `[Verfügbarkeit] Team ${teamId}: ${result.refreshed} Planner-Termine und ${refreshedAdminCards} Admin-Karten live aktualisiert.`
        );
      }
    } catch (error) {
      console.error(`[Verfügbarkeit] Live-Aktualisierung für Team ${teamId} fehlgeschlagen:`, error);
    }
  }, 1500);
}

function addDaysIso(dateStr, days) {
  const [year, month, day] = dateStr.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  date.setUTCDate(date.getUTCDate() + days);
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, '0');
  const d = String(date.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function isValidIsoDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value || '')) return false;

  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
  );
}

function parseDateInput(value) {
  const trimmed = String(value || '').trim();
  if (!trimmed) return null;

  if (isValidIsoDate(trimmed)) {
    return trimmed;
  }

  if (/^\d{2}\.\d{2}\.\d{4}$/.test(trimmed)) {
    const [day, month, year] = trimmed.split('.');
    const iso = `${year}-${month}-${day}`;
    return isValidIsoDate(iso) ? iso : null;
  }

  return null;
}

function getDayDiffInclusive(startDate, endDate) {
  const [sy, sm, sd] = startDate.split('-').map(Number);
  const [ey, em, ed] = endDate.split('-').map(Number);
  const start = Date.UTC(sy, sm - 1, sd);
  const end = Date.UTC(ey, em - 1, ed);
  return Math.floor((end - start) / (1000 * 60 * 60 * 24)) + 1;
}

function getMondayOfWeek(dateStr) {
  const [year, month, day] = dateStr.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  const weekday = date.getUTCDay();
  const diffToMonday = weekday === 0 ? 6 : weekday - 1;
  date.setUTCDate(date.getUTCDate() - diffToMonday);
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, '0');
  const d = String(date.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function getSundayOfWeek(dateStr) {
  return addDaysIso(getMondayOfWeek(dateStr), 6);
}

function getDefaultRangeStartDate() {
  return getMondayOfWeek(todayInBerlin());
}

function getDefaultRangeEndDate() {
  return addDaysIso(getDefaultRangeStartDate(), 13);
}

function normalizeRangeToFullWeeks(startDate, endDate) {
  return {
    startDate: getMondayOfWeek(startDate),
    endDate: getSundayOfWeek(endDate)
  };
}

function getWeekStartDate(baseDate = todayInBerlin()) {
  return getMondayOfWeek(baseDate);
}

function getWeekDates(weekStartDate) {
  return Array.from({ length: DAYS_PER_WEEK }, (_, index) => addDaysIso(weekStartDate, index));
}

function getWeekStartsInRange(startDate, endDate) {
  const weekStarts = [];
  let current = getMondayOfWeek(startDate);
  const last = getMondayOfWeek(endDate);

  while (current <= last) {
    weekStarts.push(current);
    current = addDaysIso(current, 7);
  }

  return weekStarts;
}

function formatDateShort(dateStr) {
  const [year, month, day] = dateStr.split('-');
  return `${day}.${month}.`;
}

function formatDateDE(dateStr) {
  const [year, month, day] = dateStr.split('-');
  return `${day}.${month}.${year}`;
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

function getCurrentWeekPost(teamId, weekStartDate) {
  return db.prepare(`
    SELECT *
    FROM weekly_availability_posts
    WHERE team_id = ? AND week_start_date = ?
  `).get(teamId, weekStartDate);
}

function buildAvailabilityRangeModal(teamId) {
  const modal = new ModalBuilder()
    .setCustomId(`${PREFIX}:rangemodal:${teamId || 0}`)
    .setTitle('Wochenkarten-Zeitraum');

  const startInput = new TextInputBuilder()
    .setCustomId('start_date')
    .setLabel('Von-Datum (TT.MM.JJJJ oder JJJJ-MM-TT)')
    .setStyle(TextInputStyle.Short)
    .setRequired(true)
    .setValue(formatDateDE(getDefaultRangeStartDate()))
    .setPlaceholder('z. B. 11.05.2026');

  const endInput = new TextInputBuilder()
    .setCustomId('end_date')
    .setLabel('Bis-Datum (TT.MM.JJJJ oder JJJJ-MM-TT)')
    .setStyle(TextInputStyle.Short)
    .setRequired(true)
    .setValue(formatDateDE(getDefaultRangeEndDate()))
    .setPlaceholder('z. B. 24.05.2026');

  modal.addComponents(
    new ActionRowBuilder().addComponents(startInput),
    new ActionRowBuilder().addComponents(endInput)
  );

  return modal;
}

function buildPublicPromptEmbed(weekStartDate) {
  const weekDates = getWeekDates(weekStartDate);
  const weekEndDate = weekDates[weekDates.length - 1];

  return new EmbedBuilder()
    .setTitle(`📅 Verfügbarkeitscheck – ${formatDateRange(weekStartDate, weekEndDate)}`)
    .setDescription(
      `Diese Karte gilt für **Montag bis Sonntag** (${formatDateDE(weekStartDate)} – ${formatDateDE(weekEndDate)}).\n\n` +
      'Klicke auf **Meine Woche öffnen** und markiere deine Verfügbarkeit für diese Woche.\n\n' +
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

async function upsertWeeklyAvailabilityPrompt(channel, teamId, weekStartDate) {
  const weekEndDate = addDaysIso(weekStartDate, DAYS_PER_WEEK - 1);
  const payload = {
    embeds: [buildPublicPromptEmbed(weekStartDate)],
    components: buildPublicPromptComponents(weekStartDate)
  };

  const existing = getCurrentWeekPost(teamId, weekStartDate);
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

      return {
        mode: 'updated',
        weekStartDate,
        weekEndDate,
        messageId: existingMessage.id
      };
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
        team_id,
        week_start_date,
        channel_id,
        message_id,
        created_at,
        updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(teamId, weekStartDate, channel.id, sentMessage.id, now, now);
  }

  return {
    mode: 'created',
    weekStartDate,
    weekEndDate,
    messageId: sentMessage.id
  };
}

async function publishWeeklyAvailabilityPrompt(client, options = {}) {
  const rawStartDate = options.startDate || getDefaultRangeStartDate();
  const rawEndDate = options.endDate || getDefaultRangeEndDate();
  const normalizedRange = normalizeRangeToFullWeeks(rawStartDate, rawEndDate);
  const team = options.teamId ? getTeamById(options.teamId) : null;
  const channelId = team?.availability_channel_id || process.env.WEEKLY_AVAILABILITY_CHANNEL_ID;

  if (!channelId) {
    return { sent: false, reason: 'missing_channel_id' };
  }

  const rangeDays = getDayDiffInclusive(normalizedRange.startDate, normalizedRange.endDate);
  if (rangeDays > MAX_RANGE_DAYS) {
    return {
      sent: false,
      reason: 'range_too_large',
      maxRangeDays: MAX_RANGE_DAYS,
      normalizedStartDate: normalizedRange.startDate,
      normalizedEndDate: normalizedRange.endDate
    };
  }

  const channel = await client.channels.fetch(channelId).catch(() => null);
  if (!channel || !channel.isTextBased()) {
    return { sent: false, reason: 'invalid_channel' };
  }

  const weeks = getWeekStartsInRange(normalizedRange.startDate, normalizedRange.endDate);
  const results = [];

  for (const weekStartDate of weeks) {
    results.push(await upsertWeeklyAvailabilityPrompt(channel, team?.id || 1, weekStartDate));
  }

  return {
    sent: true,
    mode: 'week_messages',
    requestedStartDate: rawStartDate,
    requestedEndDate: rawEndDate,
    normalizedStartDate: normalizedRange.startDate,
    normalizedEndDate: normalizedRange.endDate,
    weekCount: results.length,
    weeks: results
  };
}

function getWeeklyEntries(playerId, weekStartDate) {
  const weekEndDate = addDaysIso(weekStartDate, DAYS_PER_WEEK - 1);
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

function getEitherOrChoice(playerId, weekStartDate) {
  return db.prepare(`
    SELECT *
    FROM weekly_availability_choices
    WHERE player_id = ?
      AND week_start_date = ?
    LIMIT 1
  `).get(playerId, weekStartDate) || null;
}

function getEitherOrAssignedDates(playerId, teamId, firstDate, secondDate) {
  return db.prepare(`
    SELECT DISTINCT e.option_date
    FROM team_calendar_assignments a
    INNER JOIN team_calendar_events e ON e.id = a.event_id
    WHERE a.player_id = ?
      AND e.team_id = ?
      AND e.option_date IN (?, ?)
      AND e.status <> 'cancelled'
    ORDER BY e.option_date ASC
  `).all(playerId, teamId, firstDate, secondDate).map(row => row.option_date);
}

function setEitherOrChoice(playerId, actorDiscordUserId, weekStartDate, firstDate, secondDate) {
  const [dateA, dateB] = [firstDate, secondDate].sort();
  const now = new Date().toISOString();

  db.prepare(`
    INSERT INTO weekly_availability_choices (
      player_id,
      week_start_date,
      first_date,
      second_date,
      created_by_discord_user_id,
      created_at,
      updated_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(player_id, week_start_date)
    DO UPDATE SET
      first_date = excluded.first_date,
      second_date = excluded.second_date,
      created_by_discord_user_id = excluded.created_by_discord_user_id,
      updated_at = excluded.updated_at
  `).run(playerId, weekStartDate, dateA, dateB, actorDiscordUserId, now, now);

  return getEitherOrChoice(playerId, weekStartDate);
}

function clearEitherOrChoice(playerId, weekStartDate) {
  return db.prepare(`
    DELETE FROM weekly_availability_choices
    WHERE player_id = ?
      AND week_start_date = ?
  `).run(playerId, weekStartDate).changes > 0;
}

function clearEitherOrChoiceForDate(playerId, dateStr) {
  return db.prepare(`
    DELETE FROM weekly_availability_choices
    WHERE player_id = ?
      AND (first_date = ? OR second_date = ?)
  `).run(playerId, dateStr, dateStr).changes > 0;
}

function formatEitherOrDate(dateStr) {
  return `${getWeekdayShort(dateStr)}, ${formatDateShort(dateStr)}`;
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
  const weekEndDate = weekDates[weekDates.length - 1];
  const entries = getWeeklyEntries(player.id, weekStartDate);
  const choice = getEitherOrChoice(player.id, weekStartDate);
  const lines = weekDates.map(dateStr => {
    const dayEntries = getWeeklyEntriesForDate(entries, dateStr);
    const linked = choice && (choice.first_date === dateStr || choice.second_date === dateStr);
    return `${formatDayLine(dateStr, deriveStateFromEntries(dayEntries))}${linked ? ' 🔗' : ''}`;
  });
  const choiceText = choice
    ? `\n\n🔗 **Nur an einem dieser Tage einplanen:**\n${formatEitherOrDate(choice.first_date)} **oder** ${formatEitherOrDate(choice.second_date)}`
    : '';

  return new EmbedBuilder()
    .setTitle(`🗓️ Deine Woche – ${playerDisplay(player)}`)
    .setDescription(`**${formatDateDE(weekStartDate)} – ${formatDateDE(weekEndDate)}**\n\n${lines.join('\n')}${choiceText}`)
    .setFooter({ text: 'Tagesbutton = ✅/❌ · Zeitfenster = eingeschränkt · 🔗 = nur einer der verknüpften Tage' });
}

function buildEditorComponents(player, weekStartDate, options = {}) {
  const weekDates = getWeekDates(weekStartDate);
  const entries = getWeeklyEntries(player.id, weekStartDate);
  const choice = getEitherOrChoice(player.id, weekStartDate);
  const withTimeSelect = options.withTimeSelect === true;
  const withEitherOrSelect = options.withEitherOrSelect === true;

  const states = new Map(weekDates.map(dateStr => [
    dateStr,
    deriveStateFromEntries(getWeeklyEntriesForDate(entries, dateStr))
  ]));

  const dayButtons = weekDates.map(dateStr => {
    const state = states.get(dateStr);

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
  for (let index = 0; index < dayButtons.length; index += 5) {
    rows.push(new ActionRowBuilder().addComponents(dayButtons.slice(index, index + 5)));
  }

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
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId(`${PREFIX}:either:${weekStartDate}`)
      .setLabel(choice ? '🔗 Tage ändern' : '🔗 Entweder/oder')
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

  if (withEitherOrSelect) {
    const selectableDates = weekDates.filter(dateStr => states.get(dateStr).kind !== 'unavailable');

    if (selectableDates.length >= 2) {
      rows.push(new ActionRowBuilder().addComponents(
        new StringSelectMenuBuilder()
          .setCustomId(`${PREFIX}:eitherdays:${weekStartDate}`)
          .setPlaceholder('Genau zwei mögliche Tage auswählen')
          .setMinValues(2)
          .setMaxValues(2)
          .addOptions(selectableDates.map(dateStr => ({
            label: formatEitherOrDate(dateStr),
            value: dateStr,
            default: Boolean(choice && (choice.first_date === dateStr || choice.second_date === dateStr))
          })))
      ));
    }

    if (choice) {
      rows.push(new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId(`${PREFIX}:eitherclear:${weekStartDate}`)
          .setLabel('Verknüpfung löschen')
          .setStyle(ButtonStyle.Danger)
      ));
    }
  }

  return rows;
}

function buildEditorPayload(player, weekStartDate, options = {}) {
  return {
    content: options.notice || null,
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
  const before = deriveStateFromEntries(getWeeklyEntriesForDate(
    db.prepare(`
      SELECT * FROM availability_entries
      WHERE player_id = ? AND source = 'weekly_checkin'
        AND end_at >= ? AND start_at <= ?
      ORDER BY start_at ASC
    `).all(playerId, `${dateStr} 00:00`, `${dateStr} 23:59`),
    dateStr
  ));
  deleteWeeklyCheckinForDay(playerId, dateStr);
  if (state.kind !== 'available') {
    insertWeeklyCheckinEntries({ playerId, actorDiscordUserId, dateStr, state });
  }
  if (state.kind === 'unavailable') {
    clearEitherOrChoiceForDate(playerId, dateStr);
  }
  logLatePlannerChange(playerId, actorDiscordUserId, dateStr, before, state);
}

function berlinDateTime() {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Berlin', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
  }).formatToParts(new Date()).filter(part => part.type !== 'literal').map(part => [part.type, part.value]));
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}`;
}

function plannerCutoffFor(dateStr) {
  const [year, month, day] = dateStr.split('-').map(Number);
  const target = new Date(Date.UTC(year, month - 1, day));
  const weekday = target.getUTCDay() || 7;
  target.setUTCDate(target.getUTCDate() - weekday);
  return `${target.toISOString().slice(0, 10)} 20:00`;
}

function stateSummary(state) {
  if (state.kind === 'available') return 'verfügbar';
  if (state.kind === 'unavailable') return 'nicht verfügbar';
  if (state.kind === 'window') return `${state.from || '?'}–${state.until || '?'} verfügbar`;
  return 'teilweise verfügbar';
}

function logLatePlannerChange(playerId, actorDiscordUserId, dateStr, before, after) {
  if (berlinDateTime() < plannerCutoffFor(dateStr) || JSON.stringify(before) === JSON.stringify(after)) return;
  const player = db.prepare(`SELECT id, team_id, alias, global_name, username FROM players WHERE id = ?`).get(playerId);
  if (!player) return;
  const name = player.alias || player.global_name || player.username || `Spieler #${player.id}`;
  db.prepare(`
    INSERT INTO planner_change_log (
      team_id, player_id, change_type, summary, details_json,
      actor_discord_user_id, created_at
    ) VALUES (?, ?, 'late_availability', ?, ?, ?, ?)
  `).run(
    player.team_id,
    playerId,
    `${name}: ${dateStr} nach Planungsbeginn auf „${stateSummary(after)}“ geändert`,
    JSON.stringify({ date: dateStr, before, after }),
    actorDiscordUserId,
    new Date().toISOString()
  );
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
  const weekEndDate = addDaysIso(weekStartDate, DAYS_PER_WEEK - 1);
  db.prepare(`
    DELETE FROM availability_entries
    WHERE player_id = ?
      AND source = 'weekly_checkin'
      AND start_at >= ?
      AND start_at <= ?
  `).run(playerId, `${weekStartDate} 00:00`, `${weekEndDate} 23:59`);
  clearEitherOrChoice(playerId, weekStartDate);
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
  const player = upsertPlayer(interaction.user, { team_id: resolveTeamForInteraction(interaction)?.id });
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

function buildRangeResultMessage(result) {
  if (!result.sent) {
    if (result.reason === 'range_too_large') {
      return `Der Zeitraum ist zu groß. Bitte maximal ${result.maxRangeDays} Tage wählen.`;
    }
    if (result.reason === 'missing_channel_id') {
      return 'WEEKLY_AVAILABILITY_CHANNEL_ID fehlt in der .env.';
    }
    if (result.reason === 'invalid_channel') {
      return 'Der Wochenkarten-Channel konnte nicht gefunden werden oder ist kein Textkanal.';
    }
    return `Wochenkarten konnten nicht erstellt werden: ${result.reason || 'unbekannter Fehler'}`;
  }

  const weekLines = result.weeks.map(week => {
    const modeLabel = week.mode === 'updated' ? 'überschrieben' : 'erstellt';
    return `- ${formatDateDE(week.weekStartDate)} – ${formatDateDE(week.weekEndDate)}: ${modeLabel}`;
  });

  return (
    `Wochenkarten aktualisiert.\n` +
    `Zeitraum: **${formatDateDE(result.normalizedStartDate)} – ${formatDateDE(result.normalizedEndDate)}**\n` +
    `Wochen-Nachrichten: **${result.weekCount}**\n\n` +
    weekLines.join('\n')
  );
}

async function handleRangeModalSubmit(interaction, teamId) {
  if (!(await requireAdmin(interaction))) return true;

  const startDate = parseDateInput(interaction.fields.getTextInputValue('start_date'));
  const endDate = parseDateInput(interaction.fields.getTextInputValue('end_date'));

  if (!startDate || !endDate) {
    await interaction.reply({
      content: 'Bitte gib gültige Datumswerte ein, z. B. `11.05.2026` oder `2026-05-11`.',
      flags: MessageFlags.Ephemeral
    });
    return true;
  }

  if (endDate < startDate) {
    await interaction.reply({
      content: 'Das Bis-Datum darf nicht vor dem Von-Datum liegen.',
      flags: MessageFlags.Ephemeral
    });
    return true;
  }

  const result = await publishWeeklyAvailabilityPrompt(interaction.client, { startDate, endDate, teamId });
  await interaction.reply({
    content: buildRangeResultMessage(result),
    flags: MessageFlags.Ephemeral
  });
  return true;
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
      const player = upsertPlayer(interaction.user, { team_id: resolveTeamForInteraction(interaction)?.id });
      toggleDayState(player, interaction.user.id, dateStr, weekStartDate);
      await openEditor(interaction, weekStartDate);
      schedulePlannerRefresh(interaction.client, player.team_id, [dateStr]);
      return true;
    }

    if (action === 'allyes') {
      const player = upsertPlayer(interaction.user, { team_id: resolveTeamForInteraction(interaction)?.id });
      resetWeek(player.id, weekStartDate);
      await openEditor(interaction, weekStartDate);
      schedulePlannerRefresh(interaction.client, player.team_id, getWeekDates(weekStartDate));
      return true;
    }

    if (action === 'allno') {
      const player = upsertPlayer(interaction.user, { team_id: resolveTeamForInteraction(interaction)?.id });
      setAllDays(player.id, interaction.user.id, weekStartDate, { kind: 'unavailable' });
      await openEditor(interaction, weekStartDate);
      schedulePlannerRefresh(interaction.client, player.team_id, getWeekDates(weekStartDate));
      return true;
    }

    if (action === 'reset') {
      const player = upsertPlayer(interaction.user, { team_id: resolveTeamForInteraction(interaction)?.id });
      resetWeek(player.id, weekStartDate);
      await openEditor(interaction, weekStartDate);
      schedulePlannerRefresh(interaction.client, player.team_id, getWeekDates(weekStartDate));
      return true;
    }

    if (action === 'time') {
      await openEditor(interaction, weekStartDate, { withTimeSelect: true });
      return true;
    }

    if (action === 'either') {
      const player = upsertPlayer(interaction.user, { team_id: resolveTeamForInteraction(interaction)?.id });
      const entries = getWeeklyEntries(player.id, weekStartDate);
      const selectableDates = getWeekDates(weekStartDate).filter(dateStr =>
        deriveStateFromEntries(getWeeklyEntriesForDate(entries, dateStr)).kind !== 'unavailable'
      );

      if (selectableDates.length < 2) {
        await interaction.update(buildEditorPayload(player, weekStartDate, {
          notice: 'Markiere zuerst mindestens zwei Tage als verfügbar oder zeitlich eingeschränkt.'
        }));
        return true;
      }

      await interaction.update(buildEditorPayload(player, weekStartDate, { withEitherOrSelect: true }));
      return true;
    }

    if (action === 'eitherclear') {
      const player = upsertPlayer(interaction.user, { team_id: resolveTeamForInteraction(interaction)?.id });
      const previous = getEitherOrChoice(player.id, weekStartDate);
      clearEitherOrChoice(player.id, weekStartDate);
      await interaction.update(buildEditorPayload(player, weekStartDate, {
        notice: 'Die Entweder-oder-Verknüpfung wurde gelöscht.'
      }));
      if (previous) {
        schedulePlannerRefresh(interaction.client, player.team_id, [previous.first_date, previous.second_date]);
      }
      return true;
    }
  }

  if (interaction.isStringSelectMenu()) {
    if (action === 'timeday') {
      const dateStr = interaction.values[0];
      await interaction.showModal(buildTimeWindowModal(weekStartDate, dateStr));
      return true;
    }

    if (action === 'eitherdays') {
      const player = upsertPlayer(interaction.user, { team_id: resolveTeamForInteraction(interaction)?.id });
      const selectedDates = [...new Set(interaction.values)].sort();
      const weekDates = new Set(getWeekDates(weekStartDate));
      const entries = getWeeklyEntries(player.id, weekStartDate);
      const validSelection =
        selectedDates.length === 2 &&
        selectedDates.every(dateStr =>
          weekDates.has(dateStr) &&
          deriveStateFromEntries(getWeeklyEntriesForDate(entries, dateStr)).kind !== 'unavailable'
        );

      if (!validSelection) {
        await interaction.update(buildEditorPayload(player, weekStartDate, {
          notice: 'Bitte wähle genau zwei verfügbare Tage aus.',
          withEitherOrSelect: true
        }));
        return true;
      }

      const assignedDates = getEitherOrAssignedDates(
        player.id,
        player.team_id,
        selectedDates[0],
        selectedDates[1]
      );
      if (assignedDates.length > 1) {
        await interaction.update(buildEditorPayload(player, weekStartDate, {
          notice:
            'Diese Verknüpfung kann nicht gespeichert werden, weil du bereits an beiden Tagen im Line-up stehst. ' +
            'Bitte kläre zuerst mit einem Admin, an welchem Termin du nicht eingeplant wirst.',
          withEitherOrSelect: true
        }));
        return true;
      }

      const previous = getEitherOrChoice(player.id, weekStartDate);
      const saved = setEitherOrChoice(
        player.id,
        interaction.user.id,
        weekStartDate,
        selectedDates[0],
        selectedDates[1]
      );

      await interaction.update(buildEditorPayload(player, weekStartDate, {
        notice: `Gespeichert: Du wirst nur an **${formatEitherOrDate(saved.first_date)} oder ${formatEitherOrDate(saved.second_date)}** eingeplant.`
      }));

      const refreshDates = new Set([saved.first_date, saved.second_date]);
      if (previous) {
        refreshDates.add(previous.first_date);
        refreshDates.add(previous.second_date);
      }
      schedulePlannerRefresh(interaction.client, player.team_id, [...refreshDates]);
      return true;
    }
  }

  if (interaction.isModalSubmit()) {
    if (action === 'rangemodal') {
      return handleRangeModalSubmit(interaction, Number(parts[2]) || resolveTeamForInteraction(interaction)?.id);
    }

    if (action === 'timemodal') {
      const dateStr = parts[3];
      const from = interaction.fields.getTextInputValue('available_from').trim();
      const until = interaction.fields.getTextInputValue('available_until').trim();
      const player = upsertPlayer(interaction.user, { team_id: resolveTeamForInteraction(interaction)?.id });
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
      schedulePlannerRefresh(interaction.client, player.team_id, [dateStr]);
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
  DAYS_PER_WEEK,
  buildAvailabilityRangeModal,
  publishWeeklyAvailabilityPrompt,
  canHandleInteraction,
  handleInteraction,
  parseDateInput,
  normalizeRangeToFullWeeks,
  formatDateDE
};
