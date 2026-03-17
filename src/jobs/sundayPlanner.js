const db = require('../db/database');

const SLOT_CONFIG = {
  weekdayStart: '17:00',
  weekendStart: '15:00',
  dayEnd: '23:00',
  minDurationMinutes: 150,
  slotStepMinutes: 30
};

function getRunKey(date = new Date()) {
  return date.toISOString().slice(0, 10);
}

function tryAcquireJobRun(jobName, runKey) {
  const now = new Date().toISOString();

  const result = db.prepare(`
    INSERT OR IGNORE INTO job_runs (job_name, run_key, created_at)
    VALUES (?, ?, ?)
  `).run(jobName, `${jobName}:${runKey}`, now);

  return result.changes > 0;
}

function tableExists(tableName) {
  const row = db.prepare(`
    SELECT name
    FROM sqlite_master
    WHERE type = 'table' AND name = ?
  `).get(tableName);

  return !!row;
}

function playerDisplay(row) {
  return row.alias || row.global_name || row.username || row.discord_user_id;
}

function todayInBerlin() {
  return new Intl.DateTimeFormat('sv-SE', {
    timeZone: 'Europe/Berlin',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).format(new Date());
}

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
  const dates = [];
  for (let i = 0; i < numberOfDays; i++) {
    dates.push(addDaysIso(startDate, i));
  }
  return dates;
}

function extractDatePart(dateTime) {
  return dateTime.slice(0, 10);
}

function extractTimePart(dateTime) {
  return dateTime.slice(11, 16);
}

function formatDateDE(dateStr) {
  const [year, month, day] = dateStr.split('-');
  return `${day}.${month}.${year}`;
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

function formatDateTimeDE(dateTime) {
  const [dateStr, timeStr] = dateTime.split(' ');
  return `${formatDateDE(dateStr)}, ${timeStr}`;
}

function formatEntryRange(startAt, endAt) {
  const startDate = extractDatePart(startAt);
  const endDate = extractDatePart(endAt);
  const startTime = extractTimePart(startAt);
  const endTime = extractTimePart(endAt);

  const isAllDay = startTime === '00:00' && endTime === '23:59';

  if (isAllDay && startDate === endDate) {
    return `${formatDateDE(startDate)} (ganztägig)`;
  }

  if (isAllDay) {
    return `${formatDateDE(startDate)} → ${formatDateDE(endDate)} (ganztägig)`;
  }

  return `${formatDateTimeDE(startAt)} → ${formatDateTimeDE(endAt)}`;
}

function parseTimeToMinutes(timeStr) {
  const [hours, minutes] = timeStr.split(':').map(Number);
  return hours * 60 + minutes;
}

function minutesToTime(minutes) {
  const safeMinutes = Math.max(0, minutes);
  const hours = String(Math.floor(safeMinutes / 60)).padStart(2, '0');
  const mins = String(safeMinutes % 60).padStart(2, '0');
  return `${hours}:${mins}`;
}

function addMinutesToTime(timeStr, minutesToAdd) {
  return minutesToTime(parseTimeToMinutes(timeStr) + minutesToAdd);
}

function buildDateTime(dateStr, timeStr) {
  return `${dateStr} ${timeStr}`;
}

function overlaps(startA, endA, startB, endB) {
  return startA < endB && startB < endA;
}

function getWeekdayIndexFromIsoDate(dateStr) {
  const [year, month, day] = dateStr.split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, day)).getUTCDay(); // 0=So ... 6=Sa
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

    case 'monthly': {
      const targetDay = Number(dateStr.slice(8, 10));
      const anchorDay = Number(anchorDate.slice(8, 10));
      return targetDay === anchorDay;
    }

    case 'yearly': {
      const targetMonthDay = dateStr.slice(5, 10);
      const anchorMonthDay = anchorDate.slice(5, 10);
      return targetMonthDay === anchorMonthDay;
    }

    default:
      return false;
  }
}

function getRuleBlockedIntervalsForDate(rule, dateStr) {
  if (!matchesRuleOnDate(rule, dateStr)) {
    return [];
  }

  if (rule.rule_type === 'nicht_verfuegbar') {
    return [{
      start_at: `${dateStr} 00:00`,
      end_at: `${dateStr} 23:59`
    }];
  }

  if (rule.rule_type === 'erst_ab' && rule.time_value) {
    return [{
      start_at: `${dateStr} 00:00`,
      end_at: `${dateStr} ${rule.time_value}`
    }];
  }

  if (rule.rule_type === 'bis' && rule.time_value) {
    return [{
      start_at: `${dateStr} ${rule.time_value}`,
      end_at: `${dateStr} 23:59`
    }];
  }

  return [];
}

function recurringDetail(rule) {
  if (rule.rule_type === 'nicht_verfuegbar') {
    return 'ganztägig nicht verfügbar';
  }

  if (rule.rule_type === 'erst_ab') {
    return `bis ${rule.time_value} nicht verfügbar`;
  }

  if (rule.rule_type === 'bis') {
    return `ab ${rule.time_value} nicht verfügbar`;
  }

  return rule.rule_type;
}

function recurringSortKey(rule, dateStr) {
  if (rule.rule_type === 'nicht_verfuegbar' || rule.rule_type === 'erst_ab') {
    return `${dateStr} 00:00`;
  }

  if (rule.rule_type === 'bis') {
    return `${dateStr} ${rule.time_value ?? '23:59'}`;
  }

  return `${dateStr} 00:00`;
}

function expandRecurringRules(rules, windowDates) {
  const items = [];

  for (const rule of rules) {
    for (const dateStr of windowDates) {
      if (!matchesRuleOnDate(rule, dateStr)) continue;

      items.push({
        source_type: 'recurring',
        sort_key: recurringSortKey(rule, dateStr),
        player_name: playerDisplay(rule),
        display_text:
          `- ${playerDisplay(rule)} • [Regelmäßig] ${formatDateDE(dateStr)} • ` +
          `${recurringDetail(rule)} • Start: ${formatDateDE(rule.anchor_date)} • Notiz: ${rule.note ?? '-'}`
      });
    }
  }

  return items;
}

function mapExplicitEntries(entries) {
  return entries.map(entry => {
    const typeLabel = entry.entry_type === 'vacation' ? 'Urlaub' : 'Abwesenheit';

    return {
      source_type: 'entry',
      sort_key: entry.start_at,
      player_name: playerDisplay(entry),
      display_text:
        `- ${playerDisplay(entry)} • [Einmalig • ${typeLabel}] ${formatEntryRange(entry.start_at, entry.end_at)} • ` +
        `Grund: ${entry.reason ?? '-'}`
    };
  });
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
      return 'Termin';
  }
}

function formatCalendarEvent(event) {
  return [
    `- [${statusLabel(event.status)}] ${event.title}`,
    `  ${formatDateLongDE(extractDatePart(event.start_at))}`,
    `  ${extractTimePart(event.start_at)}–${extractTimePart(event.end_at)} Uhr`,
    `  Treffen: ${extractTimePart(event.meeting_at)} Uhr`,
    `  Typ: ${eventTypeLabel(event.event_type)}`,
    `  Hinweis: ${event.note ?? '-'}`
  ].join('\n');
}

function getCandidateStartTimesForDate(dateStr) {
  const weekday = getWeekdayIndexFromIsoDate(dateStr);
  const isWeekend = weekday === 0 || weekday === 6;

  const startMinutes = parseTimeToMinutes(
    isWeekend ? SLOT_CONFIG.weekendStart : SLOT_CONFIG.weekdayStart
  );
  const latestStart = parseTimeToMinutes(SLOT_CONFIG.dayEnd) - SLOT_CONFIG.minDurationMinutes;

  const starts = [];
  for (let minutes = startMinutes; minutes <= latestStart; minutes += SLOT_CONFIG.slotStepMinutes) {
    starts.push(minutesToTime(minutes));
  }

  return starts;
}

function getPlayers() {
  return db.prepare(`
    SELECT id, discord_user_id, username, global_name, alias
    FROM players
    ORDER BY id ASC
  `).all();
}

function getUnavailablePlayersForSlot(players, explicitEntries, rules, dateStr, slotStartAt, slotEndAt) {
  const unavailable = [];

  for (const player of players) {
    const playerEntries = explicitEntries.filter(entry => entry.player_id === player.id);
    const playerRules = rules.filter(rule => rule.player_id === player.id);

    let blocked = false;

    for (const entry of playerEntries) {
      if (overlaps(slotStartAt, slotEndAt, entry.start_at, entry.end_at)) {
        blocked = true;
        break;
      }
    }

    if (!blocked) {
      for (const rule of playerRules) {
        const intervals = getRuleBlockedIntervalsForDate(rule, dateStr);
        for (const interval of intervals) {
          if (overlaps(slotStartAt, slotEndAt, interval.start_at, interval.end_at)) {
            blocked = true;
            break;
          }
        }
        if (blocked) break;
      }
    }

    if (blocked) {
      unavailable.push(playerDisplay(player));
    }
  }

  return unavailable;
}

function compressStartWindows(startTimes) {
  if (!startTimes.length) return '-';

  const minutes = startTimes
    .map(parseTimeToMinutes)
    .sort((a, b) => a - b);

  const ranges = [];
  let rangeStart = minutes[0];
  let previous = minutes[0];

  for (let i = 1; i < minutes.length; i++) {
    const current = minutes[i];

    if (current - previous === SLOT_CONFIG.slotStepMinutes) {
      previous = current;
      continue;
    }

    ranges.push([rangeStart, previous]);
    rangeStart = current;
    previous = current;
  }

  ranges.push([rangeStart, previous]);

  return ranges
    .map(([start, end]) => {
      if (start === end) {
        return `${minutesToTime(start)} Uhr`;
      }
      return `${minutesToTime(start)}–${minutesToTime(end)} Uhr`;
    })
    .join(', ');
}

function buildDailySuggestionPosts(players, explicitEntries, rules, windowDates) {
  const dayPosts = [];

  for (const dateStr of windowDates) {
    const startTimes = getCandidateStartTimesForDate(dateStr);
    const validSlots = [];

    for (const startTime of startTimes) {
      const endTime = addMinutesToTime(startTime, SLOT_CONFIG.minDurationMinutes);
      const slotStartAt = buildDateTime(dateStr, startTime);
      const slotEndAt = buildDateTime(dateStr, endTime);

      const unavailablePlayers = getUnavailablePlayersForSlot(
        players,
        explicitEntries,
        rules,
        dateStr,
        slotStartAt,
        slotEndAt
      );

      if (unavailablePlayers.length === 0) {
        validSlots.push({
          start_time: startTime,
          end_time: endTime
        });
      }
    }

    if (validSlots.length === 0) {
      continue;
    }

    const earliestStart = validSlots[0].start_time;
    const latestStart = validSlots[validSlots.length - 1].start_time;
    const latestEnd = validSlots[validSlots.length - 1].end_time;
    const startWindows = compressStartWindows(validSlots.map(slot => slot.start_time));

    const lines = [];
    lines.push(`**Terminoption – ${formatDateLongDE(dateStr)}**`);
    lines.push(`Frühestmöglicher Beginn: **${earliestStart} Uhr**`);
    lines.push(`Spätestmöglicher Beginn: **${latestStart} Uhr**`);
    lines.push(`Spätestmögliches Ende: **${latestEnd} Uhr**`);
    lines.push(`Mögliche Startfenster: **${startWindows}**`);
    lines.push(`Treffpunkt: **15 Min vorher (Scrim) / 30 Min vorher (Prime League)**`);
    lines.push(`Hinweis: **-**`);

    dayPosts.push(lines.join('\n'));
  }

  return dayPosts;
}

function splitLongMessage(text, maxLength = 1900) {
  if (text.length <= maxLength) {
    return [text];
  }

  const lines = text.split('\n');
  const chunks = [];
  let current = '';

  for (const line of lines) {
    const next = current ? `${current}\n${line}` : line;

    if (next.length > maxLength) {
      if (current) chunks.push(current);
      current = line;
    } else {
      current = next;
    }
  }

  if (current) chunks.push(current);

  return chunks;
}

async function runSundayPlanner(client, options = {}) {
  const { force = false } = options;
  const runKey = getRunKey();

  if (!force) {
    const acquired = tryAcquireJobRun('sunday_planner', runKey);
    if (!acquired) {
      console.log(`[Planner] Bereits ausgeführt für ${runKey}`);
      return { skipped: true, reason: 'already_ran_today' };
    }
  } else {
    console.log(`[Planner] Force-Run aktiv für ${runKey}`);
  }

  const berlinToday = todayInBerlin();
  const windowDates = getDateWindow(berlinToday, 7);
  const windowStart = `${berlinToday} 00:00`;
  const windowEndInclusive = `${addDaysIso(berlinToday, 6)} 23:59`;

  const players = getPlayers();

  const upcomingEntries = db.prepare(`
    SELECT
      e.id,
      e.player_id,
      e.entry_type,
      e.start_at,
      e.end_at,
      e.reason,
      p.discord_user_id,
      p.username,
      p.global_name,
      p.alias
    FROM availability_entries e
    INNER JOIN players p ON p.id = e.player_id
    WHERE e.end_at >= ?
      AND e.start_at <= ?
    ORDER BY e.start_at ASC
  `).all(windowStart, windowEndInclusive);

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
      p.discord_user_id,
      p.username,
      p.global_name,
      p.alias
    FROM availability_rules r
    INNER JOIN players p ON p.id = r.player_id
    WHERE r.active = 1
    ORDER BY p.id ASC, r.id ASC
  `).all();

  let calendarEvents = [];
  if (tableExists('team_calendar_events')) {
    calendarEvents = db.prepare(`
      SELECT
        id,
        title,
        event_type,
        status,
        start_at,
        end_at,
        meeting_at,
        note
      FROM team_calendar_events
      WHERE start_at >= ?
        AND start_at <= ?
      ORDER BY start_at ASC
    `).all(windowStart, windowEndInclusive);
  }

  const explicitItems = mapExplicitEntries(upcomingEntries);
  const recurringItems = expandRecurringRules(rules, windowDates);

  const mergedAbsenceItems = [...explicitItems, ...recurringItems].sort((a, b) => {
    if (a.sort_key < b.sort_key) return -1;
    if (a.sort_key > b.sort_key) return 1;
    return a.player_name.localeCompare(b.player_name, 'de');
  });

  const dayPosts = buildDailySuggestionPosts(players, upcomingEntries, rules, windowDates);

  const overviewLines = [];
  overviewLines.push('📋 **Wochenplanung – Rohübersicht**');
  overviewLines.push(`Erstellt am: **${new Date().toLocaleString('de-DE', { timeZone: 'Europe/Berlin' })}**`);
  overviewLines.push('');

  overviewLines.push('**Fehlzeiten (nächste 7 Tage)**');
  if (mergedAbsenceItems.length === 0) {
    overviewLines.push('- Keine eingetragenen einmaligen oder regelmäßigen Fehlzeiten.');
  } else {
    for (const item of mergedAbsenceItems) {
      overviewLines.push(item.display_text);
    }
  }

  overviewLines.push('');
  overviewLines.push('**Spielerkalender (nächste 7 Tage)**');
  if (calendarEvents.length === 0) {
    overviewLines.push('- Keine gespeicherten Teamtermine.');
  } else {
    for (const event of calendarEvents) {
      overviewLines.push(formatCalendarEvent(event));
    }
  }

  overviewLines.push('');
  overviewLines.push('➡️ Nächster Schritt: Passende Tagesoptionen prüfen und gewünschte Termine in den Spielerkalender übernehmen.');

  const adminChannel = await client.channels.fetch(process.env.ADMIN_CHANNEL_ID);
  if (!adminChannel || !adminChannel.isTextBased()) {
    return { skipped: false, sent: false, reason: 'invalid_admin_channel' };
  }

  const overviewText = overviewLines.join('\n');
  const messagesToSend = [
    ...splitLongMessage(overviewText),
    ...dayPosts
  ];

  if (dayPosts.length === 0) {
    messagesToSend.push('**Terminoptionen**\nKein gemeinsamer Teamtermin mit allen Spielern in den nächsten 7 Tagen möglich.');
  }

  for (const message of messagesToSend) {
    await adminChannel.send(message);
  }

  return {
    skipped: false,
    sent: true,
    messages: messagesToSend.length,
    explicitCount: explicitItems.length,
    recurringCount: recurringItems.length,
    eventCount: calendarEvents.length,
    dayOptionCount: dayPosts.length
  };
}

module.exports = { runSundayPlanner };