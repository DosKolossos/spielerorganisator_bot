const crypto = require('crypto');

const DISCORD_API = 'https://discord.com/api/v10';
const ADMINISTRATOR_PERMISSION = 1n << 3n;
const MANAGE_GUILD_PERMISSION = 1n << 5n;
const SESSION_MAX_AGE_MS = 8 * 60 * 60 * 1000;
const STATE_MAX_AGE_MS = 10 * 60 * 1000;

function parseCookies(header) {
  return Object.fromEntries(String(header || '')
    .split(';')
    .map(part => part.trim())
    .filter(Boolean)
    .map(part => {
      const separator = part.indexOf('=');
      if (separator < 0) return [part, ''];
      return [part.slice(0, separator), decodeURIComponent(part.slice(separator + 1))];
    }));
}

function timingSafeEqual(left, right) {
  const a = Buffer.from(String(left));
  const b = Buffer.from(String(right));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function sendJson(response, status, payload) {
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff'
  });
  response.end(JSON.stringify(payload));
}

function sendMessage(response, status, title, message) {
  response.writeHead(status, {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store'
  });
  response.end(`<!doctype html><html lang="de"><meta charset="utf-8"><title>${title}</title><body><h1>${title}</h1><p>${message}</p><p><a href="/">Zurück zum Planer</a></p></body></html>`);
}

function hasAdminPermission(role) {
  const value = role?.permissions?.bitfield ?? role?.permissions ?? 0;
  const permissions = BigInt(value);
  return Boolean(
    (permissions & ADMINISTRATOR_PERMISSION) ||
    (permissions & MANAGE_GUILD_PERMISSION)
  );
}

async function isAllowedMember(client, guildId, user, member, adminRoleName) {
  const guild = await client.guilds.fetch(guildId);
  if (guild.ownerId === user.id) return true;
  const roles = await guild.roles.fetch();
  return member.roles.some(roleId => {
    const role = roles.get(roleId);
    return role && (role.name === adminRoleName || hasAdminPermission(role));
  });
}

function createPlannerAuth({ client, fetchImpl = fetch, env = process.env } = {}) {
  const clientId = env.CLIENT_ID;
  const clientSecret = env.DISCORD_CLIENT_SECRET;
  const guildId = env.GUILD_ID;
  const sessionSecret = env.PLANNER_SESSION_SECRET;
  const publicUrl = String(env.PLANNER_PUBLIC_URL || '').replace(/\/$/, '');
  const redirectUri = publicUrl ? `${publicUrl}/auth/callback` : '';
  const adminRoleName = env.ADMIN_ROLE_NAME || 'Schillok | Coaches';
  const configured = Boolean(clientId && clientSecret && guildId && sessionSecret && redirectUri);
  const secureCookie = publicUrl.startsWith('https://');
  const sessions = new Map();
  const states = new Map();

  function sign(value) {
    return crypto.createHmac('sha256', sessionSecret || 'not-configured')
      .update(value)
      .digest('base64url');
  }

  function signedValue(value) {
    return `${value}.${sign(value)}`;
  }

  function verifySignedValue(value) {
    const separator = String(value || '').lastIndexOf('.');
    if (separator < 1) return null;
    const raw = value.slice(0, separator);
    const signature = value.slice(separator + 1);
    return timingSafeEqual(signature, sign(raw)) ? raw : null;
  }

  function cookie(name, value, maxAgeSeconds) {
    return `${name}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSeconds}${secureCookie ? '; Secure' : ''}`;
  }

  function cleanupExpired() {
    const now = Date.now();
    for (const [id, session] of sessions) if (session.expiresAt <= now) sessions.delete(id);
    for (const [id, expiresAt] of states) if (expiresAt <= now) states.delete(id);
  }

  function getSession(request) {
    if (!configured) return null;
    cleanupExpired();
    const cookies = parseCookies(request.headers.cookie);
    const sessionId = verifySignedValue(cookies.planner_session);
    const session = sessionId ? sessions.get(sessionId) : null;
    if (!session || session.expiresAt <= Date.now()) return null;
    return session;
  }

  function requireSession(request, response) {
    if (!configured) {
      sendJson(response, 503, { error: 'authentication_not_configured' });
      return null;
    }
    const session = getSession(request);
    if (!session) {
      sendJson(response, 401, { error: 'authentication_required' });
      return null;
    }
    return session;
  }

  async function exchangeCode(code) {
    const body = new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirectUri
    });
    const response = await fetchImpl(`${DISCORD_API}/oauth2/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body
    });
    const data = await response.json();
    if (!response.ok || !data.access_token) throw new Error('Discord-Tokenaustausch fehlgeschlagen.');
    return data.access_token;
  }

  async function discordGet(path, accessToken) {
    const response = await fetchImpl(`${DISCORD_API}${path}`, {
      headers: { Authorization: `Bearer ${accessToken}` }
    });
    const data = await response.json();
    if (!response.ok) throw new Error(`Discord-Anfrage ${path} fehlgeschlagen.`);
    return data;
  }

  async function handle(request, response, url) {
    if (!url.pathname.startsWith('/auth/')) return false;

    if (url.pathname === '/auth/config') {
      sendJson(response, 200, { configured });
      return true;
    }

    if (url.pathname === '/auth/me') {
      const session = requireSession(request, response);
      if (session) sendJson(response, 200, { user: session.user });
      return true;
    }

    if (url.pathname === '/auth/login') {
      if (!configured) {
        sendMessage(response, 503, 'Anmeldung noch nicht eingerichtet', 'Der Discord-Zugang wird gerade vorbereitet.');
        return true;
      }
      cleanupExpired();
      const state = crypto.randomBytes(24).toString('base64url');
      states.set(state, Date.now() + STATE_MAX_AGE_MS);
      const target = new URL('https://discord.com/oauth2/authorize');
      target.search = new URLSearchParams({
        client_id: clientId,
        response_type: 'code',
        redirect_uri: redirectUri,
        scope: 'identify guilds.members.read',
        state,
        prompt: 'none'
      }).toString();
      response.writeHead(302, {
        Location: target.toString(),
        'Set-Cookie': cookie('planner_oauth_state', signedValue(state), STATE_MAX_AGE_MS / 1000),
        'Cache-Control': 'no-store'
      });
      response.end();
      return true;
    }

    if (url.pathname === '/auth/callback') {
      if (!configured) {
        sendMessage(response, 503, 'Anmeldung noch nicht eingerichtet', 'Die Konfiguration ist noch nicht vollständig.');
        return true;
      }
      const cookies = parseCookies(request.headers.cookie);
      const state = verifySignedValue(cookies.planner_oauth_state);
      const requestedState = url.searchParams.get('state');
      const stateExpiry = state ? states.get(state) : null;
      states.delete(state);
      if (!state || !requestedState || !timingSafeEqual(state, requestedState) || !stateExpiry || stateExpiry <= Date.now()) {
        sendMessage(response, 400, 'Anmeldung abgebrochen', 'Die Anmeldeanfrage ist abgelaufen oder ungültig.');
        return true;
      }

      const code = url.searchParams.get('code');
      if (!code) {
        sendMessage(response, 400, 'Anmeldung abgebrochen', 'Discord hat keinen Anmeldecode geliefert.');
        return true;
      }

      const accessToken = await exchangeCode(code);
      const [user, member] = await Promise.all([
        discordGet('/users/@me', accessToken),
        discordGet(`/users/@me/guilds/${guildId}/member`, accessToken)
      ]);
      if (!(await isAllowedMember(client, guildId, user, member, adminRoleName))) {
        sendMessage(response, 403, 'Kein Zugriff', `Du benötigst auf dem Discord-Server die Rolle „${adminRoleName}“ oder Verwaltungsrechte.`);
        return true;
      }

      const sessionId = crypto.randomBytes(32).toString('base64url');
      sessions.set(sessionId, {
        expiresAt: Date.now() + SESSION_MAX_AGE_MS,
        user: {
          id: user.id,
          username: user.global_name || user.username,
          avatar: user.avatar
        }
      });
      response.writeHead(302, {
        Location: '/',
        'Set-Cookie': [
          cookie('planner_session', signedValue(sessionId), SESSION_MAX_AGE_MS / 1000),
          cookie('planner_oauth_state', '', 0)
        ],
        'Cache-Control': 'no-store'
      });
      response.end();
      return true;
    }

    if (url.pathname === '/auth/logout') {
      const cookies = parseCookies(request.headers.cookie);
      const sessionId = verifySignedValue(cookies.planner_session);
      if (sessionId) sessions.delete(sessionId);
      response.writeHead(302, {
        Location: '/',
        'Set-Cookie': cookie('planner_session', '', 0),
        'Cache-Control': 'no-store'
      });
      response.end();
      return true;
    }

    sendJson(response, 404, { error: 'not_found' });
    return true;
  }

  return { configured, getSession, requireSession, handle };
}

module.exports = { createPlannerAuth, parseCookies };
