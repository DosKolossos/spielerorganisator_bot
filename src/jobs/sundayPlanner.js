const db = require('../db/database');
const { upsertAdminCardMessage } = require('../commands/spieltermin');
const { displayName, formatRosterGroups, normalizeRosterStatus } = require('../utils/rosterUtils');
const { getTeamById, getDefaultTeam } = require('../services/teamService');

const PLANNER_WINDOW_DAYS = 14;

const SLOT_CONFIG = {
  weekdayStart: '19:30',
  weekendStart: '19:30',
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
  return displayName(row);
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

function getDateWindow(startDate, numberOfDays = PLANNER_WINDOW_DAYS) {
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

    if (blocked) unavailable.push(player);
    else available.push(player);
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

function buildPlayerAvailabilityText(players, slots) {
  const grouped = new Map([
    ['main', { label: 'Main-Line-up', rows: [] }],
    ['sub', { label: 'Subs', rows: [] }],
    ['staff', { label: 'Coaches/Admins', rows: [] }]
  ]);

  for (const player of players) {
    const status = normalizeRosterStatus(player.roster_status);
    if (status === 'inactive') continue;

    const availableStarts = slots
      .filter(slot => slot.available.some(candidate => candidate.id === player.id))
      .map(slot => slot.startTime);

    if (!availableStarts.length) continue;

    const key = status === 'coach' || status === 'admin' ? 'staff' : status;
    const group = grouped.get(key) || grouped.get('sub');
    group.rows.push({
      name: playerDisplay(player),
      windows: compressStartWindows(availableStarts)
    });
  }

  const lines = [];
  for (const group of grouped.values()) {
    if (!group.rows.length) continue;
    lines.push(`**${group.label}:**`);
    for (const row of group.rows.sort((a, b) => a.name.localeCompare(b.name, 'de'))) {
      lines.push(`• ${row.name}: ${row.windows}`);
    }
  }

  return lines.length ? lines.join('\n') : '-';
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
      signature: available.map(playerDisplay).slice().sort((a, b) => a.localeCompare(b, 'de')).join('||'),
      availableCount: available.length,
      mainAvailableCount: available.filter(player => normalizeRosterStatus(player.roster_status) === 'main').length
    });
  }

  if (!slots.length) return null;

  const maxAvailable = Math.max(...slots.map(slot => slot.availableCount));
  const maxMainAvailable = Math.max(...slots.map(slot => slot.mainAvailableCount));
  if (maxAvailable <= 0) return null;

  const bestTotalAmongBestMain = Math.max(
    ...slots
      .filter(candidate => candidate.mainAvailableCount === maxMainAvailable)
      .map(candidate => candidate.availableCount)
  );

  const bestSlots = slots.filter(slot =>
    slot.mainAvailableCount === maxMainAvailable &&
    slot.availableCount === bestTotalAmongBestMain
  );

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
  const playerAvailabilityText = buildPlayerAvailabilityText(players, slots);

  return {
    date: dateStr,
    title: `Terminoption – ${formatDateLongDE(dateStr)}`,
    earliestStart: firstSlot.startTime,
    latestEnd: lastSlot.endTime,
    startWindows: compressStartWindows(chosenGroup.map(slot => slot.startTime)),
    availablePlayers,
    availablePlayersText: playerAvailabilityText,
    suggestionKey: `daily:${dateStr}`,
    windowStartAt: `${dateStr} ${firstSlot.startTime}`,
    windowEndAt: `${dateStr} ${lastSlot.endTime}`
  };
}

function syncSuggestionEvent(suggestion, teamId) {
  const now = new Date().toISOString();
  const defaultMeetingAt = `${suggestion.date} ${addMinutesToTime(suggestion.earliestStart, -15)}`;

  const legacySuggestionKey = suggestion.suggestionKey;
  const suggestionKey = `team:${teamId}:${legacySuggestionKey}`;

  // Ältere Planner-Versionen speicherten nur `daily:YYYY-MM-DD`.
  // Diese Einträge werden übernommen, damit beim Mehrteam-Upgrade keine
  // zweite automatische Terminoption für denselben Tag entsteht.
  const existing = db.prepare(`
    SELECT *
    FROM team_calendar_events
    WHERE team_id = ?
      AND is_auto_generated = 1
      AND option_date = ?
      AND (suggestion_key = ? OR suggestion_key = ?)
    ORDER BY CASE WHEN suggestion_key = ? THEN 0 ELSE 1 END, id DESC
    LIMIT 1
  `).get(teamId, suggestion.date, suggestionKey, legacySuggestionKey, suggestionKey);

  if (!existing) {
    const result = db.prepare(`
      INSERT INTO team_calendar_events (
        team_id,
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
        ?, ?, 'open', 'pending',
        ?, ?, ?, NULL, NULL, NULL, NULL,
        ?, NULL, NULL, ?, 1,
        ?, ?, ?,
        'system', 'system', ?, ?
      )
    `).run(
      teamId,
      suggestion.title,
      suggestion.date,
      suggestion.windowStartAt,
      suggestion.windowEndAt,
      suggestion.availablePlayersText,
      suggestionKey,
      suggestion.windowStartAt,
      suggestion.windowEndAt,
      defaultMeetingAt,
      now,
      now
    );

    return Number(result.lastInsertRowid);
  }

  // Doppelte automatische Alt-Einträge desselben Teams/Tages entfernen.
  // Manuell angelegte oder bereits fixierte Termine bleiben unberührt.
  db.prepare(`
    DELETE FROM team_calendar_events
    WHERE team_id = ?
      AND option_date = ?
      AND is_auto_generated = 1
      AND status = 'pending'
      AND id <> ?
      AND (suggestion_key = ? OR suggestion_key = ?)
  `).run(teamId, suggestion.date, existing.id, suggestionKey, legacySuggestionKey);

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
        suggestion_key = ?,
        option_date = ?,
        window_start_at = ?,
        window_end_at = ?,
        available_players_text = ?,
        start_at = ?,
        end_at = ?,
        meeting_at = COALESCE(meeting_at, ?),
        meeting_scrim_at = COALESCE(meeting_scrim_at, ?),
        meeting_primeleague_at = COALESCE(meeting_primeleague_at, ?),
        is_auto_generated = 1,
        updated_by_discord_user_id = 'system',
        updated_at = ?
      WHERE id = ?
    `).run(
      suggestion.title,
      nextEventType,
      suggestionKey,
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

async function clearPreviousPlannerOverviewMessages(channel) {
  const recentMessages = await channel.messages.fetch({ limit: 100 }).catch(() => null);
  if (!recentMessages) return 0;

  const botUserId = channel.client.user?.id;
  let deleted = 0;

  for (const message of recentMessages.values()) {
    if (!botUserId || message.author?.id !== botUserId) continue;

    const content = String(message.content || '');
    const isPlannerOverview =
      content.includes('📋 **Wochenplanung – Rohübersicht**') ||
      content.includes('**Fehlzeiten (') ||
      content.includes('Grund: Wochen-Check-in:') ||
      content.includes('• [Einmalig •') ||
      content.includes('• [Regelmäßig]') ||
      content.includes('- [Regelmäßig]') ||
      content === '**📅 Termine im Planungszeitraum – chronologisch**' ||
      content === 'Keine Termine im Planungszeitraum gefunden.';

    if (!isPlannerOverview) continue;

    const wasDeleted = await message.delete().then(() => true).catch(() => false);
    if (wasDeleted) deleted++;
  }

  return deleted;
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

function plannerEventTypeLabel(eventType) {
  switch (eventType) {
    case 'primeleague':
      return 'PRM';
    case 'scrim':
      return 'Scrims';
    case 'open':
      return 'Offen';
    case 'flex':
      return 'Flex';
    case 'other':
      return 'Sonstiges';
    default:
      return eventType || 'Unbekannt';
  }
}

function plannerEventTimeLabel(event) {
  const dateTime = event.scheduled_start_at || event.window_start_at;
  if (!dateTime) return 'Zeit offen';

  const time = dateTime.slice(11, 16);
  return `${time} Uhr`;
}

function formatFutureManualEvent(event) {
  const parts = [
    `- ${formatDateLongDE(event.option_date)}`,
    plannerEventTypeLabel(event.event_type),
    event.title
  ];

  const timeLabel = plannerEventTimeLabel(event);
  if (timeLabel !== 'Zeit offen') {
    parts.push(timeLabel);
  }

  let line = parts.join(' • ');

  if (event.note && event.note.trim()) {
    line += ` • Hinweis: ${event.note.trim()}`;
  }

  return line;
}

function plannerEventTypeLabel(eventType) {
  switch (eventType) {
    case 'primeleague':
      return 'PRM';
    case 'scrim':
      return 'Scrims';
    case 'open':
      return 'Offen';
    case 'flex':
      return 'Flex';
    case 'other':
      return 'Sonstiges';
    default:
      return eventType || 'Unbekannt';
  }
}

function plannerEventTimeLabel(event) {
  const dateTime = event.scheduled_start_at || event.window_start_at || null;
  if (!dateTime) return null;
  return `${dateTime.slice(11, 16)} Uhr`;
}

function formatPlannerManualEvent(event, { urgent = false } = {}) {
  const prefix = urgent ? '🚨' : '📌';
  const typeLabel = plannerEventTypeLabel(event.event_type);
  const title = (event.title || '-').trim();
  const timeLabel = plannerEventTimeLabel(event);
  const statusLabel =
    event.status === 'fixed'
      ? 'Fixed'
      : event.status === 'cancelled'
        ? 'Abgesagt'
        : 'Pending';

  let line = `${prefix} **#${event.id} • ${formatDateLongDE(event.option_date)} • ${title}** • ${typeLabel} • ${statusLabel}`;

  if (timeLabel) {
    line += ` • ${timeLabel}`;
  }

  if (event.note && event.note.trim()) {
    line += ` • Hinweis: ${event.note.trim()}`;
  }

  return line;
}

async function runSundayPlanner(client, options = {}) {
  const { force = false } = options;
  const team = options.teamId ? getTeamById(options.teamId) : getDefaultTeam();
  if (!team || !team.is_active) {
    return { skipped: false, sent: false, reason: 'team_not_found' };
  }
  const teamId = team.id;
  const runKey = `${getRunKey()}:team:${teamId}`;

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
  const plannerStartDate = options.startDate || addDaysIso(berlinToday, 1);
  const windowEndDate = options.endDate || addDaysIso(plannerStartDate, PLANNER_WINDOW_DAYS - 1);
  const plannerWindowDays = daysBetweenIso(plannerStartDate, windowEndDate) + 1;

  if (plannerWindowDays <= 0) {
    return { skipped: false, sent: false, reason: 'invalid_date_range', startDate: plannerStartDate, endDate: windowEndDate };
  }

  const windowDates = getDateWindow(plannerStartDate, plannerWindowDays);
  const windowStart = `${plannerStartDate} 00:00`;
  const windowEndInclusive = `${windowEndDate} 23:59`;

  const players = db.prepare(`
    SELECT id, discord_user_id, username, global_name, alias, roster_status, primary_position, secondary_position
    FROM players
    WHERE is_archived = 0
      AND team_id = ?
    ORDER BY id ASC
  `).all(teamId);

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
      p.alias,
      p.roster_status,
      p.primary_position,
      p.secondary_position
    FROM availability_entries e
    INNER JOIN players p ON p.id = e.player_id
    WHERE e.end_at >= ?
      AND e.start_at <= ?
      AND e.approval_status <> 'rejected'
      AND p.is_archived = 0
      AND p.team_id = ?
    ORDER BY e.start_at ASC
  `).all(windowStart, windowEndInclusive, teamId);

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
      p.alias,
      p.roster_status,
      p.primary_position,
      p.secondary_position
    FROM availability_rules r
    INNER JOIN players p ON p.id = r.player_id
    WHERE r.active = 1
      AND p.is_archived = 0
      AND p.team_id = ?
    ORDER BY p.id ASC, r.id ASC
  `).all(teamId);

  const explicitItems = mapExplicitEntries(upcomingEntries);
  const recurringItems = expandRecurringRules(rules, windowDates);

  const mergedAbsenceItems = [...explicitItems, ...recurringItems].sort((a, b) => {
    if (a.sort_key < b.sort_key) return -1;
    if (a.sort_key > b.sort_key) return 1;
    return a.player_name.localeCompare(b.player_name, 'de');
  });

  const suggestions = [];
  const weekEndDate = windowEndDate;

  // Zuerst alle vorhandenen Karten des Zeitraums entfernen. Das ist wichtig
  // für Altbestände, bei denen bereits zwei automatische Datensätze und damit
  // zwei Discord-Nachrichten für denselben Tag existieren.
  await clearCurrentWeekPostedCards(client, teamId, plannerStartDate, weekEndDate);

  for (const dateStr of windowDates) {
    const suggestion = buildDailySuggestion(players, upcomingEntries, rules, dateStr);
    if (!suggestion) continue;

    const calendarId = syncSuggestionEvent(suggestion, teamId);
    suggestions.push({ ...suggestion, calendarId });
  }

  const currentWeekManualEvents = db.prepare(`
  SELECT
    id,
    title,
    event_type,
    status,
    option_date,
    window_start_at,
    scheduled_start_at,
    note
  FROM team_calendar_events
  WHERE team_id = ?
    AND is_auto_generated = 0
    AND status <> 'cancelled'
    AND option_date >= ?
    AND option_date <= ?
  ORDER BY option_date ASC, COALESCE(scheduled_start_at, window_start_at) ASC, id ASC
`).all(teamId, plannerStartDate, weekEndDate);

  const orderedWeekEvents = db.prepare(`
  SELECT
    id,
    option_date,
    COALESCE(scheduled_start_at, window_start_at) AS sort_at,
    is_auto_generated
  FROM team_calendar_events
  WHERE team_id = ?
    AND option_date >= ?
    AND option_date <= ?
    AND status <> 'cancelled'
  ORDER BY
    option_date ASC,
    COALESCE(scheduled_start_at, window_start_at) ASC,
    CASE WHEN is_auto_generated = 0 THEN 0 ELSE 1 END ASC,
    id ASC
`).all(teamId, plannerStartDate, weekEndDate);


  const futureManualEvents = db.prepare(`
  SELECT
    id,
    title,
    event_type,
    status,
    option_date,
    window_start_at,
    scheduled_start_at,
    note
  FROM team_calendar_events
  WHERE team_id = ?
    AND is_auto_generated = 0
    AND status <> 'cancelled'
    AND option_date > ?
  ORDER BY option_date ASC, COALESCE(scheduled_start_at, window_start_at) ASC, id ASC
`).all(teamId, weekEndDate);

  const overviewLines = [];
  overviewLines.push('📋 **Wochenplanung – Rohübersicht**');
  overviewLines.push(`Erstellt am: **${new Date().toLocaleString('de-DE', { timeZone: 'Europe/Berlin' })}**`);
  overviewLines.push('');

  overviewLines.push('**🚨 Bereits eingetragene Termine im Planungszeitraum**');
  if (currentWeekManualEvents.length === 0) {
    overviewLines.push('- Keine bereits eingetragenen manuellen Termine im Planungszeitraum.');
  } else {
    for (const event of currentWeekManualEvents) {
      overviewLines.push(formatPlannerManualEvent(event, { urgent: true }));
    }
  }

  overviewLines.push('');
  overviewLines.push('**Vormerkungen (bereits eingetragene spätere Termine)**');
  if (futureManualEvents.length === 0) {
    overviewLines.push('- Keine späteren fixen oder manuell angelegten Termine vorhanden.');
  } else {
    for (const event of futureManualEvents) {
      overviewLines.push(formatPlannerManualEvent(event));
    }
  }




  const adminChannelId = team.admin_channel_id || (team.is_default ? process.env.ADMIN_CHANNEL_ID : null);
  const adminChannel = adminChannelId ? await client.channels.fetch(adminChannelId) : null;
  if (!adminChannel || !adminChannel.isTextBased()) {
    return { skipped: false, sent: false, reason: 'invalid_admin_channel' };
  }

  await clearPreviousPlannerOverviewMessages(adminChannel);

  const overviewMessages = splitLongMessage(overviewLines.join('\n'));
  for (const message of overviewMessages) {
    await adminChannel.send(message);
  }

  await adminChannel.send('**📅 Termine im Planungszeitraum – chronologisch**');

  if (orderedWeekEvents.length === 0) {
    await adminChannel.send('Keine Termine im Planungszeitraum gefunden.');
  } else {
    for (const event of orderedWeekEvents) {
      await upsertAdminCardMessage(adminChannel, event.id);
    }
  }



  return {
    skipped: false,
    sent: true,
    teamId,
    teamName: team.name,
    startDate: plannerStartDate,
    endDate: windowEndDate,
    windowDays: plannerWindowDays,
    messages: overviewMessages.length + orderedWeekEvents.length + 1,
    absenceCount: mergedAbsenceItems.length,
    suggestionCount: suggestions.length,
    weekEventCount: orderedWeekEvents.length
  };
}

async function clearCurrentWeekPostedCards(client, teamId, weekStartDate, weekEndDate) {
  const events = db.prepare(`
    SELECT
      id,
      admin_channel_id,
      admin_message_id,
      player_channel_id,
      player_message_id
    FROM team_calendar_events
    WHERE team_id = ?
      AND option_date >= ?
      AND option_date <= ?
  `).all(teamId, weekStartDate, weekEndDate);

  for (const event of events) {
    if (event.admin_channel_id && event.admin_message_id) {
      try {
        const channel = await client.channels.fetch(event.admin_channel_id);
        if (channel && channel.isTextBased()) {
          const message = await channel.messages.fetch(event.admin_message_id).catch(() => null);
          if (message) {
            await message.delete().catch(() => null);
          }
        }
      } catch (_) { }
    }

    if (event.player_channel_id && event.player_message_id) {
      try {
        const channel = await client.channels.fetch(event.player_channel_id);
        if (channel && channel.isTextBased()) {
          const message = await channel.messages.fetch(event.player_message_id).catch(() => null);
          if (message) {
            await message.delete().catch(() => null);
          }
        }
      } catch (_) { }
    }

    db.prepare(`
      UPDATE team_calendar_events
      SET admin_channel_id = NULL,
          admin_message_id = NULL,
          player_channel_id = NULL,
          player_message_id = NULL,
          updated_at = ?
      WHERE id = ?
    `).run(new Date().toISOString(), event.id);
  }
}

module.exports = { runSundayPlanner };
