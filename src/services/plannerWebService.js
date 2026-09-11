const EVENT_FORMATS = new Set(['2_games', '3_games', 'bo3', 'bo4', 'bo5']);
const EVENT_TYPES = new Set(['open', 'scrim', 'primeleague', 'training', 'flex', 'other']);
const PLANNER_STATES = new Set(['open', 'preplanned', 'published', 'excluded']);
const EVENT_STATUSES = new Set(['pending', 'planned', 'confirmed', 'scheduled', 'fixed', 'completed', 'cancelled']);

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

function isFullDayAbsence(entry, date) {
  return entry.start_at <= `${date} 00:01` && entry.end_at >= `${date} 23:58`;
}

function availabilityFor(entries, date) {
  const relevant = entries.filter(entry => entry.start_at.slice(0, 10) <= date && entry.end_at.slice(0, 10) >= date);
  if (!relevant.length) return { state: 'available', label: 'Verfügbar' };
  if (relevant.some(entry => isFullDayAbsence(entry, date))) return { state: 'unavailable', label: 'Nicht verfügbar' };
  return { state: 'partial', label: 'Teilweise' };
}

function eventTasks(event, assignments, today = berlinDate()) {
  const isPrm = event.event_type === 'primeleague';
  const isScrim = event.event_type === 'scrim';
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
    [event.event_type !== 'open', 'Terminart fehlt'],
    [!isMatch || Boolean(event.matchFormat), 'Format fehlt'],
    [!isMatch || assignments.filter(item => ['Top', 'Jgl', 'Jungle', 'Mid', 'ADC', 'Supp', 'Support'].includes(item.role)).length >= 5, 'Eigene Aufstellung fehlt']
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
    ORDER BY option_date, COALESCE(scheduled_start_at, window_start_at), id
  `).all(weekStart, weekEnd);

  const assignmentColumns = columns(database, 'team_calendar_assignments');
  const assignments = events.length ? database.prepare(`
    SELECT event_id, role_label, player_label, assignee_type,
      ${assignmentColumns.has('player_id') ? 'player_id' : 'NULL AS player_id'}
    FROM team_calendar_assignments
    WHERE event_id IN (${events.map(() => '?').join(',')})
    ORDER BY event_id, role_label
  `).all(...events.map(event => event.id)) : [];
  const assignmentMap = new Map();
  for (const item of assignments) {
    if (!assignmentMap.has(item.event_id)) assignmentMap.set(item.event_id, []);
    assignmentMap.get(item.event_id).push({ role: item.role_label, player: item.player_label, type: item.assignee_type, playerId: item.player_id });
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
      fullLineup: Object.fromEntries(dates.map(date => [date,
        starters.length >= 5 && starters.every(player => player.days[date].state !== 'unavailable')
      ]))
    };
  });

  const conflicts = [];
  for (const event of normalizedEvents) {
    for (const other of normalizedEvents) {
      if (other.id <= event.id || other.date !== event.date) continue;
      const duplicate = event.lineup.map(item => item.playerId).filter(Boolean)
        .find(playerId => other.lineup.some(item => item.playerId === playerId));
      if (duplicate) conflicts.push({ eventIds: [event.id, other.id], label: 'Spieler ist am selben Tag doppelt eingeplant' });
    }
    for (const choice of event.eitherOr) {
      const datesAssigned = normalizedEvents.filter(item => item.teamId === event.teamId && [choice.firstDate, choice.secondDate].includes(item.date))
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

function updateEvent(database, eventId, body, actorId) {
  const current = database.prepare('SELECT * FROM team_calendar_events WHERE id = ?').get(eventId);
  if (!current) throw Object.assign(new Error('event_not_found'), { status: 404 });
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
  if (Object.hasOwn(body, 'opponentLineup')) {
    const lineup = Array.isArray(body.opponentLineup) ? body.opponentLineup.slice(0, 5) : [];
    values.opponent_lineup_json = JSON.stringify(lineup.map(item => ({ role: String(item.role || '').slice(0, 20), player: String(item.player || '').slice(0, 100) })));
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

function exportPreview(database, week) {
  const start = mondayOf(week);
  const end = addDaysIso(start, 6);
  const rows = database.prepare(`
    SELECT id, title, option_date, planner_state, show_in_player_calendar
    FROM team_calendar_events
    WHERE option_date BETWEEN ? AND ? AND status NOT IN ('cancelled', 'deleted')
  `).all(start, end);
  const publish = rows.filter(row => row.planner_state === 'preplanned' && !row.show_in_player_calendar);
  const update = rows.filter(row => row.planner_state === 'preplanned' && row.show_in_player_calendar);
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

async function generateDrafter(database, eventId, actorId, env = process.env, fetchImpl = fetch) {
  const event = database.prepare('SELECT * FROM team_calendar_events WHERE id = ?').get(eventId);
  if (!event) throw Object.assign(new Error('event_not_found'), { status: 404 });
  if (event.event_type === 'primeleague') throw Object.assign(new Error('primeleague_uses_external_drafter'), { status: 400 });
  if (!env.DRAFTER_API_TOKEN) throw Object.assign(new Error('drafter_token_not_configured'), { status: 503 });
  const endpoint = env.DRAFTER_API_URL || 'https://api.drafter.lol/api/series';
  const games = ({ '2_games': 2, '3_games': 3, bo3: 3, bo4: 4, bo5: 5 })[event.match_format] || 3;
  const response = await fetchImpl(endpoint, {
    method: 'POST',
    headers: { Authorization: `Bearer ${env.DRAFTER_API_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      team1Name: String(env.DRAFTER_HOME_TEAM_NAME || 'SchiggyGang').slice(0, 35),
      team2Name: String(event.opponent_name || 'Gegner').slice(0, 35),
      fearless: Boolean(event.fearless_mode),
      ironman: false,
      firstSelection: false,
      gameAmount: games,
      disabledChampions: []
    })
  });
  const data = await response.json().catch(() => ({}));
  const url = data.url || data.seriesUrl || data.draftUrl;
  if (!response.ok || !url) throw Object.assign(new Error(data.error || `drafter_request_failed_${response.status}`), { status: 502 });
  database.prepare(`UPDATE team_calendar_events SET drafter_url = ?, drafter_opponent_name = ?, updated_at = ?, updated_by_discord_user_id = ? WHERE id = ?`)
    .run(url, event.opponent_name, new Date().toISOString(), actorId, eventId);
  return { url };
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
  exportWeek, undoExport, generateDrafter, copyPreviousWeek, mondayOf, addDaysIso
};
