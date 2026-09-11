const EVENT_FORMATS = new Set(['2_games', '3_games', 'bo3', 'bo4', 'bo5']);
const EVENT_TYPES = new Set(['open', 'scrim', 'primeleague', 'training', 'flex', 'other']);
const PLANNER_STATES = new Set(['open', 'preplanned', 'published', 'excluded']);
const EVENT_STATUSES = new Set(['pending', 'planned', 'confirmed', 'scheduled', 'fixed', 'completed', 'cancelled']);
const STARTER_ROLES = ['Top', 'Jgl', 'Mid', 'ADC', 'Supp'];

function addDaysIso(dateStr, amount) {
  const [year, month, day] = dateStr.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day + amount));
  return date.toISOString().slice(0, 10);
}

function mondayOf(dateStr) {
  const safe = /^\d{4}-\d{2}-\d{2}$/.test(String(dateStr || ''))
    ? dateStr
    : new Intl.DateTimeFormat('sv-SE', {
      timeZone: 'Europe/Berlin', year: 'numeric', month: '2-digit', day: '2-digit'
    }).format(new Date());
  const date = new Date(`${safe}T12:00:00Z`);
  const weekday = date.getUTCDay() || 7;
  return addDaysIso(safe, 1 - weekday);
}

function berlinDate(offset = 0) {
  const date = new Date(Date.now() + offset * 86400000);
  return new Intl.DateTimeFormat('sv-SE', {
    timeZone: 'Europe/Berlin', year: 'numeric', month: '2-digit', day: '2-digit'
  }).format(date);
}

function columns(database, table) {
  try {
    return new Set(database.prepare(`PRAGMA table_info(${table})`).all().map(column => column.name));
  } catch (_) {
    return new Set();
  }
}

function json(value, fallback = []) {
  try { return value ? JSON.parse(value) : fallback; } catch (_) { return fallback; }
}

function displayName(player) {
  return player.alias || player.global_name || player.username || player.discord_user_id || `Spieler #${player.id}`;
}

function formatLabel(value) {
  return ({
    '2_games': '2 Spiele', '3_games': '3 Spiele', bo3: 'BO3', bo4: 'BO4', bo5: 'BO5'
  })[value] || '3 Spiele';
}

function availabilityFor(entries, date) {
  const relevant = entries
    .filter(entry => entry.start_at.slice(0, 10) <= date && entry.end_at.slice(0, 10) >= date)
    .map(entry => ({
      start: entry.start_at.slice(0, 10) < date ? '00:00' : entry.start_at.slice(11, 16),
      end: entry.end_at.slice(0, 10) > date ? '23:59' : entry.end_at.slice(11, 16)
    }))
    .sort((a, b) => a.start.localeCompare(b.start));
  if (!relevant.length) return { state: 'available', label: 'Verfügbar' };
  if (relevant.some(entry => entry.start <= '00:01' && entry.end >= '23:58')) {
    return { state: 'unavailable', label: 'Nicht verfügbar' };
  }
  const first = relevant[0];
  const last = relevant[relevant.length - 1];
  if (first.start === '00:00' && last.end === '23:59') {
    if (relevant.length === 2 && first.end <= last.start) {
      return { state: 'partial', label: `Teilweise · ${first.end}–${last.start}`, restriction: `${first.end}–${last.start}` };
    }
    return { state: 'unavailable', label: 'Nicht verfügbar' };
  }
  if (first.start === '00:00') {
    return { state: 'partial', label: `Teilweise · ab ${first.end}`, restriction: `ab ${first.end}` };
  }
  if (last.end === '23:59') {
    return { state: 'partial', label: `Teilweise · bis ${last.start}`, restriction: `bis ${last.start}` };
  }
  return {
    state: 'partial',
    label: `Teilweise · bis ${first.start}, ab ${last.end}`,
    restriction: `bis ${first.start} · ab ${last.end}`
  };
}

function eventTasks(event, assignments, today = berlinDate()) {
  if (event.type === 'open' || event.plannerState === 'open') return [];
  const isPrm = event.type === 'primeleague';
  const isScrim = event.type === 'scrim';
  const isMatch = isPrm || isScrim;
  const beforeDate = addDaysIso(event.date, -1);
  const afterEvent = event.date < today || event.status === 'completed';
  if (today < beforeDate) return [];

  if (isPrm && afterEvent) {
    const missing = [];
    if (!event.opggUrl) missing.push('Gegner-OP.GG fürs Archiv ergänzen');
    if (!event.opponentLineup?.length) missing.push('Gegneraufstellung fürs Archiv ergänzen');
    if (!event.result) missing.push('Ergebnis fürs Archiv ergänzen');
    return missing.length ? [{ level: 'archive', label: missing[0], blocking: false }] : [{ level: 'complete', label: 'Archivdaten vollständig', blocking: false }];
  }

  const required = [
    [!isScrim || Boolean(event.opponent), 'Scrimpartner finden'],
    [!isScrim || Boolean(event.opggUrl), 'Gegner-OP.GG fehlt'],
    [event.type !== 'open', 'Terminart fehlt'],
    [!isMatch || Boolean(event.matchFormat), 'Format fehlt'],
    [!isMatch || STARTER_ROLES.every(role => assignments.some(item => item.role === role && String(item.player || '').trim())), 'Eigene Aufstellung fehlt']
  ];
  if (isScrim) required.push([Boolean(event.drafterUrl), 'Drafter fehlt']);
  const firstMissing = required.find(([complete]) => !complete);
  if (firstMissing) return [{ level: 'warning', label: firstMissing[1], blocking: true }];
  if (isPrm) return [{ level: 'external', label: 'PRM-Drafter wird erst zum Spieltermin freigeschaltet', blocking: false }];
  return [{ level: 'complete', label: 'Termin vollständig', blocking: false }];
}

function buildPlannerSnapshot(client, database, options = {}) {
  const weekStart = mondayOf(options.week);
  const weekEnd = addDaysIso(weekStart, 6);
  const dates = Array.from({ length: 7 }, (_, index) => addDaysIso(weekStart, index));
  const eventColumns = columns(database, 'team_calendar_events');
  const playerColumns = columns(database, 'players');

  const optionalEvent = name => eventColumns.has(name) ? name : `NULL AS ${name}`;
  const teams = database.prepare(`
    SELECT id, name, slug, short_name
    FROM teams WHERE is_active = 1
    ORDER BY is_default DESC, name COLLATE NOCASE ASC
  `).all();
  const events = database.prepare(`
    SELECT id, team_id, title, opponent_name, event_type, status, option_date,
      window_start_at, window_end_at, scheduled_start_at, scheduled_end_at,
      meeting_scrim_at, meeting_primeleague_at, available_players_text, opgg_url,
      note, is_streamed, updated_at,
      ${optionalEvent('planner_state')}, ${optionalEvent('match_format')},
      ${optionalEvent('fearless_mode')}, ${optionalEvent('drafter_url')},
      ${optionalEvent('drafter_opponent_name')}, ${optionalEvent('opponent_lineup_json')},
      ${optionalEvent('result_text')}, ${optionalEvent('show_in_player_calendar')}
    FROM team_calendar_events
    WHERE status NOT IN ('deleted', 'cancelled') AND option_date BETWEEN ? AND ?
    ORDER BY option_date,
      substr(replace(COALESCE(scheduled_start_at, window_start_at), 'T', ' '), 12, 5),
      id
  `).all(weekStart, weekEnd);

  const assignmentColumns = columns(database, 'team_calendar_assignments');
  const assignments = events.length ? database.prepare(`
    SELECT event_id, role_label, player_label, assignee_type,
      ${assignmentColumns.has('player_id') ? 'player_id' : 'NULL AS player_id'},
      ${assignmentColumns.has('standin_id') ? 'standin_id' : 'NULL AS standin_id'}
    FROM team_calendar_assignments
    WHERE event_id IN (${events.map(() => '?').join(',')})
    ORDER BY event_id, role_label
  `).all(...events.map(event => event.id)) : [];
  const assignmentMap = new Map();
  for (const item of assignments) {
    if (!assignmentMap.has(item.event_id)) assignmentMap.set(item.event_id, []);
    assignmentMap.get(item.event_id).push({ role: item.role_label, player: item.player_label, type: item.assignee_type, playerId: item.player_id, standinId: item.standin_id });
  }

  let players = [];
  if (playerColumns.has('team_id')) {
    const optionalPlayer = name => playerColumns.has(name) ? name : `NULL AS ${name}`;
    players = database.prepare(`
      SELECT id, team_id, username, global_name, alias, ${optionalPlayer('discord_user_id')},
        ${optionalPlayer('roster_status')}, ${optionalPlayer('primary_position')},
        ${optionalPlayer('secondary_position')}
      FROM players
      WHERE COALESCE(is_archived, 0) = 0
        ${playerColumns.has('roster_status') ? "AND COALESCE(roster_status, 'sub') IN ('main', 'sub')" : ''}
      ORDER BY ${playerColumns.has('roster_status') ? "CASE COALESCE(roster_status, 'sub') WHEN 'main' THEN 0 ELSE 1 END," : ''}
        COALESCE(alias, global_name, username) COLLATE NOCASE
    `).all();
  }
  const standinColumns = columns(database, 'standins');
  const standins = standinColumns.size ? database.prepare(`
    SELECT id, ${standinColumns.has('team_id') ? 'team_id' : 'NULL AS team_id'},
      display_name, riot_game_name, riot_tag, riot_region, preferred_position
    FROM standins
    WHERE COALESCE(is_active, 1) = 1
      ${standinColumns.has('promoted_to_player_id') ? 'AND promoted_to_player_id IS NULL' : ''}
    ORDER BY display_name COLLATE NOCASE
  `).all() : [];
  const entries = players.length && columns(database, 'availability_entries').size
    ? database.prepare(`
        SELECT player_id, start_at, end_at, reason, updated_at
        FROM availability_entries
        WHERE player_id IN (${players.map(() => '?').join(',')})
          AND end_at >= ? AND start_at <= ?
          AND COALESCE(approval_status, 'approved') = 'approved'
      `).all(...players.map(player => player.id), `${weekStart} 00:00`, `${weekEnd} 23:59`)
    : [];

  const choiceColumns = columns(database, 'weekly_availability_choices');
  const choices = choiceColumns.size
    ? database.prepare(`
        SELECT c.player_id, c.first_date, c.second_date, p.team_id,
          COALESCE(NULLIF(p.alias, ''), NULLIF(p.global_name, ''), p.username) player_name
        FROM weekly_availability_choices c JOIN players p ON p.id = c.player_id
        ${choiceColumns.has('week_start_date') ? 'WHERE c.week_start_date = ?' : 'WHERE c.second_date >= ? AND c.first_date <= ?'}
      `).all(...(choiceColumns.has('week_start_date') ? [weekStart] : [weekStart, weekEnd]))
    : [];

  const normalizedEvents = events.map(event => {
    const lineup = assignmentMap.get(event.id) || [];
    const normalized = {
      id: event.id, teamId: event.team_id, title: event.title,
      opponent: event.opponent_name, type: event.event_type, status: event.status,
      date: event.option_date, startsAt: event.scheduled_start_at || event.window_start_at || `${event.option_date}T12:00:00`,
      endsAt: event.scheduled_end_at || event.window_end_at,
      meetingAt: event.event_type === 'primeleague' ? event.meeting_primeleague_at : event.meeting_scrim_at,
      availability: event.available_players_text, opggUrl: event.opgg_url, note: event.note,
      streamed: Boolean(event.is_streamed), updatedAt: event.updated_at, lineup,
      plannerState: event.planner_state || (event.show_in_player_calendar ? 'published' : 'open'),
      published: Boolean(event.show_in_player_calendar),
      matchFormat: event.match_format || '3_games', formatLabel: formatLabel(event.match_format),
      fearless: event.fearless_mode == null ? true : Boolean(event.fearless_mode),
      drafterUrl: event.drafter_url,
      drafterStale: Boolean(event.drafter_url && event.drafter_opponent_name && event.drafter_opponent_name !== event.opponent_name),
      opponentLineup: json(event.opponent_lineup_json), result: event.result_text,
      eitherOr: choices.filter(choice => choice.team_id === event.team_id && [choice.first_date, choice.second_date].includes(event.option_date))
        .map(choice => ({ player: choice.player_name, playerId: choice.player_id, firstDate: choice.first_date, secondDate: choice.second_date }))
    };
    normalized.tasks = eventTasks(normalized, lineup, options.today || berlinDate());
    return normalized;
  });

  const teamData = teams.map(team => {
    const roster = players.filter(player => player.team_id === team.id).map(player => ({
      id: player.id, name: displayName(player), rosterStatus: player.roster_status || 'sub',
      primaryPosition: player.primary_position, secondaryPosition: player.secondary_position,
      days: Object.fromEntries(dates.map(date => {
        const day = availabilityFor(entries.filter(entry => entry.player_id === player.id), date);
        const choice = choices.find(item => item.player_id === player.id && [item.first_date, item.second_date].includes(date));
        return [date, { ...day, date, eitherOr: choice ? { firstDate: choice.first_date, secondDate: choice.second_date } : null }];
      }))
    }));
    const starters = roster.filter(player => player.rosterStatus === 'main');
    return {
      id: team.id, name: team.name, slug: team.slug, shortName: team.short_name,
      roster, events: normalizedEvents.filter(event => event.teamId === team.id),
      standins: standins.filter(standin => standin.team_id == null || standin.team_id === team.id).map(standin => ({
        id: standin.id, name: standin.display_name, riotId: `${standin.riot_game_name}#${standin.riot_tag}`,
        region: standin.riot_region, preferredPosition: standin.preferred_position
      })),
      fullLineup: Object.fromEntries(dates.map(date => [date,
        starters.length >= 5 && starters.every(player => player.days[date].state === 'available')
      ]))
    };
  });

  const conflicts = [];
  const plannedEvents = normalizedEvents.filter(event => event.type !== 'open' && event.plannerState !== 'open');
  for (const event of plannedEvents) {
    for (const other of plannedEvents) {
      if (other.id <= event.id || other.date !== event.date) continue;
      const duplicate = event.lineup.map(item => item.playerId).filter(Boolean)
        .find(playerId => other.lineup.some(item => item.playerId === playerId));
      if (duplicate) conflicts.push({ eventIds: [event.id, other.id], label: 'Spieler ist am selben Tag doppelt eingeplant' });
    }
    for (const choice of event.eitherOr) {
      const datesAssigned = plannedEvents.filter(item => item.teamId === event.teamId && [choice.firstDate, choice.secondDate].includes(item.date))
        .filter(item => item.lineup.some(slot => slot.playerId === choice.playerId));
      if (datesAssigned.length > 1) conflicts.push({ eventIds: datesAssigned.map(item => item.id), label: `${choice.player} verletzt eine Entweder/oder-Regel` });
    }
  }

  let changes = [];
  if (columns(database, 'planner_change_log').size) {
    changes = database.prepare(`
      SELECT id, team_id teamId, player_id playerId, event_id eventId, change_type type,
        summary, created_at createdAt, acknowledged_at acknowledgedAt
      FROM planner_change_log
      WHERE created_at >= datetime('now', '-14 days')
      ORDER BY created_at DESC LIMIT 50
    `).all();
  }

  return {
    generatedAt: new Date().toISOString(), botOnline: Boolean(client?.isReady?.()), readOnly: false,
    week: { start: weekStart, end: weekEnd, dates, previous: addDaysIso(weekStart, -7), next: addDaysIso(weekStart, 7) },
    teams: teamData, tasks: normalizedEvents.flatMap(event => event.tasks.map(task => ({ ...task, eventId: event.id, teamId: event.teamId, date: event.date, title: event.title }))),
    conflicts, changes
  };
}

function parseBody(request, limit = 100000) {
  return new Promise((resolve, reject) => {
    let raw = '';
    request.setEncoding('utf8');
    request.on('data', chunk => {
      raw += chunk;
      if (raw.length > limit) reject(Object.assign(new Error('payload_too_large'), { status: 413 }));
    });
    request.on('end', () => {
      try { resolve(raw ? JSON.parse(raw) : {}); } catch (_) { reject(Object.assign(new Error('invalid_json'), { status: 400 })); }
    });
    request.on('error', reject);
  });
}

function validateOrigin(request) {
  const origin = request.headers.origin;
  if (!origin) return true;
  const host = request.headers.host;
  try { return new URL(origin).host === host; } catch (_) { return false; }
}

function validDate(value) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(value || ''));
}

function validTime(value) {
  return /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(String(value || ''));
}

function minutesFromTime(value) {
  const [hours, minutes] = value.split(':').map(Number);
  return hours * 60 + minutes;
}

function timeFromMinutes(value) {
  const minutes = ((value % 1440) + 1440) % 1440;
  return `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
}

function scheduleValues(date, startTime, durationMinutes = 180) {
  const endTime = timeFromMinutes(minutesFromTime(startTime) + durationMinutes);
  return {
    option_date: date,
    window_start_at: `${date} ${startTime}`,
    window_end_at: `${date} ${endTime}`,
    scheduled_start_at: `${date} ${startTime}`,
    scheduled_end_at: `${date} ${endTime}`,
    meeting_scrim_at: `${date} ${timeFromMinutes(minutesFromTime(startTime) - 15)}`,
    meeting_primeleague_at: `${date} ${timeFromMinutes(minutesFromTime(startTime) - 30)}`,
    start_at: `${date} ${startTime}`,
    end_at: `${date} ${endTime}`,
    meeting_at: `${date} ${timeFromMinutes(minutesFromTime(startTime) - 15)}`
  };
}

function createEvent(database, body, actorId) {
  const teamId = Number(body.teamId);
  const team = Number.isSafeInteger(teamId)
    ? database.prepare('SELECT id FROM teams WHERE id = ? AND is_active = 1').get(teamId)
    : null;
  if (!team) throw Object.assign(new Error('invalid_team'), { status: 400 });
  const date = String(body.date || '');
  const startTime = String(body.startTime || '19:00');
  if (!validDate(date) || !validTime(startTime)) throw Object.assign(new Error('invalid_schedule'), { status: 400 });
  const type = EVENT_TYPES.has(body.type) && body.type !== 'open' ? body.type : 'scrim';
  const status = EVENT_STATUSES.has(body.status) ? body.status : 'pending';
  const plannerState = PLANNER_STATES.has(body.plannerState) && body.plannerState !== 'open' ? body.plannerState : 'preplanned';
  const title = String(body.title || '').trim().slice(0, 120)
    || ({ scrim: 'Scrim', primeleague: 'Prime League', training: 'Training', flex: 'Flex', other: 'Termin' })[type];
  const now = new Date().toISOString();
  const schedule = scheduleValues(date, startTime);
  const result = database.prepare(`
    INSERT INTO team_calendar_events (
      team_id, title, opponent_name, event_type, status, option_date,
      window_start_at, window_end_at, scheduled_start_at, scheduled_end_at,
      meeting_scrim_at, meeting_primeleague_at, available_players_text,
      opgg_url, note, is_auto_generated, admin_card_collapsed,
      show_in_player_calendar, planner_state, match_format, fearless_mode,
      drafter_url, opponent_lineup_json, result_text, is_streamed,
      start_at, end_at, meeting_at, created_by_discord_user_id,
      updated_by_discord_user_id, created_at, updated_at
    ) VALUES (
      ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL,
      ?, ?, 0, 1, 0, ?, ?, ?, ?, ?, ?, 0,
      ?, ?, ?, ?, ?, ?, ?
    )
  `).run(
    teamId, title, String(body.opponent || '').trim().slice(0, 120) || null, type, status,
    schedule.option_date, schedule.window_start_at, schedule.window_end_at,
    schedule.scheduled_start_at, schedule.scheduled_end_at, schedule.meeting_scrim_at,
    schedule.meeting_primeleague_at, String(body.opggUrl || '').trim().slice(0, 500) || null,
    String(body.note || '').trim().slice(0, 1500) || null, plannerState,
    EVENT_FORMATS.has(body.matchFormat) ? body.matchFormat : '3_games', body.fearless === false ? 0 : 1,
    String(body.drafterUrl || '').trim().slice(0, 500) || null,
    JSON.stringify(Array.isArray(body.opponentLineup) ? body.opponentLineup.slice(0, 5) : []),
    String(body.result || '').trim().slice(0, 500) || null,
    schedule.start_at, schedule.end_at, schedule.meeting_at, actorId, actorId, now, now
  );
  const eventId = Number(result.lastInsertRowid);
  try {
    return updateEvent(database, eventId, { ...body, title }, actorId);
  } catch (error) {
    database.prepare('DELETE FROM team_calendar_assignments WHERE event_id = ?').run(eventId);
    database.prepare('DELETE FROM team_calendar_events WHERE id = ?').run(eventId);
    throw error;
  }
}

function updateEvent(database, eventId, body, actorId) {
  const current = database.prepare('SELECT * FROM team_calendar_events WHERE id = ?').get(eventId);
  if (!current) throw Object.assign(new Error('event_not_found'), { status: 404 });
  if (current.event_type === 'open' || current.planner_state === 'open') {
    throw Object.assign(new Error('event_not_editable'), { status: 409 });
  }
  const values = {};
  const textFields = {
    title: 'title', opponent: 'opponent_name', opggUrl: 'opgg_url', note: 'note',
    result: 'result_text', drafterUrl: 'drafter_url'
  };
  for (const [input, column] of Object.entries(textFields)) {
    if (Object.hasOwn(body, input)) values[column] = String(body[input] || '').trim().slice(0, input === 'note' ? 1500 : 500) || null;
  }
  if (Object.hasOwn(body, 'type')) {
    if (!EVENT_TYPES.has(body.type)) throw Object.assign(new Error('invalid_event_type'), { status: 400 });
    values.event_type = body.type;
  }
  if (Object.hasOwn(body, 'status')) {
    if (!EVENT_STATUSES.has(body.status)) throw Object.assign(new Error('invalid_event_status'), { status: 400 });
    values.status = body.status;
  }
  if (Object.hasOwn(body, 'plannerState')) {
    if (!PLANNER_STATES.has(body.plannerState)) throw Object.assign(new Error('invalid_planner_state'), { status: 400 });
    values.planner_state = body.plannerState;
  }
  if (Object.hasOwn(body, 'matchFormat')) {
    if (!EVENT_FORMATS.has(body.matchFormat)) throw Object.assign(new Error('invalid_match_format'), { status: 400 });
    values.match_format = body.matchFormat;
  }
  if (Object.hasOwn(body, 'fearless')) values.fearless_mode = body.fearless ? 1 : 0;
  if (Object.hasOwn(body, 'date') || Object.hasOwn(body, 'startTime')) {
    const date = Object.hasOwn(body, 'date') ? String(body.date || '') : current.option_date;
    const currentStart = String(current.scheduled_start_at || current.window_start_at || '').slice(11, 16) || '19:00';
    const startTime = Object.hasOwn(body, 'startTime') ? String(body.startTime || '') : currentStart;
    if (!validDate(date) || !validTime(startTime)) throw Object.assign(new Error('invalid_schedule'), { status: 400 });
    const currentEnd = String(current.scheduled_end_at || current.window_end_at || '').slice(11, 16);
    const duration = validTime(currentEnd)
      ? Math.max(30, minutesFromTime(currentEnd) - minutesFromTime(currentStart))
      : 180;
    Object.assign(values, scheduleValues(date, startTime, duration));
  }
  if (Object.hasOwn(body, 'opponentLineup')) {
    const lineup = Array.isArray(body.opponentLineup) ? body.opponentLineup.slice(0, 5) : [];
    values.opponent_lineup_json = JSON.stringify(lineup.map(item => ({ role: String(item.role || '').slice(0, 20), player: String(item.player || '').slice(0, 100) })));
  }
  if (Object.hasOwn(body, 'lineup')) {
    if (!Array.isArray(body.lineup)) throw Object.assign(new Error('invalid_lineup'), { status: 400 });
    const requested = new Map();
    for (const item of body.lineup) {
      const role = String(item?.role || '');
      if (!STARTER_ROLES.includes(role) || requested.has(role)) {
        throw Object.assign(new Error('invalid_lineup'), { status: 400 });
      }
      requested.set(role, item);
    }

    const selectedIds = [...requested.values()]
      .filter(item => !item.preserve && item.playerId != null && item.playerId !== '')
      .map(item => Number(item.playerId));
    if (selectedIds.some(id => !Number.isSafeInteger(id) || id <= 0) || new Set(selectedIds).size !== selectedIds.length) {
      throw Object.assign(new Error('invalid_lineup'), { status: 400 });
    }
    const selectedStandinIds = [...requested.values()]
      .filter(item => !item.preserve && item.standinId != null && item.standinId !== '')
      .map(item => Number(item.standinId));
    if (selectedStandinIds.some(id => !Number.isSafeInteger(id) || id <= 0) || new Set(selectedStandinIds).size !== selectedStandinIds.length) {
      throw Object.assign(new Error('invalid_lineup'), { status: 400 });
    }

    const selectedPlayers = new Map();
    if (selectedIds.length) {
      const rows = database.prepare(`
        SELECT id, team_id, alias, global_name, username, discord_user_id
        FROM players
        WHERE id IN (${selectedIds.map(() => '?').join(',')})
          AND COALESCE(is_archived, 0) = 0
      `).all(...selectedIds);
      for (const player of rows) selectedPlayers.set(player.id, player);
      if (selectedIds.some(id => selectedPlayers.get(id)?.team_id !== current.team_id)) {
        throw Object.assign(new Error('lineup_player_not_in_team'), { status: 400 });
      }
    }
    const selectedStandins = new Map();
    if (selectedStandinIds.length) {
      const standinColumns = columns(database, 'standins');
      if (!standinColumns.size) throw Object.assign(new Error('invalid_lineup'), { status: 400 });
      const rows = database.prepare(`
        SELECT id, display_name, ${standinColumns.has('team_id') ? 'team_id' : 'NULL AS team_id'}
        FROM standins
        WHERE id IN (${selectedStandinIds.map(() => '?').join(',')})
          AND COALESCE(is_active, 1) = 1
      `).all(...selectedStandinIds);
      for (const standin of rows) selectedStandins.set(standin.id, standin);
      if (selectedStandinIds.some(id => {
        const standin = selectedStandins.get(id);
        return !standin || (standin.team_id != null && standin.team_id !== current.team_id);
      })) throw Object.assign(new Error('lineup_standin_not_in_team'), { status: 400 });
    }

    const now = new Date().toISOString();
    const saveLineup = () => {
      const remove = database.prepare(`DELETE FROM team_calendar_assignments WHERE event_id = ? AND role_label = ?`);
      const upsert = database.prepare(`
        INSERT INTO team_calendar_assignments (
          event_id, role_label, player_label, assignee_type,
          player_id, standin_id, note, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?)
        ON CONFLICT(event_id, role_label) DO UPDATE SET
          player_label = excluded.player_label,
          assignee_type = excluded.assignee_type,
          player_id = excluded.player_id,
          standin_id = excluded.standin_id,
          note = NULL,
          updated_at = excluded.updated_at
      `);
      for (const role of STARTER_ROLES) {
        const item = requested.get(role);
        if (item?.preserve) continue;
        const playerId = item?.playerId == null || item.playerId === '' ? null : Number(item.playerId);
        const standinId = item?.standinId == null || item.standinId === '' ? null : Number(item.standinId);
        if (!playerId && !standinId) {
          remove.run(eventId, role);
          continue;
        }
        const candidate = playerId ? selectedPlayers.get(playerId) : selectedStandins.get(standinId);
        const label = playerId ? displayName(candidate) : candidate.display_name;
        upsert.run(eventId, role, label, playerId ? 'player' : 'standin', playerId, standinId, now, now);
      }
    };
    if (typeof database.transaction === 'function') database.transaction(saveLineup)();
    else {
      database.exec('BEGIN');
      try { saveLineup(); database.exec('COMMIT'); } catch (error) { database.exec('ROLLBACK'); throw error; }
    }
  }
  if (Object.hasOwn(body, 'opponent') && String(current.opponent_name || '') !== String(body.opponent || '')) {
    values.drafter_opponent_name = current.drafter_url ? current.drafter_opponent_name : null;
  }
  values.updated_by_discord_user_id = actorId;
  values.updated_at = new Date().toISOString();
  const pairs = Object.keys(values);
  if (!pairs.length) return current;
  database.prepare(`UPDATE team_calendar_events SET ${pairs.map(key => `${key} = ?`).join(', ')} WHERE id = ?`)
    .run(...pairs.map(key => values[key]), eventId);
  return database.prepare('SELECT * FROM team_calendar_events WHERE id = ?').get(eventId);
}

function createStandin(database, body, actorId) {
  const teamId = Number(body.teamId);
  const displayNameValue = String(body.displayName || '').trim();
  const riotGameName = String(body.riotGameName || '').trim();
  const riotTag = String(body.riotTag || '').trim().replace(/^#/, '').toUpperCase();
  const riotRegion = String(body.riotRegion || 'euw').trim().toLowerCase();
  const preferredPosition = String(body.preferredPosition || '').trim() || null;
  if (!Number.isSafeInteger(teamId) || !database.prepare('SELECT id FROM teams WHERE id = ? AND is_active = 1').get(teamId)) {
    throw Object.assign(new Error('invalid_team'), { status: 400 });
  }
  if (displayNameValue.length < 2 || displayNameValue.length > 64 || riotGameName.length < 2 || riotGameName.length > 32 || riotTag.length < 2 || riotTag.length > 10) {
    throw Object.assign(new Error('invalid_standin'), { status: 400 });
  }
  if (preferredPosition && !STARTER_ROLES.includes(preferredPosition)) {
    throw Object.assign(new Error('invalid_standin_position'), { status: 400 });
  }
  const existing = database.prepare(`
    SELECT id FROM standins
    WHERE lower(riot_game_name) = lower(?) AND lower(riot_tag) = lower(?) AND lower(riot_region) = lower(?)
    LIMIT 1
  `).get(riotGameName, riotTag, riotRegion);
  if (existing) throw Object.assign(new Error('standin_already_exists'), { status: 409 });
  const now = new Date().toISOString();
  const result = database.prepare(`
    INSERT INTO standins (
      display_name, riot_game_name, riot_tag, riot_region, preferred_position,
      note, is_active, team_id, created_by_discord_user_id,
      updated_by_discord_user_id, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, NULL, 1, ?, ?, ?, ?, ?)
  `).run(displayNameValue, riotGameName, riotTag, riotRegion, preferredPosition, teamId, actorId, actorId, now, now);
  return {
    id: Number(result.lastInsertRowid), teamId, name: displayNameValue,
    riotId: `${riotGameName}#${riotTag}`, region: riotRegion, preferredPosition
  };
}

function exportPreview(database, week) {
  const start = mondayOf(week);
  const end = addDaysIso(start, 6);
  const rows = database.prepare(`
    SELECT id, title, option_date, event_type, planner_state, show_in_player_calendar
    FROM team_calendar_events
    WHERE option_date BETWEEN ? AND ? AND status NOT IN ('cancelled', 'deleted')
  `).all(start, end);
  const publish = rows.filter(row => row.event_type !== 'open' && row.planner_state === 'preplanned' && !row.show_in_player_calendar);
  const update = rows.filter(row => row.event_type !== 'open' && row.planner_state === 'preplanned' && row.show_in_player_calendar);
  const remove = rows.filter(row => ['open', 'excluded'].includes(row.planner_state) && row.show_in_player_calendar);
  return { weekStart: start, publish, update, remove, total: publish.length + update.length + remove.length };
}

async function exportWeek(client, database, week, actorId, refreshImpl) {
  const preview = exportPreview(database, week);
  const ids = [...preview.publish, ...preview.update, ...preview.remove].map(row => row.id);
  if (!ids.length) return { ...preview, exportId: null };
  const before = database.prepare(`SELECT id, planner_state, show_in_player_calendar FROM team_calendar_events WHERE id IN (${ids.map(() => '?').join(',')})`).all(...ids);
  const now = new Date().toISOString();
  const transaction = database.transaction(() => {
    for (const row of [...preview.publish, ...preview.update]) {
      database.prepare(`UPDATE team_calendar_events SET planner_state = 'published', show_in_player_calendar = 1, last_exported_at = ?, updated_at = ?, updated_by_discord_user_id = ? WHERE id = ?`)
        .run(now, now, actorId, row.id);
    }
    for (const row of preview.remove) {
      database.prepare(`UPDATE team_calendar_events SET show_in_player_calendar = 0, last_exported_at = ?, updated_at = ?, updated_by_discord_user_id = ? WHERE id = ?`)
        .run(now, now, actorId, row.id);
    }
    return database.prepare(`INSERT INTO planner_exports (week_start_date, actor_discord_user_id, changes_json, created_at) VALUES (?, ?, ?, ?)`)
      .run(preview.weekStart, actorId, JSON.stringify(before), now).lastInsertRowid;
  });
  const exportId = transaction();
  const refreshStoredEventCard = refreshImpl || require('../commands/spieltermin').refreshStoredEventCard;
  const syncErrors = [];
  for (const id of ids) {
    try { await refreshStoredEventCard(client, id); } catch (error) { syncErrors.push({ id, error: error.message }); }
  }
  return { ...preview, exportId, syncErrors };
}

async function undoExport(client, database, week, actorId, refreshImpl) {
  const start = mondayOf(week);
  const record = database.prepare(`SELECT * FROM planner_exports WHERE week_start_date = ? AND reverted_at IS NULL ORDER BY id DESC LIMIT 1`).get(start);
  if (!record) throw Object.assign(new Error('no_export_to_undo'), { status: 404 });
  const changes = json(record.changes_json);
  const now = new Date().toISOString();
  const transaction = database.transaction(() => {
    for (const item of changes) {
      database.prepare(`UPDATE team_calendar_events SET planner_state = ?, show_in_player_calendar = ?, updated_at = ?, updated_by_discord_user_id = ? WHERE id = ?`)
        .run(item.planner_state, item.show_in_player_calendar, now, actorId, item.id);
    }
    database.prepare(`UPDATE planner_exports SET reverted_at = ?, reverted_by_discord_user_id = ? WHERE id = ?`).run(now, actorId, record.id);
  });
  transaction();
  const refreshStoredEventCard = refreshImpl || require('../commands/spieltermin').refreshStoredEventCard;
  const syncErrors = [];
  for (const item of changes) {
    try { await refreshStoredEventCard(client, item.id); } catch (error) { syncErrors.push({ id: item.id, error: error.message }); }
  }
  return { exportId: record.id, restored: changes.length, syncErrors };
}

function shiftDateTime(value, days) {
  if (!value) return null;
  return `${addDaysIso(String(value).slice(0, 10), days)}${String(value).slice(10)}`;
}

function copyPreviousWeek(database, week, actorId) {
  const targetStart = mondayOf(week);
  const targetEnd = addDaysIso(targetStart, 6);
  const sourceStart = addDaysIso(targetStart, -7);
  const sourceEnd = addDaysIso(targetStart, -1);
  const targetCount = database.prepare(`
    SELECT count(*) count FROM team_calendar_events
    WHERE option_date BETWEEN ? AND ? AND status NOT IN ('cancelled', 'deleted')
  `).get(targetStart, targetEnd).count;
  if (targetCount) throw Object.assign(new Error('target_week_not_empty'), { status: 409 });
  const source = database.prepare(`
    SELECT * FROM team_calendar_events
    WHERE option_date BETWEEN ? AND ? AND status NOT IN ('cancelled', 'deleted')
    ORDER BY option_date, id
  `).all(sourceStart, sourceEnd);
  if (!source.length) throw Object.assign(new Error('source_week_empty'), { status: 404 });
  const now = new Date().toISOString();
  const insert = database.prepare(`
    INSERT INTO team_calendar_events (
      team_id, title, opponent_name, event_type, status, option_date,
      window_start_at, window_end_at, scheduled_start_at, scheduled_end_at,
      meeting_scrim_at, meeting_primeleague_at, available_players_text,
      opgg_url, note, is_auto_generated, admin_card_collapsed,
      show_in_player_calendar, planner_state, match_format, fearless_mode,
      drafter_url, drafter_opponent_name, opponent_lineup_json, result_text,
      is_streamed, start_at, end_at, meeting_at,
      created_by_discord_user_id, updated_by_discord_user_id, created_at, updated_at
    ) VALUES (
      ?, ?, NULL, ?, 'pending', ?, ?, ?, ?, ?, ?, ?, NULL,
      NULL, ?, 0, 1, 0, 'preplanned', ?, ?, NULL, NULL, NULL, NULL,
      ?, ?, ?, ?, ?, ?, ?, ?
    )
  `);
  const transaction = database.transaction(() => source.map(event => Number(insert.run(
    event.team_id, event.title, event.event_type, shiftDateTime(event.option_date, 7),
    shiftDateTime(event.window_start_at, 7), shiftDateTime(event.window_end_at, 7),
    shiftDateTime(event.scheduled_start_at, 7), shiftDateTime(event.scheduled_end_at, 7),
    shiftDateTime(event.meeting_scrim_at, 7), shiftDateTime(event.meeting_primeleague_at, 7),
    event.note, event.match_format || '3_games', event.fearless_mode == null ? 1 : event.fearless_mode,
    event.is_streamed || 0, shiftDateTime(event.start_at, 7), shiftDateTime(event.end_at, 7),
    shiftDateTime(event.meeting_at, 7), actorId, actorId, now, now
  ).lastInsertRowid)));
  return { copied: transaction(), sourceStart, targetStart };
}

module.exports = {
  buildPlannerSnapshot, parseBody, validateOrigin, updateEvent, exportPreview,
  exportWeek, undoExport, copyPreviousWeek, createStandin, createEvent, mondayOf, addDaysIso
};
