const { SlashCommandBuilder } = require('discord.js');
const db = require('../db/database');

function isValidTime(value) {
  if (!/^\d{2}:\d{2}$/.test(value)) return false;

  const [hours, minutes] = value.split(':').map(Number);
  return hours >= 0 && hours <= 23 && minutes >= 0 && minutes <= 59;
}

function isValidIsoDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;

  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));

  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
  );
}

function parseDateInput(value) {
  if (!value) return null;

  const trimmed = value.trim();

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

function parseTimeToMinutes(timeStr) {
  const [hours, minutes] = timeStr.split(':').map(Number);
  return hours * 60 + minutes;
}

function minutesToTime(minutes) {
  const hours = String(Math.floor(minutes / 60)).padStart(2, '0');
  const mins = String(minutes % 60).padStart(2, '0');
  return `${hours}:${mins}`;
}

function addMinutesToTime(timeStr, minutesToAdd) {
  return minutesToTime(parseTimeToMinutes(timeStr) + minutesToAdd);
}

function formatDateDE(dateStr) {
  const [year, month, day] = dateStr.split('-');
  return `${day}.${month}.${year}`;
}

function formatDateTimeDE(dateTime) {
  if (!dateTime) return '-';
  const [dateStr, timeStr] = dateTime.split(' ');
  return `${formatDateDE(dateStr)}, ${timeStr}`;
}

function formatDateLongDE(dateStr) {
  const [year, month, day] = dateStr.split('-').map(Number);
  return new Intl.DateTimeFormat('de-DE', {
    timeZone: 'UTC',
    weekday: 'long',
    day: '2-digit',
    month: '2-digit',
    year: 'numeric'
  }).format(new Date(Date.UTC(year, month - 1, day)));
}

function statusLabel(status) {
  switch (status) {
    case 'fixed':
      return 'Fixed';
    case 'cancelled':
      return 'Cancelled';
    default:
      return 'Pending';
  }
}

function eventTypeLabel(type) {
  switch (type) {
    case 'primeleague':
      return 'Prime League';
    case 'scrim':
      return 'Scrim';
    default:
      return 'Sonstiges';
  }
}

function buildLineupText(assignments) {
  if (!assignments.length) return '-';

  const order = ['Top', 'Jgl', 'Mid', 'ADC', 'Supp', 'Sub1', 'Sub2'];
  const rank = new Map(order.map((label, index) => [label, index]));

  return assignments
    .sort((a, b) => {
      const aRank = rank.has(a.role_label) ? rank.get(a.role_label) : 999;
      const bRank = rank.has(b.role_label) ? rank.get(b.role_label) : 999;
      return aRank - bRank || a.role_label.localeCompare(b.role_label, 'de');
    })
    .map(item => `${item.role_label}: ${item.player_label}`)
    .join(' | ');
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName('spieltermin')
    .setDescription('Verwalte den Spielerkalender.')
    .addSubcommand(sub =>
      sub
        .setName('anzeigen')
        .setDescription('Zeigt die nächsten Spieltermine an.')
    )
    .addSubcommand(sub =>
      sub
        .setName('bearbeiten')
        .setDescription('Bearbeitet einen Kalendereintrag anhand der ID.')
        .addIntegerOption(option =>
          option
            .setName('id')
            .setDescription('Kalender-ID aus dem Planner oder aus /spieltermin anzeigen')
            .setRequired(true)
        )
        .addStringOption(option =>
          option
            .setName('datum')
            .setDescription('Optional: neues Datum, TT.MM.JJJJ oder YYYY-MM-DD')
            .setRequired(false)
        )
        .addStringOption(option =>
          option
            .setName('startzeit')
            .setDescription('Optional: exakte Startzeit im Format HH:MM')
            .setRequired(false)
        )
        .addStringOption(option =>
          option
            .setName('titel')
            .setDescription('Optional: neuer Titel')
            .setRequired(false)
        )
        .addStringOption(option =>
          option
            .setName('typ')
            .setDescription('Optional: neuer Typ')
            .setRequired(false)
            .addChoices(
              { name: 'Scrim', value: 'scrim' },
              { name: 'Prime League', value: 'primeleague' },
              { name: 'Sonstiges', value: 'other' }
            )
        )
        .addStringOption(option =>
          option
            .setName('status')
            .setDescription('Optional: neuer Status')
            .setRequired(false)
            .addChoices(
              { name: 'Pending', value: 'pending' },
              { name: 'Fixed', value: 'fixed' },
              { name: 'Cancelled', value: 'cancelled' }
            )
        )
        .addStringOption(option =>
          option
            .setName('hinweis')
            .setDescription('Optional: Hinweistext, mit "-" wird gelöscht')
            .setRequired(false)
        )
        .addStringOption(option =>
          option
            .setName('opgg')
            .setDescription('Optional: OPGG-Link, mit "-" wird gelöscht')
            .setRequired(false)
        )
    )
    .addSubcommand(sub =>
      sub
        .setName('lineup')
        .setDescription('Setzt die flexible Rollenverteilung für einen Termin.')
        .addIntegerOption(option =>
          option
            .setName('id')
            .setDescription('Kalender-ID')
            .setRequired(true)
        )
        .addStringOption(option => option.setName('top').setDescription('Spieler für Top').setRequired(false))
        .addStringOption(option => option.setName('jgl').setDescription('Spieler für Jungle').setRequired(false))
        .addStringOption(option => option.setName('mid').setDescription('Spieler für Mid').setRequired(false))
        .addStringOption(option => option.setName('adc').setDescription('Spieler für ADC').setRequired(false))
        .addStringOption(option => option.setName('supp').setDescription('Spieler für Support').setRequired(false))
        .addStringOption(option => option.setName('sub1').setDescription('Optional: erster Ersatz').setRequired(false))
        .addStringOption(option => option.setName('sub2').setDescription('Optional: zweiter Ersatz').setRequired(false))
    ),

  async execute(interaction) {
    const subcommand = interaction.options.getSubcommand();

    if (subcommand === 'anzeigen') {
      const today = new Date().toISOString().slice(0, 10);

      const events = db.prepare(`
        SELECT *
        FROM team_calendar_events
        WHERE option_date >= ?
        ORDER BY option_date ASC, COALESCE(scheduled_start_at, window_start_at) ASC
        LIMIT 20
      `).all(today);

      if (events.length === 0) {
        return interaction.reply({
          content: 'Im Spielerkalender sind aktuell keine Termine gespeichert.',
          ephemeral: true
        });
      }

      const lines = [];

      for (const event of events) {
        const assignments = db.prepare(`
          SELECT role_label, player_label
          FROM team_calendar_assignments
          WHERE event_id = ?
          ORDER BY role_label ASC
        `).all(event.id);

        const exactTime =
          event.scheduled_start_at && event.scheduled_end_at
            ? `${formatDateTimeDE(event.scheduled_start_at)} → ${formatDateTimeDE(event.scheduled_end_at)}`
            : '-';

        lines.push(
          `**#${event.id}** • [${statusLabel(event.status)}] ${event.title}\n` +
          `Tag: **${formatDateLongDE(event.option_date)}**\n` +
          `Fenster: **${formatDateTimeDE(event.window_start_at)} → ${formatDateTimeDE(event.window_end_at)}**\n` +
          `Fixe Zeit: **${exactTime}**\n` +
          `Typ: **${eventTypeLabel(event.event_type)}**\n` +
          `Verfügbare Spieler: **${event.available_players_text ?? '-'}**\n` +
          `Lineup: **${buildLineupText(assignments)}**\n` +
          `OPGG: **${event.opgg_url ?? '-'}**\n` +
          `Hinweis: **${event.note ?? '-'}**`
        );
      }

      return interaction.reply({
        content: lines.join('\n\n'),
        ephemeral: true
      });
    }

    if (subcommand === 'bearbeiten') {
      const id = interaction.options.getInteger('id', true);
      const datumInput = interaction.options.getString('datum');
      const startzeit = interaction.options.getString('startzeit');
      const titel = interaction.options.getString('titel');
      const typ = interaction.options.getString('typ');
      const status = interaction.options.getString('status');
      const hinweis = interaction.options.getString('hinweis');
      const opgg = interaction.options.getString('opgg');

      const event = db.prepare(`
        SELECT *
        FROM team_calendar_events
        WHERE id = ?
      `).get(id);

      if (!event) {
        return interaction.reply({
          content: 'Ich habe keinen Kalendereintrag mit dieser ID gefunden.',
          ephemeral: true
        });
      }

      const parsedDate = datumInput ? parseDateInput(datumInput) : event.option_date;
      if (datumInput && !parsedDate) {
        return interaction.reply({
          content: 'Datum ungültig. Nutze TT.MM.JJJJ oder YYYY-MM-DD.',
          ephemeral: true
        });
      }

      if (startzeit && !isValidTime(startzeit)) {
        return interaction.reply({
          content: 'Startzeit ungültig. Bitte nutze HH:MM, z. B. 18:30.',
          ephemeral: true
        });
      }

      const nextTitle = titel?.trim() || event.title;
      const nextType = typ ?? event.event_type;
      const nextStatus = status ?? event.status;
      const nextDate = parsedDate;

      let nextWindowStartAt = event.window_start_at;
      let nextWindowEndAt = event.window_end_at;
      let nextScheduledStartAt = event.scheduled_start_at;
      let nextScheduledEndAt = event.scheduled_end_at;
      let nextMeetingScrimAt = event.meeting_scrim_at;
      let nextMeetingPrimeleagueAt = event.meeting_primeleague_at;

      if (datumInput) {
        const oldWindowStartTime = event.window_start_at.slice(11, 16);
        const oldWindowEndTime = event.window_end_at.slice(11, 16);
        nextWindowStartAt = `${nextDate} ${oldWindowStartTime}`;
        nextWindowEndAt = `${nextDate} ${oldWindowEndTime}`;

        if (event.scheduled_start_at && event.scheduled_end_at) {
          const oldStartTime = event.scheduled_start_at.slice(11, 16);
          const oldEndTime = event.scheduled_end_at.slice(11, 16);
          nextScheduledStartAt = `${nextDate} ${oldStartTime}`;
          nextScheduledEndAt = `${nextDate} ${oldEndTime}`;
          nextMeetingScrimAt = `${nextDate} ${addMinutesToTime(oldStartTime, -15)}`;
          nextMeetingPrimeleagueAt = `${nextDate} ${addMinutesToTime(oldStartTime, -30)}`;
        }
      }

      if (startzeit) {
        const endzeit = addMinutesToTime(startzeit, 150);
        nextScheduledStartAt = `${nextDate} ${startzeit}`;
        nextScheduledEndAt = `${nextDate} ${endzeit}`;
        nextMeetingScrimAt = `${nextDate} ${addMinutesToTime(startzeit, -15)}`;
        nextMeetingPrimeleagueAt = `${nextDate} ${addMinutesToTime(startzeit, -30)}`;
      }

      const nextHint =
        hinweis === null
          ? event.note
          : (hinweis.trim() === '-' ? null : hinweis.trim());

      const nextOpgg =
        opgg === null
          ? event.opgg_url
          : (opgg.trim() === '-' ? null : opgg.trim());

      db.prepare(`
        UPDATE team_calendar_events
        SET title = ?,
            event_type = ?,
            status = ?,
            option_date = ?,
            window_start_at = ?,
            window_end_at = ?,
            scheduled_start_at = ?,
            scheduled_end_at = ?,
            meeting_scrim_at = ?,
            meeting_primeleague_at = ?,
            note = ?,
            opgg_url = ?,
            updated_by_discord_user_id = ?,
            updated_at = ?
        WHERE id = ?
      `).run(
        nextTitle,
        nextType,
        nextStatus,
        nextDate,
        nextWindowStartAt,
        nextWindowEndAt,
        nextScheduledStartAt,
        nextScheduledEndAt,
        nextMeetingScrimAt,
        nextMeetingPrimeleagueAt,
        nextHint,
        nextOpgg,
        interaction.user.id,
        new Date().toISOString(),
        id
      );

      return interaction.reply({
        content:
          `Spieltermin **#${id}** wurde aktualisiert.\n` +
          `Titel: **${nextTitle}**\n` +
          `Status: **${statusLabel(nextStatus)}**\n` +
          `Typ: **${eventTypeLabel(nextType)}**\n` +
          `Fenster: **${formatDateTimeDE(nextWindowStartAt)} → ${formatDateTimeDE(nextWindowEndAt)}**\n` +
          `Fixe Zeit: **${nextScheduledStartAt ? `${formatDateTimeDE(nextScheduledStartAt)} → ${formatDateTimeDE(nextScheduledEndAt)}` : '-'}**\n` +
          `OPGG: **${nextOpgg ?? '-'}**\n` +
          `Hinweis: **${nextHint ?? '-'}**`,
        ephemeral: true
      });
    }

    if (subcommand === 'lineup') {
      const id = interaction.options.getInteger('id', true);

      const event = db.prepare(`
        SELECT id
        FROM team_calendar_events
        WHERE id = ?
      `).get(id);

      if (!event) {
        return interaction.reply({
          content: 'Ich habe keinen Kalendereintrag mit dieser ID gefunden.',
          ephemeral: true
        });
      }

      const roleMap = {
        Top: interaction.options.getString('top'),
        Jgl: interaction.options.getString('jgl'),
        Mid: interaction.options.getString('mid'),
        ADC: interaction.options.getString('adc'),
        Supp: interaction.options.getString('supp'),
        Sub1: interaction.options.getString('sub1'),
        Sub2: interaction.options.getString('sub2')
      };

      const now = new Date().toISOString();
      let changed = 0;

      for (const [roleLabel, value] of Object.entries(roleMap)) {
        if (value === null) continue;

        const trimmed = value.trim();

        if (trimmed === '-' || trimmed === '') {
          db.prepare(`
            DELETE FROM team_calendar_assignments
            WHERE event_id = ?
              AND role_label = ?
          `).run(id, roleLabel);
          changed++;
          continue;
        }

        db.prepare(`
          INSERT INTO team_calendar_assignments (
            event_id,
            role_label,
            player_label,
            note,
            created_at,
            updated_at
          )
          VALUES (?, ?, ?, NULL, ?, ?)
          ON CONFLICT(event_id, role_label)
          DO UPDATE SET
            player_label = excluded.player_label,
            updated_at = excluded.updated_at
        `).run(id, roleLabel, trimmed, now, now);
        changed++;
      }

      const assignments = db.prepare(`
        SELECT role_label, player_label
        FROM team_calendar_assignments
        WHERE event_id = ?
        ORDER BY role_label ASC
      `).all(id);

      return interaction.reply({
        content:
          (changed === 0
            ? 'Es wurden keine Rollen geändert.\n'
            : `Lineup für **#${id}** wurde aktualisiert.\n`) +
          `Aktuell: **${buildLineupText(assignments)}**`,
        ephemeral: true
      });
    }
  }
};