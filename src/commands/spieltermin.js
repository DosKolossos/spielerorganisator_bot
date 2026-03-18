const {
  SlashCommandBuilder,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  StringSelectMenuBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  MessageFlags
} = require('discord.js');
const db = require('../db/database');
const { isAdminInteraction } = require('../utils/permissions');

const ROLE_ORDER = ['Top', 'Jgl', 'Mid', 'ADC', 'Supp', 'Sub1', 'Sub2'];
const STATUS_VALUES = ['pending', 'fixed', 'cancelled'];
const EVENT_TYPE_VALUES = ['open', 'scrim', 'primeleague', 'other'];

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

function statusEmoji(status) {
  switch (status) {
    case 'fixed':
      return '🟢';
    case 'cancelled':
      return '🔴';
    default:
      return '🟡';
  }
}

function statusColor(status) {
  switch (status) {
    case 'fixed':
      return 0x57f287;
    case 'cancelled':
      return 0xed4245;
    default:
      return 0xfee75c;
  }
}

function eventTypeLabel(type) {
  switch (type) {
    case 'open':
      return 'Offen / Noch unklar';
    case 'primeleague':
      return 'Prime League';
    case 'scrim':
      return 'Scrim';
    default:
      return 'Sonstiges';
  }
}

function getMeetingOffsetMinutes(type) {
  switch (type) {
    case 'scrim':
      return -15;
    case 'primeleague':
      return -30;
    default:
      return null;
  }
}

function getDurationMinutesFromDateTimes(startAt, endAt) {
  if (!startAt || !endAt) return 150;

  const startMinutes = parseTimeToMinutes(startAt.slice(11, 16));
  const endMinutes = parseTimeToMinutes(endAt.slice(11, 16));
  const diff = endMinutes - startMinutes;

  return diff > 0 ? diff : 150;
}

function getDefaultMeetingAtFromScheduledStart(scheduledStartAt, type) {
  if (!scheduledStartAt) return null;

  const offset = getMeetingOffsetMinutes(type);
  if (offset === null) return null;

  const dateStr = scheduledStartAt.slice(0, 10);
  const startTime = scheduledStartAt.slice(11, 16);

  return `${dateStr} ${addMinutesToTime(startTime, offset)}`;
}

function getEffectiveMeetingAt(event, type) {
  if (type === 'scrim') {
    return event.meeting_scrim_at || getDefaultMeetingAtFromScheduledStart(event.scheduled_start_at, 'scrim');
  }

  if (type === 'primeleague') {
    return event.meeting_primeleague_at || getDefaultMeetingAtFromScheduledStart(event.scheduled_start_at, 'primeleague');
  }

  return null;
}

function buildMeetingFieldValue(event) {
  if (!event.scheduled_start_at) {
    return '-';
  }

  if (event.event_type === 'scrim') {
    return formatDateTimeDE(getEffectiveMeetingAt(event, 'scrim'));
  }

  if (event.event_type === 'primeleague') {
    return formatDateTimeDE(getEffectiveMeetingAt(event, 'primeleague'));
  }

  const scrimMeeting = formatDateTimeDE(getEffectiveMeetingAt(event, 'scrim'));
  const primeMeeting = formatDateTimeDE(getEffectiveMeetingAt(event, 'primeleague'));

  return `Scrim: ${scrimMeeting}\nPrime League: ${primeMeeting}`;
}

function reconcileMeetingAfterScheduleChange(currentMeetingAt, previousScheduledStartAt, nextScheduledStartAt, type) {
  if (!nextScheduledStartAt) return null;

  const newDefault = getDefaultMeetingAtFromScheduledStart(nextScheduledStartAt, type);
  if (!currentMeetingAt) return newDefault;

  const oldDefault = previousScheduledStartAt
    ? getDefaultMeetingAtFromScheduledStart(previousScheduledStartAt, type)
    : null;

  if (!oldDefault || currentMeetingAt === oldDefault) {
    return newDefault;
  }

  const nextDate = nextScheduledStartAt.slice(0, 10);
  const currentTime = currentMeetingAt.slice(11, 16);

  return `${nextDate} ${currentTime}`;
}

function playerDisplay(row) {
  return row.alias || row.global_name || row.username || row.discord_user_id;
}

function truncateField(value, maxLength = 1000) {
  if (!value) return '-';
  return value.length > maxLength ? `${value.slice(0, maxLength - 1)}…` : value;
}

function buildLineupText(assignments) {
  if (!assignments.length) return '-';

  const rank = new Map(ROLE_ORDER.map((label, index) => [label, index]));

  return assignments
    .slice()
    .sort((a, b) => {
      const aRank = rank.has(a.role_label) ? rank.get(a.role_label) : 999;
      const bRank = rank.has(b.role_label) ? rank.get(b.role_label) : 999;
      return aRank - bRank || a.role_label.localeCompare(b.role_label, 'de');
    })
    .map(item => `${item.role_label}: ${item.player_label}`)
    .join(' | ');
}

function findPlayerByLabel(label) {
  if (!label) return null;
  const trimmed = label.trim();
  if (!trimmed) return null;

  const players = db.prepare(`
    SELECT *
    FROM players
    WHERE is_archived = 0
    ORDER BY id ASC
  `).all();

  const lower = trimmed.toLowerCase();

  return (
    players.find(player => player.alias && player.alias.trim().toLowerCase() === lower) ||
    players.find(player => player.global_name && player.global_name.trim().toLowerCase() === lower) ||
    players.find(player => player.username && player.username.trim().toLowerCase() === lower) ||
    players.find(player => player.discord_user_id === trimmed) ||
    null
  );
}

function getEventById(id) {
  return db.prepare(`
    SELECT *
    FROM team_calendar_events
    WHERE id = ?
  `).get(id);
}

function getAssignments(eventId) {
  return db.prepare(`
    SELECT
      a.id,
      a.event_id,
      a.role_label,
      a.player_label,
      a.player_id,
      p.discord_user_id,
      p.username,
      p.global_name,
      p.alias,
      p.riot_game_name,
      p.riot_tag,
      p.riot_region
    FROM team_calendar_assignments a
    LEFT JOIN players p ON p.id = a.player_id
    WHERE a.event_id = ?
    ORDER BY a.role_label ASC
  `).all(eventId);
}

function getRoleAssignment(eventId, roleLabel) {
  return db.prepare(`
    SELECT *
    FROM team_calendar_assignments
    WHERE event_id = ? AND role_label = ?
  `).get(eventId, roleLabel);
}

function buildOpggMultisearchUrl(summoners, region) {
  const normalizedRegion = (region || 'euw').toLowerCase();
  const query = encodeURIComponent(summoners.join(','));
  return `https://op.gg/lol/multisearch/${normalizedRegion}?summoners=${query}`;
}

function buildTeamOpggInfo(assignments) {
  const relevantAssignments = assignments.filter(item => ROLE_ORDER.includes(item.role_label));
  if (!relevantAssignments.length) {
    return { ok: false, message: 'Kein Lineup gesetzt.' };
  }

  const missingPlayers = [];
  const regions = new Set();
  const summoners = [];

  for (const item of relevantAssignments) {
    if (!item.player_id) {
      missingPlayers.push(`${item.role_label}: ${item.player_label} (nicht mit Profil verknüpft)`);
      continue;
    }

    if (!item.riot_game_name || !item.riot_tag) {
      missingPlayers.push(`${item.role_label}: ${item.player_label} (Riot-ID fehlt)`);
      continue;
    }

    regions.add((item.riot_region || 'euw').toLowerCase());
    summoners.push(`${item.riot_game_name}#${item.riot_tag}`);
  }

  if (missingPlayers.length) {
    return {
      ok: false,
      message: `Fehlende Riot-Daten: ${missingPlayers.join(' | ')}`
    };
  }

  if (regions.size > 1) {
    return {
      ok: false,
      message: `Mehrere Regionen im Lineup: ${[...regions].map(x => x.toUpperCase()).join(', ')}`
    };
  }

  return {
    ok: true,
    region: [...regions][0] || 'euw',
    summoners,
    url: buildOpggMultisearchUrl(summoners, [...regions][0] || 'euw')
  };
}

function buildDateTime(dateStr, timeStr) {
  return `${dateStr} ${timeStr}`;
}

function overlaps(startA, endA, startB, endB) {
  return startA < endB && startB < endA;
}

function getWeekdayIndexFromIsoDate(dateStr) {
  const [year, month, day] = dateStr.split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, day)).getUTCDay();
}

function getWeekdayBitFromIsoDate(dateStr) {
  const bits = [1, 2, 4, 8, 16, 32, 64];
  return bits[getWeekdayIndexFromIsoDate(dateStr)];
}

function startOfWeekMonday(dateStr) {
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

function daysBetweenIso(startDate, endDate) {
  const [sy, sm, sd] = startDate.split('-').map(Number);
  const [ey, em, ed] = endDate.split('-').map(Number);

  const start = Date.UTC(sy, sm - 1, sd);
  const end = Date.UTC(ey, em - 1, ed);

  return Math.floor((end - start) / (1000 * 60 * 60 * 24));
}

function weeksBetweenAnchorWeeks(anchorDate, targetDate) {
  const anchorWeekStart = startOfWeekMonday(anchorDate);
  const targetWeekStart = startOfWeekMonday(targetDate);
  return Math.floor(daysBetweenIso(anchorWeekStart, targetWeekStart) / 7);
}

function matchesRuleOnDate(rule, dateStr) {
  const recurrenceType = rule.recurrence_type ?? 'weekly';
  const anchorDate = rule.anchor_date ?? dateStr;

  if (dateStr < anchorDate) {
    return false;
  }

  switch (recurrenceType) {
    case 'weekly':
      return (rule.weekday_mask & getWeekdayBitFromIsoDate(dateStr)) !== 0;

    case 'biweekly': {
      if ((rule.weekday_mask & getWeekdayBitFromIsoDate(dateStr)) === 0) {
        return false;
      }

      const weekDiff = weeksBetweenAnchorWeeks(anchorDate, dateStr);
      return weekDiff >= 0 && weekDiff % 2 === 0;
    }

    case 'monthly':
      return Number(dateStr.slice(8, 10)) === Number(anchorDate.slice(8, 10));

    case 'yearly':
      return dateStr.slice(5, 10) === anchorDate.slice(5, 10);

    default:
      return false;
  }
}

function getRuleBlockedIntervalsForDate(rule, dateStr) {
  if (!matchesRuleOnDate(rule, dateStr)) {
    return [];
  }

  if (rule.suspended_from && dateStr >= rule.suspended_from && (!rule.suspended_until || dateStr <= rule.suspended_until)) {
    return [];
  }

  if (rule.rule_type === 'nicht_verfuegbar') {
    return [{ start_at: `${dateStr} 00:00`, end_at: `${dateStr} 23:59` }];
  }

  if (rule.rule_type === 'erst_ab' && rule.time_value) {
    return [{ start_at: `${dateStr} 00:00`, end_at: `${dateStr} ${rule.time_value}` }];
  }

  if (rule.rule_type === 'bis' && rule.time_value) {
    return [{ start_at: `${dateStr} ${rule.time_value}`, end_at: `${dateStr} 23:59` }];
  }

  return [];
}

function formatEntryRange(startAt, endAt) {
  const startDate = startAt.slice(0, 10);
  const endDate = endAt.slice(0, 10);
  const startTime = startAt.slice(11, 16);
  const endTime = endAt.slice(11, 16);
  const isAllDay = startTime === '00:00' && endTime === '23:59';

  if (isAllDay && startDate === endDate) {
    return `${formatDateDE(startDate)} (ganztägig)`;
  }

  if (isAllDay) {
    return `${formatDateDE(startDate)} → ${formatDateDE(endDate)} (ganztägig)`;
  }

  return `${formatDateTimeDE(startAt)} → ${formatDateTimeDE(endAt)}`;
}

function recurringDetail(rule) {
  if (rule.rule_type === 'nicht_verfuegbar') return 'ganztägig nicht verfügbar';
  if (rule.rule_type === 'erst_ab') return `bis ${rule.time_value} nicht verfügbar`;
  if (rule.rule_type === 'bis') return `ab ${rule.time_value} nicht verfügbar`;
  return rule.rule_type;
}

function getAvailabilitySnapshot(dateStr, startTime, durationMinutes) {
  const players = db.prepare(`
    SELECT id, discord_user_id, username, global_name, alias
    FROM players
    WHERE is_archived = 0
    ORDER BY COALESCE(alias, global_name, username) COLLATE NOCASE ASC
  `).all();

  const slotStartAt = buildDateTime(dateStr, startTime);
  const slotEndAt = buildDateTime(dateStr, addMinutesToTime(startTime, durationMinutes));

  const entries = db.prepare(`
    SELECT
      e.id,
      e.player_id,
      e.entry_type,
      e.start_at,
      e.end_at,
      e.reason,
      e.approval_status
    FROM availability_entries e
    WHERE e.end_at >= ?
      AND e.start_at <= ?
      AND e.approval_status <> 'rejected'
    ORDER BY e.start_at ASC
  `).all(slotStartAt, slotEndAt);

  const rules = db.prepare(`
    SELECT
      r.id,
      r.player_id,
      r.weekday_mask,
      r.rule_type,
      r.time_value,
      r.note,
      r.recurrence_type,
      r.anchor_date,
      r.active,
      r.suspended_from,
      r.suspended_until
    FROM availability_rules r
    WHERE r.active = 1
    ORDER BY r.player_id ASC, r.id ASC
  `).all();

  const available = [];
  const unavailable = [];

  for (const player of players) {
    const name = playerDisplay(player);
    const playerEntries = entries.filter(entry => entry.player_id === player.id);
    const playerRules = rules.filter(rule => rule.player_id === player.id);

    let reason = null;

    for (const entry of playerEntries) {
      if (!overlaps(slotStartAt, slotEndAt, entry.start_at, entry.end_at)) continue;
      const typeLabel = entry.entry_type === 'vacation' ? 'Urlaub' : 'Abwesenheit';
      const statusNote = entry.approval_status === 'pending_admin' ? ' • Status: wartet auf Freigabe' : '';
      reason = `[${typeLabel}] ${formatEntryRange(entry.start_at, entry.end_at)} • Grund: ${entry.reason ?? '-'}${statusNote}`;
      break;
    }

    if (!reason) {
      for (const rule of playerRules) {
        const intervals = getRuleBlockedIntervalsForDate(rule, dateStr);
        const blocked = intervals.some(interval => overlaps(slotStartAt, slotEndAt, interval.start_at, interval.end_at));
        if (!blocked) continue;
        reason = `[Regelmäßig] ${recurringDetail(rule)} • Start: ${formatDateDE(rule.anchor_date ?? dateStr)} • Notiz: ${rule.note ?? '-'}`;
        break;
      }
    }

    if (reason) unavailable.push({ name, reason });
    else available.push(name);
  }

  return {
    dateStr,
    startTime,
    durationMinutes,
    endTime: addMinutesToTime(startTime, durationMinutes),
    slotStartAt,
    slotEndAt,
    playersTotal: players.length,
    available,
    unavailable,
    allAvailable: unavailable.length === 0 && players.length > 0
  };
}

function buildEventActionRows(eventId) {
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`spieltermin:status:${eventId}`)
        .setLabel('Status')
        .setStyle(ButtonStyle.Secondary),
      new ButtonBuilder()
        .setCustomId(`spieltermin:type:${eventId}`)
        .setLabel('Typ')
        .setStyle(ButtonStyle.Secondary),
      new ButtonBuilder()
        .setCustomId(`spieltermin:fixedtime:${eventId}`)
        .setLabel('Fixe Zeit')
        .setStyle(ButtonStyle.Secondary),
      new ButtonBuilder()
        .setCustomId(`spieltermin:meeting:${eventId}`)
        .setLabel('Treffpunkt')
        .setStyle(ButtonStyle.Secondary),
      new ButtonBuilder()
        .setCustomId(`spieltermin:lineup:${eventId}`)
        .setLabel('Aufstellung')
        .setStyle(ButtonStyle.Primary)
    ),
    new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`spieltermin:enemyopgg:${eventId}`)
        .setLabel('Gegner OPGG')
        .setStyle(ButtonStyle.Secondary),
      new ButtonBuilder()
        .setCustomId(`spieltermin:teamopgg:${eventId}`)
        .setLabel('Team OPGG')
        .setStyle(ButtonStyle.Success),
      new ButtonBuilder()
        .setCustomId(`spieltermin:note:${eventId}`)
        .setLabel('Hinweis')
        .setStyle(ButtonStyle.Secondary)
    )
  ];
}

function buildStatusSelectRow(eventId, messageId, currentStatus) {
  return new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId(`spieltermin:statusselect:${eventId}:${messageId}`)
      .setPlaceholder('Neuen Status auswählen')
      .addOptions(
        {
          label: 'Pending',
          value: 'pending',
          description: 'Terminoption ist offen',
          default: currentStatus === 'pending'
        },
        {
          label: 'Fixed',
          value: 'fixed',
          description: 'Termin ist bestätigt',
          default: currentStatus === 'fixed'
        },
        {
          label: 'Cancelled',
          value: 'cancelled',
          description: 'Termin wurde abgesagt',
          default: currentStatus === 'cancelled'
        }
      )
  );
}

function buildTypeSelectRow(eventId, messageId, currentType) {
  return new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId(`spieltermin:typeselect:${eventId}:${messageId}`)
      .setPlaceholder('Neuen Typ auswählen')
      .addOptions(
        {
          label: 'Offen / Noch unklar',
          value: 'open',
          description: 'Noch nicht entschieden, ob Scrim oder Prime League',
          default: (currentType || 'open') === 'open'
        },
        {
          label: 'Scrim',
          value: 'scrim',
          description: 'Scrim / Trainingsspiel',
          default: currentType === 'scrim'
        },
        {
          label: 'Prime League',
          value: 'primeleague',
          description: 'Prime-League-Spiel',
          default: currentType === 'primeleague'
        },
        {
          label: 'Sonstiges',
          value: 'other',
          description: 'Anderer Termin',
          default: currentType === 'other'
        }
      )
  );
}



function buildLineupModalValue(eventId) {
  const assignments = getAssignments(eventId);
  const byRole = new Map(assignments.map(item => [item.role_label, item.player_label]));

  return ROLE_ORDER
    .map(role => `${role}: ${byRole.get(role) || '-'}`)
    .join('\n');
}

function parseLineupModalText(raw) {
  const lines = String(raw || '')
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(Boolean);

  const recognized = new Map();
  const rolePattern = /^(Top|Jgl|Mid|ADC|Supp|Sub1|Sub2)\s*:\s*(.*)$/i;

  for (const line of lines) {
    const match = line.match(rolePattern);
    if (!match) continue;

    const normalizedRole = ROLE_ORDER.find(role => role.toLowerCase() === match[1].toLowerCase());
    if (!normalizedRole) continue;

    recognized.set(normalizedRole, (match[2] || '').trim());
  }

  return recognized;
}

async function applyLineupChanges(eventId, roleMap) {
  const now = new Date().toISOString();
  let changed = 0;

  for (const [roleLabel, rawValue] of roleMap.entries()) {
    const trimmed = String(rawValue || '').trim();

    if (trimmed === '' || trimmed === '-' || trimmed === '—') {
      db.prepare(`
        DELETE FROM team_calendar_assignments
        WHERE event_id = ?
          AND role_label = ?
      `).run(eventId, roleLabel);
      changed++;
      continue;
    }

    const matchedPlayer = findPlayerByLabel(trimmed);

    db.prepare(`
      INSERT INTO team_calendar_assignments (
        event_id,
        role_label,
        player_label,
        player_id,
        note,
        created_at,
        updated_at
      )
      VALUES (?, ?, ?, ?, NULL, ?, ?)
      ON CONFLICT(event_id, role_label)
      DO UPDATE SET
        player_label = excluded.player_label,
        player_id = excluded.player_id,
        updated_at = excluded.updated_at
    `).run(
      eventId,
      roleLabel,
      matchedPlayer ? playerDisplay(matchedPlayer) : trimmed,
      matchedPlayer?.id ?? null,
      now,
      now
    );
    changed++;
  }

  return changed;
}

function playerCalendarTypeLabel(event) {
  switch (event.event_type) {
    case 'primeleague':
      return 'PRM';
    case 'scrim':
      return 'Scrim';
    case 'open':
      return 'Offen';
    case 'other':
      return event.title || 'Sonstiges';
    default:
      return eventTypeLabel(event.event_type);
  }
}

function buildPlayerDateAndTimesValue(event) {
  const meetingAt =
    event.event_type === 'scrim' || event.event_type === 'primeleague'
      ? formatDateTimeDE(getEffectiveMeetingAt(event, event.event_type))
      : '-';

  const eventTime =
    event.scheduled_start_at && event.scheduled_end_at
      ? `${formatDateTimeDE(event.scheduled_start_at)} → ${formatDateTimeDE(event.scheduled_end_at)}`
      : `${formatDateTimeDE(event.window_start_at)} → ${formatDateTimeDE(event.window_end_at)}`;

  return (
    `Datum: ${formatDateLongDE(event.option_date)}\n` +
    `Treffpunkt: ${meetingAt}\n` +
    `Termin: ${eventTime}`
  );
}

function buildPlayerCalendarPayload(eventId) {
  const event = getEventById(eventId);
  if (!event) return null;

  const assignments = getAssignments(eventId);
  const teamOpgg = buildTeamOpggInfo(assignments);
  const ownOpggField = teamOpgg.ok ? `[OP.GG öffnen](${teamOpgg.url})` : '-';

  const fields = [
    {
      name: 'Datum & Uhrzeiten',
      value: truncateField(buildPlayerDateAndTimesValue(event)),
      inline: false
    }
  ];

  if (event.event_type === 'scrim' || event.event_type === 'primeleague') {
    fields.push({
      name: 'Gegner',
      value: truncateField(event.title || '-'),
      inline: false
    });
  }

  fields.push(
    {
      name: 'Art des Termins',
      value: truncateField(playerCalendarTypeLabel(event)),
      inline: false
    },
    {
      name: 'Unser OPGG',
      value: truncateField(ownOpggField),
      inline: false
    },
    {
      name: 'Gegner OPGG',
      value: truncateField(event.opgg_url ?? '-'),
      inline: false
    },
    {
      name: 'Hinweis',
      value: truncateField(event.note ?? '-'),
      inline: false
    }
  );

  const embed = new EmbedBuilder()
    .setColor(statusColor(event.status))
    .setTitle('📅 Spieltermin')
    .addFields(fields)
    .setTimestamp(new Date(event.updated_at || event.created_at || Date.now()));

  return {
    embeds: [embed],
    components: []
  };
}

function buildEventCardPayload(eventId) {
  const event = getEventById(eventId);
  if (!event) return null;

  const assignments = getAssignments(eventId);
  const exactTime =
    event.scheduled_start_at && event.scheduled_end_at
      ? `${formatDateTimeDE(event.scheduled_start_at)} → ${formatDateTimeDE(event.scheduled_end_at)}`
      : '-';

  const teamOpgg = buildTeamOpggInfo(assignments);
  const teamOpggField = teamOpgg.ok
    ? `[OP.GG öffnen](${teamOpgg.url})`
    : teamOpgg.message;

  const embed = new EmbedBuilder()
    .setColor(statusColor(event.status))
    .setTitle(`${statusEmoji(event.status)} ${event.title}`)
    .setDescription(`Kalender-ID: **#${event.id}**`)
    .addFields(
      {
        name: 'Status',
        value: statusLabel(event.status),
        inline: true
      },
      {
        name: 'Typ',
        value: eventTypeLabel(event.event_type),
        inline: true
      },
      {
        name: 'Tag',
        value: formatDateLongDE(event.option_date),
        inline: false
      },
      {
        name: 'Zeitfenster',
        value: `${formatDateTimeDE(event.window_start_at)} → ${formatDateTimeDE(event.window_end_at)}`,
        inline: false
      },
      {
        name: 'Fixe Zeit',
        value: exactTime,
        inline: false
      },
      {
        name: 'Treffpunkt',
        value: truncateField(buildMeetingFieldValue(event)),
        inline: false
      },
      {
        name: 'Verfügbare Spieler',
        value: truncateField(event.available_players_text ?? '-'),
        inline: false
      },
      {
        name: 'Lineup',
        value: truncateField(buildLineupText(assignments)),
        inline: false
      },
      {
        name: 'Gegner OPGG',
        value: truncateField(event.opgg_url ?? '-'),
        inline: false
      },
      {
        name: 'Team OPGG',
        value: truncateField(teamOpggField),
        inline: false
      },
      {
        name: 'Hinweis',
        value: truncateField(event.note ?? '-'),
        inline: false
      }
    )
    .setFooter({
      text: 'Standard-Treffpunkt: Scrim 15 Min vorher / Prime League 30 Min vorher'
    })
    .setTimestamp(new Date(event.updated_at || event.created_at || Date.now()));

  return {
    embeds: [embed],
    components: buildEventActionRows(event.id)
  };
}

async function refreshSpecificCard(channel, messageId, eventId) {
  const payload = buildEventCardPayload(eventId);
  if (!payload) return false;

  try {
    const message = await channel.messages.fetch(messageId);
    if (!message) return false;
    await message.edit(payload);

    await refreshStoredPlayerCard(channel.client, eventId);

    return true;
  } catch (error) {
    console.error(`[Spieltermin] Konnte Karte ${messageId} für Event #${eventId} nicht aktualisieren:`, error);
    return false;
  }
}

async function refreshStoredPlayerCard(client, eventId) {
  const playerChannelId = process.env.PLAYER_CALENDAR_CHANNEL_ID;
  if (!playerChannelId) return false;

  const event = getEventById(eventId);
  if (!event) return false;

  try {
    const channel = await client.channels.fetch(playerChannelId);
    if (!channel || !channel.isTextBased()) return false;

    const payload = buildPlayerCalendarPayload(eventId);
    if (!payload) return false;

    if (!event.player_message_id || event.player_channel_id !== channel.id) {
      const message = await upsertPlayerCardMessage(channel, eventId);
      return !!message;
    }

    const message = await channel.messages.fetch(event.player_message_id);
    if (!message) return false;

    await message.edit(payload);
    return true;
  } catch (error) {
    console.error(`[Spieltermin] Konnte Player-Karte für Event #${eventId} nicht aktualisieren:`, error);
    return false;
  }
}

async function refreshStoredEventCard(client, eventId) {
  let refreshed = false;
  const event = getEventById(eventId);

  if (event?.admin_channel_id && event?.admin_message_id) {
    try {
      const adminChannel = await client.channels.fetch(event.admin_channel_id);
      if (adminChannel && adminChannel.isTextBased()) {
        const payload = buildEventCardPayload(eventId);
        if (payload) {
          const message = await adminChannel.messages.fetch(event.admin_message_id);
          if (message) {
            await message.edit(payload);
            refreshed = true;
          }
        }
      }
    } catch (error) {
      console.error(`[Spieltermin] Konnte gespeicherte Admin-Karte für Event #${eventId} nicht laden:`, error);
    }
  }

  const mirrored = await refreshStoredPlayerCard(client, eventId);
  return refreshed || mirrored;
}

async function upsertPlayerCardMessage(channel, eventId) {
  const event = getEventById(eventId);
  if (!event) return null;

  const payload = buildPlayerCalendarPayload(eventId);
  if (!payload) return null;

  if (event.player_message_id) {
    try {
      const existingMessage = await channel.messages.fetch(event.player_message_id);
      if (existingMessage) {
        await existingMessage.edit(payload);

        if (event.player_channel_id !== channel.id) {
          db.prepare(`
            UPDATE team_calendar_events
            SET player_channel_id = ?, updated_at = ?
            WHERE id = ?
          `).run(channel.id, new Date().toISOString(), eventId);
        }

        return existingMessage;
      }
    } catch (error) {
      console.warn(`[Spieltermin] Gespeicherte Player-Karte für Event #${eventId} nicht gefunden, sende neu.`);
    }
  }

  const sentMessage = await channel.send(payload);

  db.prepare(`
    UPDATE team_calendar_events
    SET player_channel_id = ?,
        player_message_id = ?,
        updated_at = ?
    WHERE id = ?
  `).run(channel.id, sentMessage.id, new Date().toISOString(), eventId);

  return sentMessage;
}

async function upsertAdminCardMessage(channel, eventId) {
  const event = getEventById(eventId);
  if (!event) return null;

  const payload = buildEventCardPayload(eventId);
  if (!payload) return null;

  let adminMessage = null;

  if (event.admin_message_id) {
    try {
      const existingMessage = await channel.messages.fetch(event.admin_message_id);
      if (existingMessage) {
        await existingMessage.edit(payload);

        if (event.admin_channel_id !== channel.id) {
          db.prepare(`
            UPDATE team_calendar_events
            SET admin_channel_id = ?, updated_at = ?
            WHERE id = ?
          `).run(channel.id, new Date().toISOString(), eventId);
        }

        adminMessage = existingMessage;
      }
    } catch (error) {
      console.warn(`[Spieltermin] Gespeicherte Karten-Nachricht für Event #${eventId} nicht gefunden, sende neu.`);
    }
  }

  if (!adminMessage) {
    adminMessage = await channel.send(payload);

    db.prepare(`
      UPDATE team_calendar_events
      SET admin_channel_id = ?,
          admin_message_id = ?,
          updated_at = ?
      WHERE id = ?
    `).run(channel.id, adminMessage.id, new Date().toISOString(), eventId);
  }

  const playerChannelId = process.env.PLAYER_CALENDAR_CHANNEL_ID;
  if (playerChannelId) {
    try {
      const playerChannel = await channel.client.channels.fetch(playerChannelId);
      if (playerChannel && playerChannel.isTextBased()) {
        await upsertPlayerCardMessage(playerChannel, eventId);
      }
    } catch (error) {
      console.error(`[Spieltermin] Konnte Player-Kanal für Event #${eventId} nicht laden:`, error);
    }
  }

  return adminMessage;
}

function ensureAdminPermission(interaction) {
  return isAdminInteraction(interaction);
}

function parsePlannerCustomId(customId) {
  const parts = customId.split(':');
  if (parts[0] !== 'spieltermin') return null;
  return parts;
}

async function handleButtonInteraction(interaction, parts) {
  if (!ensureAdminPermission(interaction)) {
    return interaction.reply({
      content: 'Dafür fehlen dir die Rechte.',
      flags: MessageFlags.Ephemeral
    });
  }

  const action = parts[1];
  const eventId = Number(parts[2]);
  const messageId = interaction.message?.id;
  const event = getEventById(eventId);

  if (!event) {
    return interaction.reply({
      content: 'Dieser Kalendereintrag existiert nicht mehr.',
      flags: MessageFlags.Ephemeral
    });
  }

  if (action === 'status') {
    return interaction.reply({
      content: `Wähle den neuen Status für **#${eventId}**.`,
      components: [buildStatusSelectRow(eventId, messageId, event.status)],
      flags: MessageFlags.Ephemeral
    });
  }

  if (action === 'type') {
    return interaction.reply({
      content: `Wähle den neuen Typ für **#${eventId}**.`,
      components: [buildTypeSelectRow(eventId, messageId, event.event_type)],
      flags: MessageFlags.Ephemeral
    });
  }

  if (action === 'fixedtime') {
    const modal = new ModalBuilder()
      .setCustomId(`spieltermin:fixedtimemodal:${eventId}:${messageId}`)
      .setTitle(`Fixe Zeit – #${eventId}`);

    const startInput = new TextInputBuilder()
      .setCustomId('scheduled_start_time')
      .setLabel('Startzeit (HH:MM)')
      .setStyle(TextInputStyle.Short)
      .setRequired(false)
      .setPlaceholder('z. B. 19:00 oder - zum Löschen');

    const endInput = new TextInputBuilder()
      .setCustomId('scheduled_end_time')
      .setLabel('Endzeit (HH:MM, optional)')
      .setStyle(TextInputStyle.Short)
      .setRequired(false)
      .setPlaceholder('leer = aktuelle Dauer beibehalten');

    if (event.scheduled_start_at) {
      startInput.setValue(event.scheduled_start_at.slice(11, 16));
    }

    if (event.scheduled_end_at) {
      endInput.setValue(event.scheduled_end_at.slice(11, 16));
    }

    modal.addComponents(
      new ActionRowBuilder().addComponents(startInput),
      new ActionRowBuilder().addComponents(endInput)
    );

    return interaction.showModal(modal);
  }

  if (action === 'meeting') {
    if (!event.scheduled_start_at) {
      return interaction.reply({
        content: 'Setze zuerst eine fixe Zeit.',
        flags: MessageFlags.Ephemeral
      });
    }

    const modal = new ModalBuilder()
      .setCustomId(`spieltermin:meetingmodal:${eventId}:${messageId}`)
      .setTitle(`Treffpunkt – #${eventId}`);

    const scrimInput = new TextInputBuilder()
      .setCustomId('meeting_scrim_time')
      .setLabel('Treffpunkt Scrim (HH:MM)')
      .setStyle(TextInputStyle.Short)
      .setRequired(false)
      .setPlaceholder('leer oder - = Standard 15 Min vorher');

    const primeInput = new TextInputBuilder()
      .setCustomId('meeting_prime_time')
      .setLabel('Treffpunkt Prime League (HH:MM)')
      .setStyle(TextInputStyle.Short)
      .setRequired(false)
      .setPlaceholder('leer oder - = Standard 30 Min vorher');

    const currentScrim = getEffectiveMeetingAt(event, 'scrim');
    const currentPrime = getEffectiveMeetingAt(event, 'primeleague');

    if (currentScrim) {
      scrimInput.setValue(currentScrim.slice(11, 16));
    }

    if (currentPrime) {
      primeInput.setValue(currentPrime.slice(11, 16));
    }

    modal.addComponents(
      new ActionRowBuilder().addComponents(scrimInput),
      new ActionRowBuilder().addComponents(primeInput)
    );

    return interaction.showModal(modal);
  }
  if (action === 'lineup') {
    const modal = new ModalBuilder()
      .setCustomId(`spieltermin:lineupmodal:${eventId}:${messageId}`)
      .setTitle(`Aufstellung – #${eventId}`);

    const input = new TextInputBuilder()
      .setCustomId('lineup_text')
      .setLabel('Lineup (eine Rolle pro Zeile)')
      .setStyle(TextInputStyle.Paragraph)
      .setRequired(true)
      .setPlaceholder('Top: ...\nJgl: ...\nMid: ...\nADC: ...\nSupp: ...\nSub1: ...\nSub2: ...')
      .setValue(buildLineupModalValue(eventId));

    modal.addComponents(new ActionRowBuilder().addComponents(input));
    return interaction.showModal(modal);
  }

  if (action === 'enemyopgg') {
    const modal = new ModalBuilder()
      .setCustomId(`spieltermin:enemyopggmodal:${eventId}:${messageId}`)
      .setTitle(`Gegner OPGG – #${eventId}`);

    const input = new TextInputBuilder()
      .setCustomId('opgg_url')
      .setLabel('OPGG-Link des Gegners')
      .setStyle(TextInputStyle.Paragraph)
      .setRequired(false)
      .setPlaceholder('Leer lassen oder - eingeben, um zu löschen');

    if (event.opgg_url) input.setValue(event.opgg_url);

    modal.addComponents(new ActionRowBuilder().addComponents(input));
    return interaction.showModal(modal);
  }

  if (action === 'note') {
    const modal = new ModalBuilder()
      .setCustomId(`spieltermin:notemodal:${eventId}:${messageId}`)
      .setTitle(`Hinweis – #${eventId}`);

    const input = new TextInputBuilder()
      .setCustomId('note_text')
      .setLabel('Hinweistext')
      .setStyle(TextInputStyle.Paragraph)
      .setRequired(false)
      .setPlaceholder('Leer lassen oder - eingeben, um zu löschen');

    if (event.note) input.setValue(event.note);

    modal.addComponents(new ActionRowBuilder().addComponents(input));
    return interaction.showModal(modal);
  }

  if (action === 'teamopgg') {
    const teamOpgg = buildTeamOpggInfo(getAssignments(eventId));

    return interaction.reply({
      content: teamOpgg.ok
        ? `**Team OPGG für #${eventId}:**\n${teamOpgg.url}`
        : `Kein Team-OPGG möglich: ${teamOpgg.message}`,
      flags: MessageFlags.Ephemeral
    });
  }
}

async function handleStringSelectInteraction(interaction, parts) {
  if (!ensureAdminPermission(interaction)) {
    return interaction.reply({
      content: 'Dafür fehlen dir die Rechte.',
      flags: MessageFlags.Ephemeral
    });
  }

  const action = parts[1];
  const eventId = Number(parts[2]);
  const messageId = parts[3];
  const event = getEventById(eventId);

  if (!event) {
    return interaction.update({
      content: 'Dieser Kalendereintrag existiert nicht mehr.',
      components: []
    });
  }

  if (action === 'statusselect') {
    const nextStatus = interaction.values[0];

    if (!STATUS_VALUES.includes(nextStatus)) {
      return interaction.update({
        content: 'Ungültiger Status.',
        components: []
      });
    }

    db.prepare(`
      UPDATE team_calendar_events
      SET status = ?,
          updated_by_discord_user_id = ?,
          updated_at = ?
      WHERE id = ?
    `).run(nextStatus, interaction.user.id, new Date().toISOString(), eventId);

    await refreshSpecificCard(interaction.channel, messageId, eventId);

    return interaction.update({
      content: `Status für **#${eventId}** wurde auf **${statusLabel(nextStatus)}** gesetzt.`,
      components: []
    });
  }

  if (action === 'typeselect') {
    const nextType = interaction.values[0];

    if (!EVENT_TYPE_VALUES.includes(nextType)) {
      return interaction.update({
        content: 'Ungültiger Typ.',
        components: []
      });
    }

    db.prepare(`
      UPDATE team_calendar_events
      SET event_type = ?,
          updated_by_discord_user_id = ?,
          updated_at = ?
      WHERE id = ?
    `).run(nextType, interaction.user.id, new Date().toISOString(), eventId);

    await refreshSpecificCard(interaction.channel, messageId, eventId);

    return interaction.update({
      content: `Typ für **#${eventId}** wurde auf **${eventTypeLabel(nextType)}** gesetzt.`,
      components: []
    });
  }

  if (action === 'lineuprole') {
    const roleLabel = interaction.values[0];
    const currentAssignment = getRoleAssignment(eventId, roleLabel);
    const infoText = currentAssignment
      ? `Aktuell ist **${roleLabel}** auf **${currentAssignment.player_label}** gesetzt.`
      : `Für **${roleLabel}** ist aktuell niemand gesetzt.`;

    return interaction.update({
      content: `${infoText}\nWähle jetzt einen Spieler oder leere die Rolle.`,
      components: [
        buildPlayerSelectRow(eventId, messageId, roleLabel),
        buildRoleSelectRow(eventId, messageId)
      ]
    });
  }

  if (action === 'lineupplayer') {
    const roleLabel = parts[4];
    const selectedValue = interaction.values[0];
    const now = new Date().toISOString();
    let infoText;

    if (selectedValue === '__clear__') {
      db.prepare(`
        DELETE FROM team_calendar_assignments
        WHERE event_id = ? AND role_label = ?
      `).run(eventId, roleLabel);

      infoText = `**${roleLabel}** wurde geleert.`;
    } else {
      const player = db.prepare(`
        SELECT *
        FROM players
        WHERE id = ?
      `).get(Number(selectedValue));

      if (!player) {
        return interaction.update({
          content: 'Der ausgewählte Spieler wurde nicht gefunden.',
          components: [buildRoleSelectRow(eventId, messageId)]
        });
      }

      db.prepare(`
        INSERT INTO team_calendar_assignments (
          event_id,
          role_label,
          player_label,
          player_id,
          note,
          created_at,
          updated_at
        )
        VALUES (?, ?, ?, ?, NULL, ?, ?)
        ON CONFLICT(event_id, role_label)
        DO UPDATE SET
          player_label = excluded.player_label,
          player_id = excluded.player_id,
          updated_at = excluded.updated_at
      `).run(
        eventId,
        roleLabel,
        playerDisplay(player),
        player.id,
        now,
        now
      );

      infoText = `**${roleLabel}** wurde auf **${playerDisplay(player)}** gesetzt.`;
    }

    await refreshSpecificCard(interaction.channel, messageId, eventId);

    return interaction.update({
      ...buildLineupManagerPayload(eventId, messageId, infoText)
    });
  }
}

async function handleModalSubmitInteraction(interaction, parts) {
  if (!ensureAdminPermission(interaction)) {
    return interaction.reply({
      content: 'Dafür fehlen dir die Rechte.',
      flags: MessageFlags.Ephemeral
    });
  }

  const action = parts[1];
  const eventId = Number(parts[2]);
  const messageId = parts[3];
  const event = getEventById(eventId);

  if (!event) {
    return interaction.reply({
      content: 'Dieser Kalendereintrag existiert nicht mehr.',
      flags: MessageFlags.Ephemeral
    });
  }

  if (action === 'fixedtimemodal') {
    const rawStart = interaction.fields.getTextInputValue('scheduled_start_time').trim();
    const rawEnd = interaction.fields.getTextInputValue('scheduled_end_time').trim();

    let nextScheduledStartAt = event.scheduled_start_at;
    let nextScheduledEndAt = event.scheduled_end_at;
    let nextMeetingScrimAt = event.meeting_scrim_at;
    let nextMeetingPrimeleagueAt = event.meeting_primeleague_at;

    if (rawStart === '' || rawStart === '-') {
      nextScheduledStartAt = null;
      nextScheduledEndAt = null;
      nextMeetingScrimAt = null;
      nextMeetingPrimeleagueAt = null;
    } else {
      if (!isValidTime(rawStart)) {
        return interaction.reply({
          content: 'Die Startzeit ist ungültig. Bitte nutze HH:MM.',
          flags: MessageFlags.Ephemeral
        });
      }

      const durationMinutes = getDurationMinutesFromDateTimes(
        event.scheduled_start_at || event.window_start_at,
        event.scheduled_end_at || event.window_end_at
      );

      const nextEndTime =
        rawEnd === ''
          ? addMinutesToTime(rawStart, durationMinutes)
          : rawEnd;

      if (!isValidTime(nextEndTime)) {
        return interaction.reply({
          content: 'Die Endzeit ist ungültig. Bitte nutze HH:MM.',
          flags: MessageFlags.Ephemeral
        });
      }

      nextScheduledStartAt = `${event.option_date} ${rawStart}`;
      nextScheduledEndAt = `${event.option_date} ${nextEndTime}`;

      nextMeetingScrimAt = reconcileMeetingAfterScheduleChange(
        event.meeting_scrim_at,
        event.scheduled_start_at,
        nextScheduledStartAt,
        'scrim'
      );

      nextMeetingPrimeleagueAt = reconcileMeetingAfterScheduleChange(
        event.meeting_primeleague_at,
        event.scheduled_start_at,
        nextScheduledStartAt,
        'primeleague'
      );
    }

    db.prepare(`
      UPDATE team_calendar_events
      SET scheduled_start_at = ?,
          scheduled_end_at = ?,
          meeting_scrim_at = ?,
          meeting_primeleague_at = ?,
          updated_by_discord_user_id = ?,
          updated_at = ?
      WHERE id = ?
    `).run(
      nextScheduledStartAt,
      nextScheduledEndAt,
      nextMeetingScrimAt,
      nextMeetingPrimeleagueAt,
      interaction.user.id,
      new Date().toISOString(),
      eventId
    );

    await refreshSpecificCard(interaction.channel, messageId, eventId);

    return interaction.reply({
      content: nextScheduledStartAt
        ? `Fixe Zeit für **#${eventId}** wurde auf **${formatDateTimeDE(nextScheduledStartAt)} → ${formatDateTimeDE(nextScheduledEndAt)}** gesetzt.`
        : `Fixe Zeit für **#${eventId}** wurde gelöscht.`,
      flags: MessageFlags.Ephemeral
    });
  }

  if (action === 'meetingmodal') {
    if (!event.scheduled_start_at) {
      return interaction.reply({
        content: 'Setze zuerst eine fixe Zeit.',
        flags: MessageFlags.Ephemeral
      });
    }

    const rawScrim = interaction.fields.getTextInputValue('meeting_scrim_time').trim();
    const rawPrime = interaction.fields.getTextInputValue('meeting_prime_time').trim();
    const dateStr = event.scheduled_start_at.slice(0, 10);

    if (rawScrim !== '' && rawScrim !== '-' && !isValidTime(rawScrim)) {
      return interaction.reply({
        content: 'Treffpunkt Scrim ist ungültig. Bitte nutze HH:MM.',
        flags: MessageFlags.Ephemeral
      });
    }

    if (rawPrime !== '' && rawPrime !== '-' && !isValidTime(rawPrime)) {
      return interaction.reply({
        content: 'Treffpunkt Prime League ist ungültig. Bitte nutze HH:MM.',
        flags: MessageFlags.Ephemeral
      });
    }

    const nextMeetingScrimAt =
      rawScrim === '' || rawScrim === '-'
        ? null
        : `${dateStr} ${rawScrim}`;

    const nextMeetingPrimeleagueAt =
      rawPrime === '' || rawPrime === '-'
        ? null
        : `${dateStr} ${rawPrime}`;

    db.prepare(`
      UPDATE team_calendar_events
      SET meeting_scrim_at = ?,
          meeting_primeleague_at = ?,
          updated_by_discord_user_id = ?,
          updated_at = ?
      WHERE id = ?
    `).run(
      nextMeetingScrimAt,
      nextMeetingPrimeleagueAt,
      interaction.user.id,
      new Date().toISOString(),
      eventId
    );

    await refreshSpecificCard(interaction.channel, messageId, eventId);

    const freshEvent = getEventById(eventId);

    return interaction.reply({
      content:
        `Treffpunkt für **#${eventId}** wurde aktualisiert.\n` +
        `Aktuell: **${buildMeetingFieldValue(freshEvent)}**`,
      flags: MessageFlags.Ephemeral
    });
  }
  if (action === 'lineupmodal') {
    const parsedLineup = parseLineupModalText(interaction.fields.getTextInputValue('lineup_text'));

    if (parsedLineup.size === 0) {
      return interaction.reply({
        content:
          'Ich konnte keine Rollen erkennen. Bitte nutze pro Zeile das Format `Top: Name`.',
        flags: MessageFlags.Ephemeral
      });
    }

    const changed = await applyLineupChanges(eventId, parsedLineup);
    const assignments = getAssignments(eventId);

    await refreshSpecificCard(interaction.channel, messageId, eventId);

    return interaction.reply({
      content:
        (changed === 0
          ? 'Es wurden keine Rollen geändert.\n'
          : `Lineup für **#${eventId}** wurde aktualisiert.\n`) +
        `Aktuell: **${buildLineupText(assignments)}**`,
      flags: MessageFlags.Ephemeral
    });
  }

  if (action === 'enemyopggmodal') {
    const raw = interaction.fields.getTextInputValue('opgg_url').trim();
    const nextValue = raw === '' || raw === '-' ? null : raw;

    db.prepare(`
      UPDATE team_calendar_events
      SET opgg_url = ?,
          updated_by_discord_user_id = ?,
          updated_at = ?
      WHERE id = ?
    `).run(nextValue, interaction.user.id, new Date().toISOString(), eventId);

    await refreshSpecificCard(interaction.channel, messageId, eventId);

    return interaction.reply({
      content: `Gegner-OPGG für **#${eventId}** wurde ${nextValue ? 'gespeichert' : 'gelöscht'}.`,
      flags: MessageFlags.Ephemeral
    });
  }

  if (action === 'notemodal') {
    const raw = interaction.fields.getTextInputValue('note_text').trim();
    const nextValue = raw === '' || raw === '-' ? null : raw;

    db.prepare(`
      UPDATE team_calendar_events
      SET note = ?,
          updated_by_discord_user_id = ?,
          updated_at = ?
      WHERE id = ?
    `).run(nextValue, interaction.user.id, new Date().toISOString(), eventId);

    await refreshSpecificCard(interaction.channel, messageId, eventId);

    return interaction.reply({
      content: `Hinweis für **#${eventId}** wurde ${nextValue ? 'gespeichert' : 'gelöscht'}.`,
      flags: MessageFlags.Ephemeral
    });
  }
}

const command = {
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
        .setName('pruefen')
        .setDescription('Prüft ein konkretes Datum und eine Uhrzeit auf Verfügbarkeit.')
        .addStringOption(option =>
          option
            .setName('datum')
            .setDescription('Datum als TT.MM.JJJJ oder YYYY-MM-DD')
            .setRequired(true)
        )
        .addStringOption(option =>
          option
            .setName('startzeit')
            .setDescription('Startzeit im Format HH:MM')
            .setRequired(true)
        )
        .addIntegerOption(option =>
          option
            .setName('dauer_minuten')
            .setDescription('Dauer in Minuten, Standard: 150')
            .setRequired(false)
            .setMinValue(30)
            .setMaxValue(720)
        )
        .addStringOption(option =>
          option
            .setName('typ')
            .setDescription('Optionaler Termin-Typ für die Vorschau')
            .setRequired(false)
            .addChoices(
              { name: 'Offen / Noch unklar', value: 'open' },
              { name: 'Scrim', value: 'scrim' },
              { name: 'Prime League', value: 'primeleague' },
              { name: 'Sonstiges', value: 'other' }
            )
        )
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
              { name: 'Offen / Noch unklar', value: 'open' },
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
            .setDescription('Optional: OPGG-Link des Gegners, mit "-" wird gelöscht')
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
          flags: MessageFlags.Ephemeral
        });
      }

      const lines = [];

      for (const event of events) {
        const assignments = getAssignments(event.id);
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
          `Gegner OPGG: **${event.opgg_url ?? '-'}**\n` +
          `Team OPGG: **${buildTeamOpggInfo(assignments).ok ? 'automatisch generierbar' : '-'}**\n` +
          `Hinweis: **${event.note ?? '-'}**`
        );
      }

      return interaction.reply({
        content: lines.join('\n\n'),
        flags: MessageFlags.Ephemeral
      });
    }

    if (subcommand === 'pruefen') {
      if (!ensureAdminPermission(interaction)) {
        return interaction.reply({
          content: 'Dafür fehlen dir die Rechte.',
          flags: MessageFlags.Ephemeral
        });
      }

      const datumInput = interaction.options.getString('datum', true);
      const startzeit = interaction.options.getString('startzeit', true).trim();
      const dauerMinuten = interaction.options.getInteger('dauer_minuten') ?? 150;
      const typ = interaction.options.getString('typ') ?? 'open';

      const parsedDate = parseDateInput(datumInput);
      if (!parsedDate) {
        return interaction.reply({
          content: 'Datum ungültig. Nutze TT.MM.JJJJ oder YYYY-MM-DD.',
          flags: MessageFlags.Ephemeral
        });
      }

      if (!isValidTime(startzeit)) {
        return interaction.reply({
          content: 'Startzeit ungültig. Bitte nutze HH:MM, z. B. 18:30.',
          flags: MessageFlags.Ephemeral
        });
      }

      const snapshot = getAvailabilitySnapshot(parsedDate, startzeit, dauerMinuten);
      const unavailableText = snapshot.unavailable.length
        ? snapshot.unavailable.map(item => `• ${item.name} — ${item.reason}`).join('\n')
        : 'Niemand ist laut aktueller Daten blockiert.';

      const embed = new EmbedBuilder()
        .setColor(snapshot.allAvailable ? 0x57f287 : 0xfee75c)
        .setTitle(`Verfügbarkeitscheck – ${formatDateLongDE(parsedDate)}`)
        .setDescription(
          `**Typ:** ${eventTypeLabel(typ)}
` +
          `**Zeitfenster:** ${formatDateTimeDE(snapshot.slotStartAt)} → ${formatDateTimeDE(snapshot.slotEndAt)}
` +
          `**Dauer:** ${dauerMinuten} Minuten
` +
          `**Ergebnis:** ${snapshot.allAvailable ? 'Alle eingetragenen Spieler sind verfügbar.' : `${snapshot.available.length}/${snapshot.playersTotal} verfügbar`}`
        )
        .addFields(
          {
            name: `Verfügbar (${snapshot.available.length})`,
            value: snapshot.available.length ? truncateField(snapshot.available.join(', '), 1024) : '-',
            inline: false
          },
          {
            name: `Nicht verfügbar (${snapshot.unavailable.length})`,
            value: truncateField(unavailableText, 1024),
            inline: false
          }
        )
        .setFooter({
          text: 'Prüfung basiert auf eingetragenen Abwesenheiten und Regeln.'
        })
        .setTimestamp();

      return interaction.reply({
        embeds: [embed],
        flags: MessageFlags.Ephemeral
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

      const event = getEventById(id);

      if (!event) {
        return interaction.reply({
          content: 'Ich habe keinen Kalendereintrag mit dieser ID gefunden.',
          flags: MessageFlags.Ephemeral
        });
      }

      const parsedDate = datumInput ? parseDateInput(datumInput) : event.option_date;
      if (datumInput && !parsedDate) {
        return interaction.reply({
          content: 'Datum ungültig. Nutze TT.MM.JJJJ oder YYYY-MM-DD.',
          flags: MessageFlags.Ephemeral
        });
      }

      if (startzeit && !isValidTime(startzeit)) {
        return interaction.reply({
          content: 'Startzeit ungültig. Bitte nutze HH:MM, z. B. 18:30.',
          flags: MessageFlags.Ephemeral
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
        }
      }

      if (startzeit) {
        const durationMinutes = getDurationMinutesFromDateTimes(
          event.scheduled_start_at || event.window_start_at,
          event.scheduled_end_at || event.window_end_at
        );

        const endzeit = addMinutesToTime(startzeit, durationMinutes);
        nextScheduledStartAt = `${nextDate} ${startzeit}`;
        nextScheduledEndAt = `${nextDate} ${endzeit}`;
      }

      if (nextScheduledStartAt) {
        nextMeetingScrimAt = reconcileMeetingAfterScheduleChange(
          event.meeting_scrim_at,
          event.scheduled_start_at,
          nextScheduledStartAt,
          'scrim'
        );

        nextMeetingPrimeleagueAt = reconcileMeetingAfterScheduleChange(
          event.meeting_primeleague_at,
          event.scheduled_start_at,
          nextScheduledStartAt,
          'primeleague'
        );
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

      await refreshStoredEventCard(interaction.client, id);

      return interaction.reply({
        content:
          `Spieltermin **#${id}** wurde aktualisiert.\n` +
          `Titel: **${nextTitle}**\n` +
          `Status: **${statusLabel(nextStatus)}**\n` +
          `Typ: **${eventTypeLabel(nextType)}**\n` +
          `Fenster: **${formatDateTimeDE(nextWindowStartAt)} → ${formatDateTimeDE(nextWindowEndAt)}**\n` +
          `Fixe Zeit: **${nextScheduledStartAt ? `${formatDateTimeDE(nextScheduledStartAt)} → ${formatDateTimeDE(nextScheduledEndAt)}` : '-'}**\n` +
          `Gegner OPGG: **${nextOpgg ?? '-'}**\n` +
          `Hinweis: **${nextHint ?? '-'}**`,
        flags: MessageFlags.Ephemeral
      });
    }

    if (subcommand === 'lineup') {
      const id = interaction.options.getInteger('id', true);
      const event = getEventById(id);

      if (!event) {
        return interaction.reply({
          content: 'Ich habe keinen Kalendereintrag mit dieser ID gefunden.',
          flags: MessageFlags.Ephemeral
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

        const matchedPlayer = findPlayerByLabel(trimmed);

        db.prepare(`
          INSERT INTO team_calendar_assignments (
            event_id,
            role_label,
            player_label,
            player_id,
            note,
            created_at,
            updated_at
          )
          VALUES (?, ?, ?, ?, NULL, ?, ?)
          ON CONFLICT(event_id, role_label)
          DO UPDATE SET
            player_label = excluded.player_label,
            player_id = excluded.player_id,
            updated_at = excluded.updated_at
        `).run(
          id,
          roleLabel,
          matchedPlayer ? playerDisplay(matchedPlayer) : trimmed,
          matchedPlayer?.id ?? null,
          now,
          now
        );
        changed++;
      }

      const assignments = getAssignments(id);
      await refreshStoredEventCard(interaction.client, id);

      return interaction.reply({
        content:
          (changed === 0
            ? 'Es wurden keine Rollen geändert.\n'
            : `Lineup für **#${id}** wurde aktualisiert.\n`) +
          `Aktuell: **${buildLineupText(assignments)}**`,
        flags: MessageFlags.Ephemeral
      });
    }
  },

  canHandleInteraction(interaction) {
    return Boolean(interaction.customId && interaction.customId.startsWith('spieltermin:'));
  },

  async handleInteraction(interaction) {
    const parts = parsePlannerCustomId(interaction.customId);
    if (!parts) return false;

    if (interaction.isButton()) {
      await handleButtonInteraction(interaction, parts);
      return true;
    }

    if (interaction.isStringSelectMenu()) {
      await handleStringSelectInteraction(interaction, parts);
      return true;
    }

    if (interaction.isModalSubmit()) {
      await handleModalSubmitInteraction(interaction, parts);
      return true;
    }

    return false;
  },

  buildEventCardPayload,
  upsertAdminCardMessage,
  refreshStoredEventCard,
  statusLabel,
  eventTypeLabel,
  buildLineupText
};

module.exports = command;
