const db = require('../db/database');
const { upsertAdminCardMessage, upsertPublicCardMessage, getPlayerCalendarChannelId } = require('../commands/spieltermin');

const SLOT_CONFIG = {
  weekdayStart: '17:00',
  weekendStart: '15:00',
  dayEnd: '23:00',
  minDurationMinutes: 150,
  slotStepMinutes: 30
};

function todayInBerlin() {
  return new Intl.DateTimeFormat('sv-SE', {
    timeZone: 'Europe/Berlin',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).format(new Date());
}

function getRunKey() {
  return todayInBerlin();
}

function tryAcquireJobRun(jobName, runKey) {
  const now = new Date().toISOString();

  const result = db.prepare(`
    INSERT OR IGNORE INTO job_runs (job_name, run_key, created_at)
    VALUES (?, ?, ?)
  `).run(jobName, `${jobName}:${runKey}`, now);

  return result.changes > 0;
}

function playerDisplay(row) {
  return row.alias || row.global_name || row.username || row.discord_user_id;
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
  const safe = Math.max(0, minutes);
  const hours = String(Math.floor(safe / 60)).padStart(2, '0');
  const mins = String(safe % 60).padStart(2, '0');
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

function recurringDetail(rule) {
  if (rule.rule_type === 'nicht_verfuegbar') return 'ganztägig nicht verfügbar';
  if (rule.rule_type === 'erst_ab') return `bis ${rule.time_value} nicht verfügbar`;
  if (rule.rule_type === 'bis') return `ab ${rule.time_value} nicht verfügbar`;
  return rule.rule_type;
}

function recurringSortKey(rule, dateStr) {
  if (rule.rule_type === 'nicht_verfuegbar' || rule.rule_type === 'erst_ab') return `${dateStr} 00:00`;
  if (rule.rule_type === 'bis') return `${dateStr} ${rule.time_value ?? '23:59'}`;
  return `${dateStr} 00:00`;
}

function expandRecurringRules(rules, windowDates) {
  const items = [];

  for (const rule of rules) {
    for (const dateStr of windowDates) {
      if (!matchesRuleOnDate(rule, dateStr)) continue;

      items.push({
        sort_key: recurringSortKey(rule, dateStr),
        player_name: playerDisplay(rule),
        display_text:
          `- ${playerDisplay(rule)} • [Regelmäßig] ${formatDateDE(dateStr)} • ` +
          `${recurringDetail(rule)} • Start: ${formatDateDE(rule.anchor_date ?? dateStr)} • Notiz: ${rule.note ?? '-'}`
      });
    }
  }

  return items;
}

function mapExplicitEntries(entries) {
  return entries.map(entry => {
    const typeLabel = entry.entry_type === 'vacation' ? 'Urlaub' : 'Abwesenheit';
    const statusLabel = entry.approval_status === 'pending_admin' ? ' • Status: wartet auf Freigabe' : '';

    return {
      sort_key: entry.start_at,
      player_name: playerDisplay(entry),
      display_text:
        `- ${playerDisplay(entry)} • [Einmalig • ${typeLabel}] ${formatEntryRange(entry.start_at, entry.end_at)} • ` +
        `Grund: ${entry.reason ?? '-'}${statusLabel}`
    };
  });
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

function getUnavailablePlayersForSlot(players, explicitEntries, rules, dateStr, slotStartAt, slotEndAt) {
  const unavailable = [];
  const available = [];

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

    if (blocked) unavailable.push(playerDisplay(player));
    else available.push(playerDisplay(player));
  }

  return { unavailable, available };
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
      const rangeEnd = end + SLOT_CONFIG.minDurationMinutes;
      return `${minutesToTime(start)}–${minutesToTime(rangeEnd)} Uhr`;
    })
    .join(', ');
}

function buildDailySuggestion(players, explicitEntries, rules, dateStr) {
  const startTimes = getCandidateStartTimesForDate(dateStr);
  const slots = [];

  for (const startTime of startTimes) {
    const endTime = addMinutesToTime(startTime, SLOT_CONFIG.minDurationMinutes);
    const slotStartAt = buildDateTime(dateStr, startTime);
    const slotEndAt = buildDateTime(dateStr, endTime);

    const { unavailable, available } = getUnavailablePlayersForSlot(
      players,
      explicitEntries,
      rules,
      dateStr,
      slotStartAt,
      slotEndAt
    );

    slots.push({
      startTime,
      endTime,
      available,
      unavailable,
      signature: available.slice().sort((a, b) => a.localeCompare(b, 'de')).join('||'),
      availableCount: available.length
    });
  }

  if (!slots.length) return null;

  const maxAvailable = Math.max(...slots.map(slot => slot.availableCount));
  if (maxAvailable <= 0) return null;

  const bestSlots = slots.filter(slot => slot.availableCount === maxAvailable);

  const grouped = new Map();
  for (const slot of bestSlots) {
    if (!grouped.has(slot.signature)) {
      grouped.set(slot.signature, []);
    }
    grouped.get(slot.signature).push(slot);
  }

  const chosenGroup = [...grouped.values()].sort((a, b) => {
    if (b.length !== a.length) return b.length - a.length;
    return a[0].startTime.localeCompare(b[0].startTime);
  })[0];

  const availablePlayers = chosenGroup[0].available;
  const firstSlot = chosenGroup[0];
  const lastSlot = chosenGroup[chosenGroup.length - 1];

  return {
    date: dateStr,
    title: `Terminoption – ${formatDateLongDE(dateStr)}`,
    earliestStart: firstSlot.startTime,
    latestEnd: lastSlot.endTime,
    startWindows: compressStartWindows(chosenGroup.map(slot => slot.startTime)),
    availablePlayers,
    availablePlayersText: availablePlayers.join(', '),
    suggestionKey: `daily:${dateStr}`,
    windowStartAt: `${dateStr} ${firstSlot.startTime}`,
    windowEndAt: `${dateStr} ${lastSlot.endTime}`
  };
}

function syncSuggestionEvent(suggestion) {
  const now = new Date().toISOString();
  const defaultMeetingScrimAt = `${suggestion.date} ${addMinutesToTime(suggestion.earliestStart, -15)}`;
  const defaultMeetingPrimeleagueAt = `${suggestion.date} ${addMinutesToTime(suggestion.earliestStart, -30)}`;

  const existing = db.prepare(`
    SELECT *
    FROM team_calendar_events
    WHERE suggestion_key = ?
    LIMIT 1
  `).get(suggestion.suggestionKey);

  if (!existing) {
    const result = db.prepare(`
      INSERT INTO team_calendar_events (
        title,
        event_type,
        status,
        option_date,
        window_start_at,
        window_end_at,
        scheduled_start_at,
        scheduled_end_at,
        meeting_scrim_at,
        meeting_primeleague_at,
        available_players_text,
        opgg_url,
        note,
        suggestion_key,
        is_auto_generated,
        start_at,
        end_at,
        meeting_at,
        created_by_discord_user_id,
        updated_by_discord_user_id,
        created_at,
        updated_at
      )
      VALUES (
        ?, 'open', 'pending',
        ?, ?, ?, NULL, NULL, ?, ?, 
        ?, NULL, NULL, ?, 1,
        ?, ?, ?,
        'system', 'system', ?, ?
      )
    `).run(
      suggestion.title,
      suggestion.date,
      suggestion.windowStartAt,
      suggestion.windowEndAt,
      defaultMeetingScrimAt,
      defaultMeetingPrimeleagueAt,
      suggestion.availablePlayersText,
      suggestion.suggestionKey,
      suggestion.windowStartAt,
      suggestion.windowEndAt,
      defaultMeetingScrimAt,
      now,
      now
    );

    return Number(result.lastInsertRowid);
  }

  if (existing.is_auto_generated === 1 && existing.status === 'pending') {
    const nextEventType =
      existing.updated_by_discord_user_id === 'system' && (!existing.event_type || existing.event_type === 'scrim')
        ? 'open'
        : existing.event_type;

    db.prepare(`
      UPDATE team_calendar_events
      SET
        title = ?,
        event_type = ?,
        option_date = ?,
        window_start_at = ?,
        window_end_at = ?,
        available_players_text = ?,
        start_at = ?,
        end_at = ?,
        meeting_at = COALESCE(meeting_at, ?),
        meeting_scrim_at = CASE
          WHEN COALESCE(meeting_scrim_manual, 0) = 1 THEN meeting_scrim_at
          ELSE COALESCE(meeting_scrim_at, ?)
        END,
        meeting_primeleague_at = CASE
          WHEN COALESCE(meeting_primeleague_manual, 0) = 1 THEN meeting_primeleague_at
          ELSE COALESCE(meeting_primeleague_at, ?)
        END,
        is_auto_generated = 1,
        updated_by_discord_user_id = 'system',
        updated_at = ?
      WHERE id = ?
    `).run(
      suggestion.title,
      nextEventType,
      suggestion.date,
      suggestion.windowStartAt,
      suggestion.windowEndAt,
      suggestion.availablePlayersText,
      suggestion.windowStartAt,
      suggestion.windowEndAt,
      defaultMeetingAt,
      defaultMeetingAt,
      `${suggestion.date} ${addMinutesToTime(suggestion.earliestStart, -30)}`,
      now,
      existing.id
    );
  }

  return existing.id;
}

function splitLongMessage(text, maxLength = 1900) {
  if (text.length <= maxLength) return [text];

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

  const players = db.prepare(`
    SELECT id, discord_user_id, username, global_name, alias
    FROM players
    WHERE is_archived = 0
    ORDER BY id ASC
  `).all();

  const upcomingEntries = db.prepare(`
    SELECT
      e.id,
      e.player_id,
      e.entry_type,
      e.start_at,
      e.end_at,
      e.reason,
      e.approval_status,
      p.discord_user_id,
      p.username,
      p.global_name,
      p.alias
    FROM availability_entries e
    INNER JOIN players p ON p.id = e.player_id
    WHERE e.end_at >= ?
      AND e.start_at <= ?
      AND e.approval_status <> 'rejected'
      AND p.is_archived = 0
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
      r.suspended_from,
      r.suspended_until,
      p.discord_user_id,
      p.username,
      p.global_name,
      p.alias
    FROM availability_rules r
    INNER JOIN players p ON p.id = r.player_id
    WHERE r.active = 1
      AND p.is_archived = 0
    ORDER BY p.id ASC, r.id ASC
  `).all();

  const explicitItems = mapExplicitEntries(upcomingEntries);
  const recurringItems = expandRecurringRules(rules, windowDates);

  const mergedAbsenceItems = [...explicitItems, ...recurringItems].sort((a, b) => {
    if (a.sort_key < b.sort_key) return -1;
    if (a.sort_key > b.sort_key) return 1;
    return a.player_name.localeCompare(b.player_name, 'de');
  });

  const suggestions = [];

  for (const dateStr of windowDates) {
    const suggestion = buildDailySuggestion(players, upcomingEntries, rules, dateStr);
    if (!suggestion) continue;

    const calendarId = syncSuggestionEvent(suggestion);
    suggestions.push({ ...suggestion, calendarId });
  }

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
  overviewLines.push('➡️ Nächster Schritt: Karte prüfen und dann direkt über die Buttons Status, Aufstellung, Gegner-OPGG oder Hinweis bearbeiten.');

  const adminChannel = await client.channels.fetch(process.env.ADMIN_CHANNEL_ID);
  if (!adminChannel || !adminChannel.isTextBased()) {
    return { skipped: false, sent: false, reason: 'invalid_admin_channel' };
  }

  let publicChannel = null;
  const publicChannelId = getPlayerCalendarChannelId();
  if (publicChannelId) {
    try {
      const fetchedPublicChannel = await client.channels.fetch(publicChannelId);
      if (fetchedPublicChannel && fetchedPublicChannel.isTextBased()) {
        publicChannel = fetchedPublicChannel;
      }
    } catch (error) {
      console.warn('[Planner] Spielerkalender-Kanal konnte nicht geladen werden:', error);
    }
  }

  const overviewMessages = splitLongMessage(overviewLines.join('\n'));
  for (const message of overviewMessages) {
    await adminChannel.send(message);
  }

  if (suggestions.length === 0) {
    await adminChannel.send('**Terminoptionen**\nKein passender Tagesvorschlag in den nächsten 7 Tagen gefunden.');
  } else {
    for (const item of suggestions) {
      await upsertAdminCardMessage(adminChannel, item.calendarId);
      if (publicChannel) {
        await upsertPublicCardMessage(publicChannel, item.calendarId);
      }
    }
  }

  return {
    skipped: false,
    sent: true,
    messages: overviewMessages.length + suggestions.length + (publicChannel ? suggestions.length : 0),
    absenceCount: mergedAbsenceItems.length,
    suggestionCount: suggestions.length,
    mirroredToPlayerCalendar: Boolean(publicChannel)
  };
}

module.exports = { runSundayPlanner };
