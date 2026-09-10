const http = require('http');
const fs = require('fs');
const path = require('path');
const { createPlannerAuth } = require('./plannerAuth');

const PUBLIC_DIR = path.join(__dirname, 'public');
const STATIC_FILES = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/app.js', ['app.js', 'text/javascript; charset=utf-8']],
  ['/styles.css', ['styles.css', 'text/css; charset=utf-8']]
]);

function eventTimestamp(event) {
  return event.scheduled_start_at || event.window_start_at || `${event.option_date}T12:00:00`;
}

function buildPlannerSnapshot(client, database) {
  const db = database || require('../db/database');
  const teams = db.prepare(`
    SELECT id, name, slug, short_name
    FROM teams
    WHERE is_active = 1
    ORDER BY is_default DESC, name COLLATE NOCASE ASC
  `).all();

  const events = db.prepare(`
    SELECT
      id, team_id, title, opponent_name, event_type, status, option_date,
      window_start_at, window_end_at, scheduled_start_at, scheduled_end_at,
      meeting_scrim_at, meeting_primeleague_at, available_players_text,
      opgg_url, note, is_streamed, updated_at
    FROM team_calendar_events
    WHERE status NOT IN ('deleted', 'cancelled')
      AND COALESCE(
        NULLIF(option_date, ''),
        substr(NULLIF(scheduled_start_at, ''), 1, 10),
        substr(NULLIF(window_start_at, ''), 1, 10)
      ) >= date('now', '-1 day')
    ORDER BY
      COALESCE(NULLIF(scheduled_start_at, ''), NULLIF(window_start_at, ''), option_date) ASC,
      id ASC
    LIMIT 100
  `).all();

  const assignments = events.length
    ? db.prepare(`
        SELECT event_id, role_label, player_label, assignee_type
        FROM team_calendar_assignments
        WHERE event_id IN (${events.map(() => '?').join(',')})
        ORDER BY event_id ASC,
          CASE lower(role_label)
            WHEN 'top' THEN 1 WHEN 'jungle' THEN 2 WHEN 'mid' THEN 3
            WHEN 'adc' THEN 4 WHEN 'support' THEN 5 ELSE 6
          END,
          role_label COLLATE NOCASE ASC
      `).all(...events.map(event => event.id))
    : [];

  const choices = db.prepare(`
    SELECT
      c.player_id, c.first_date, c.second_date,
      p.team_id,
      COALESCE(NULLIF(p.alias, ''), NULLIF(p.global_name, ''), p.username) AS player_name
    FROM weekly_availability_choices c
    JOIN players p ON p.id = c.player_id
    WHERE c.second_date >= date('now', '-1 day')
      AND COALESCE(p.is_archived, 0) = 0
    ORDER BY c.first_date ASC, player_name COLLATE NOCASE ASC
  `).all();

  const assignmentMap = new Map();
  for (const assignment of assignments) {
    if (!assignmentMap.has(assignment.event_id)) assignmentMap.set(assignment.event_id, []);
    assignmentMap.get(assignment.event_id).push({
      role: assignment.role_label,
      player: assignment.player_label,
      type: assignment.assignee_type
    });
  }

  const teamMap = new Map(teams.map(team => [team.id, {
    id: team.id,
    name: team.name,
    slug: team.slug,
    shortName: team.short_name,
    events: []
  }]));

  for (const event of events) {
    const team = teamMap.get(event.team_id);
    if (!team) continue;
    team.events.push({
      id: event.id,
      title: event.title,
      opponent: event.opponent_name,
      type: event.event_type,
      status: event.status,
      date: event.option_date,
      startsAt: eventTimestamp(event),
      endsAt: event.scheduled_end_at || event.window_end_at,
      meetingAt: event.event_type === 'primeleague'
        ? event.meeting_primeleague_at
        : event.meeting_scrim_at,
      availability: event.available_players_text,
      opggUrl: event.opgg_url,
      note: event.note,
      streamed: Boolean(event.is_streamed),
      updatedAt: event.updated_at,
      lineup: assignmentMap.get(event.id) || [],
      eitherOr: choices
        .filter(choice => choice.team_id === event.team_id
          && (choice.first_date === event.option_date || choice.second_date === event.option_date))
        .map(choice => ({
          player: choice.player_name,
          firstDate: choice.first_date,
          secondDate: choice.second_date
        }))
    });
  }

  return {
    generatedAt: new Date().toISOString(),
    botOnline: Boolean(client?.isReady?.()),
    readOnly: true,
    teams: [...teamMap.values()]
  };
}

function sendJson(response, status, payload) {
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff'
  });
  response.end(JSON.stringify(payload));
}

function applySecurityHeaders(response) {
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.setHeader('X-Frame-Options', 'DENY');
  response.setHeader('Referrer-Policy', 'no-referrer');
  response.setHeader(
    'Content-Security-Policy',
    "default-src 'self'; connect-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; base-uri 'none'; frame-ancestors 'none'"
  );
}

function startPlannerWebServer({ client, port, host, database, authenticator } = {}) {
  if (process.env.PLANNER_WEB_ENABLED === 'false') return null;

  const listenPort = Number(port ?? process.env.PLANNER_WEB_PORT ?? 3100);
  const listenHost = host ?? process.env.PLANNER_WEB_HOST ?? '127.0.0.1';
  const plannerDb = database || require('../db/database');
  const auth = authenticator || createPlannerAuth({ client });
  const liveClients = new Set();

  const server = http.createServer(async (request, response) => {
    applySecurityHeaders(response);
    const url = new URL(request.url, 'http://localhost');

    try {
      if (await auth.handle(request, response, url)) return;
    } catch (error) {
      console.error('[Planner-Web] Authentifizierungsfehler:', error);
      sendJson(response, 500, { error: 'authentication_failed' });
      return;
    }

    if (request.method !== 'GET') {
      sendJson(response, 405, { error: 'method_not_allowed' });
      return;
    }

    if (url.pathname === '/healthz') {
      sendJson(response, 200, { status: 'ok', botOnline: Boolean(client?.isReady?.()) });
      return;
    }

    if (url.pathname === '/api/planner') {
      if (!auth.requireSession(request, response)) return;
      sendJson(response, 200, buildPlannerSnapshot(client, plannerDb));
      return;
    }

    if (url.pathname === '/api/live') {
      if (!auth.requireSession(request, response)) return;
      response.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive'
      });
      response.write(`event: planner\ndata: ${JSON.stringify(buildPlannerSnapshot(client, plannerDb))}\n\n`);
      liveClients.add(response);
      request.on('close', () => liveClients.delete(response));
      return;
    }

    const staticFile = STATIC_FILES.get(url.pathname);
    if (!staticFile) {
      sendJson(response, 404, { error: 'not_found' });
      return;
    }

    const [filename, contentType] = staticFile;
    fs.readFile(path.join(PUBLIC_DIR, filename), (error, content) => {
      if (error) {
        sendJson(response, 500, { error: 'asset_unavailable' });
        return;
      }
      response.writeHead(200, {
        'Content-Type': contentType,
        'Cache-Control': 'no-cache',
        'X-Content-Type-Options': 'nosniff'
      });
      response.end(content);
    });
  });

  let previousFingerprint = '';
  const changeTimer = setInterval(() => {
    if (!liveClients.size) return;
    try {
      const snapshot = buildPlannerSnapshot(client, plannerDb);
      const fingerprint = JSON.stringify(snapshot.teams);
      if (fingerprint === previousFingerprint) return;
      previousFingerprint = fingerprint;
      const message = `event: planner\ndata: ${JSON.stringify(snapshot)}\n\n`;
      for (const response of liveClients) response.write(message);
    } catch (error) {
      console.error('[Planner-Web] Live-Aktualisierung fehlgeschlagen:', error);
    }
  }, 3000);

  const heartbeatTimer = setInterval(() => {
    for (const response of liveClients) response.write(': heartbeat\n\n');
  }, 25000);

  server.on('close', () => {
    clearInterval(changeTimer);
    clearInterval(heartbeatTimer);
  });

  server.on('error', error => {
    console.error('[Planner-Web] Serverfehler:', error);
  });

  server.listen(listenPort, listenHost, () => {
    const address = server.address();
    const activePort = typeof address === 'object' && address ? address.port : listenPort;
    console.log(`[Planner-Web] Read-only Vorschau auf http://${listenHost}:${activePort}`);
  });

  return server;
}

module.exports = { buildPlannerSnapshot, startPlannerWebServer };
