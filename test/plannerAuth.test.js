const test = require('node:test');
const assert = require('node:assert/strict');
const { createPlannerAuth, parseCookies } = require('../src/web/plannerAuth');

function mockResponse() {
  return {
    status: null,
    headers: null,
    body: '',
    writeHead(status, headers) {
      this.status = status;
      this.headers = headers;
    },
    end(body = '') { this.body = body; }
  };
}

test('Cookie-Parser behandelt signierte Werte und mehrere Cookies', () => {
  assert.deepEqual(parseCookies('foo=bar; planner_session=abc.def'), {
    foo: 'bar',
    planner_session: 'abc.def'
  });
});

test('Unkonfigurierte Authentifizierung schützt die Planerdaten', () => {
  const auth = createPlannerAuth({ env: {} });
  const response = mockResponse();
  const session = auth.requireSession({ headers: {} }, response);

  assert.equal(auth.configured, false);
  assert.equal(session, null);
  assert.equal(response.status, 503);
  assert.deepEqual(JSON.parse(response.body), { error: 'authentication_not_configured' });
});

test('Login erzeugt Discord-OAuth-Weiterleitung mit minimalen Scopes', async () => {
  const auth = createPlannerAuth({
    client: {},
    env: {
      CLIENT_ID: '123',
      DISCORD_CLIENT_SECRET: 'secret',
      GUILD_ID: '456',
      PLANNER_SESSION_SECRET: 'a'.repeat(64),
      PLANNER_PUBLIC_URL: 'https://planner.schiggygang.de'
    }
  });
  const response = mockResponse();
  const handled = await auth.handle(
    { headers: {} },
    response,
    new URL('https://planner.schiggygang.de/auth/login')
  );

  assert.equal(handled, true);
  assert.equal(response.status, 302);
  const target = new URL(response.headers.Location);
  assert.equal(target.origin, 'https://discord.com');
  assert.equal(target.searchParams.get('scope'), 'identify guilds.members.read');
  assert.equal(target.searchParams.get('redirect_uri'), 'https://planner.schiggygang.de/auth/callback');
  assert.match(response.headers['Set-Cookie'], /HttpOnly/);
  assert.match(response.headers['Set-Cookie'], /Secure/);
});
