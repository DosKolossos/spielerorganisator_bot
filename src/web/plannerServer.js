const http = require('http');
const fs = require('fs');
const path = require('path');
const { createPlannerAuth } = require('./plannerAuth');
const {
  buildPlannerSnapshot,
  parseBody,
  validateOrigin,
  updateEvent,
  exportPreview,
  exportWeek,
  undoExport,
  copyPreviousWeek
} = require('../services/plannerWebService');

const PUBLIC_DIR = path.join(__dirname, 'public');
const STATIC_FILES = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/app.js', ['app.js', 'text/javascript; charset=utf-8']],
  ['/styles.css', ['styles.css', 'text/css; charset=utf-8']]
]);

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
  const liveClients = new Map();

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

    try {
    if (url.pathname === '/healthz') {
      sendJson(response, 200, { status: 'ok', botOnline: Boolean(client?.isReady?.()) });
      return;
    }

    if (url.pathname === '/api/planner') {
      if (!auth.requireSession(request, response)) return;
      sendJson(response, 200, buildPlannerSnapshot(client, plannerDb, { week: url.searchParams.get('week') }));
      return;
    }

    if (url.pathname === '/api/live') {
      if (!auth.requireSession(request, response)) return;
      response.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive'
      });
      const week = url.searchParams.get('week');
      response.write(`event: planner\ndata: ${JSON.stringify(buildPlannerSnapshot(client, plannerDb, { week }))}\n\n`);
      liveClients.set(response, week);
      request.on('close', () => liveClients.delete(response));
      return;
    }

    if (url.pathname === '/api/export/preview' && request.method === 'GET') {
      if (!auth.requireSession(request, response)) return;
      sendJson(response, 200, exportPreview(plannerDb, url.searchParams.get('week')));
      return;
    }

    if (url.pathname.startsWith('/api/') && request.method !== 'GET') {
      const session = auth.requireSession(request, response);
      if (!session) return;
      if (!validateOrigin(request)) {
        sendJson(response, 403, { error: 'invalid_origin' });
        return;
      }
      const body = await parseBody(request);
      const eventMatch = url.pathname.match(/^\/api\/events\/(\d+)$/);
      if (eventMatch && request.method === 'PATCH') {
        const event = updateEvent(plannerDb, Number(eventMatch[1]), body, session.user.id);
        await require('../commands/spieltermin').refreshStoredEventCard(client, event.id);
        sendJson(response, 200, { event });
        return;
      }
      if (url.pathname === '/api/export' && request.method === 'POST') {
        sendJson(response, 200, await exportWeek(client, plannerDb, body.week, session.user.id));
        return;
      }
      if (url.pathname === '/api/export/undo' && request.method === 'POST') {
        sendJson(response, 200, await undoExport(client, plannerDb, body.week, session.user.id));
        return;
      }
      if (url.pathname === '/api/weeks/copy-previous' && request.method === 'POST') {
        sendJson(response, 200, copyPreviousWeek(plannerDb, body.week, session.user.id));
        return;
      }
      if (url.pathname === '/api/changes/acknowledge' && request.method === 'POST') {
        plannerDb.prepare(`UPDATE planner_change_log SET acknowledged_at = ?, acknowledged_by_discord_user_id = ? WHERE id = ?`)
          .run(new Date().toISOString(), session.user.id, Number(body.id));
        sendJson(response, 200, { ok: true });
        return;
      }
      sendJson(response, 404, { error: 'not_found' });
      return;
    }

    if (request.method !== 'GET') {
      sendJson(response, 405, { error: 'method_not_allowed' });
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
    } catch (error) {
      console.error('[Planner-Web] Anfrage fehlgeschlagen:', error);
      if (!response.headersSent) sendJson(response, error.status || 500, { error: error.message || 'request_failed' });
      else response.end();
    }
  });

  let previousFingerprint = '';
  const changeTimer = setInterval(() => {
    if (!liveClients.size) return;
    try {
      for (const [response, week] of liveClients) {
        const snapshot = buildPlannerSnapshot(client, plannerDb, { week });
        const fingerprint = JSON.stringify([week, snapshot.teams, snapshot.tasks, snapshot.changes]);
        if (liveClients.size === 1 && fingerprint === previousFingerprint) continue;
        previousFingerprint = fingerprint;
        response.write(`event: planner\ndata: ${JSON.stringify(snapshot)}\n\n`);
      }
    } catch (error) {
      console.error('[Planner-Web] Live-Aktualisierung fehlgeschlagen:', error);
    }
  }, 3000);

  const heartbeatTimer = setInterval(() => {
    for (const response of liveClients.keys()) response.write(': heartbeat\n\n');
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
    console.log(`[Planner-Web] Planer auf http://${listenHost}:${activePort}`);
  });

  return server;
}

module.exports = { buildPlannerSnapshot, startPlannerWebServer };
