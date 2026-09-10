const test = require('node:test');
const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');
const { buildPlannerSnapshot, startPlannerWebServer } = require('../src/web/plannerServer');

function createTestDatabase() {
  const database = new DatabaseSync(':memory:');
  database.exec(`
    CREATE TABLE teams (
      id INTEGER PRIMARY KEY, name TEXT, slug TEXT, short_name TEXT,
      is_active INTEGER, is_default INTEGER
    );
    CREATE TABLE team_calendar_events (
      id INTEGER PRIMARY KEY, team_id INTEGER, title TEXT, opponent_name TEXT,
      event_type TEXT, status TEXT, option_date TEXT, window_start_at TEXT,
      window_end_at TEXT, scheduled_start_at TEXT, scheduled_end_at TEXT,
      meeting_scrim_at TEXT, meeting_primeleague_at TEXT,
      available_players_text TEXT, opgg_url TEXT, note TEXT,
      is_streamed INTEGER, updated_at TEXT
    );
    CREATE TABLE team_calendar_assignments (
      event_id INTEGER, role_label TEXT, player_label TEXT, assignee_type TEXT
    );
    CREATE TABLE players (
      id INTEGER PRIMARY KEY, team_id INTEGER, alias TEXT, global_name TEXT,
      username TEXT, is_archived INTEGER
    );
    CREATE TABLE weekly_availability_choices (
      player_id INTEGER, first_date TEXT, second_date TEXT
    );

    INSERT INTO teams VALUES (1, 'SchiggyGang Main', 'main', 'MAIN', 1, 1);
    INSERT INTO teams VALUES (2, 'SchiggyGang Shinys', 'shinys', 'SHINY', 1, 0);
    INSERT INTO team_calendar_events VALUES (
      10, 1, 'Scrim', 'Beispiel Gaming', 'scrim', 'confirmed',
      '2099-04-06', '2099-04-06T20:00:00+02:00', '2099-04-06T22:00:00+02:00',
      '2099-04-06T20:00:00+02:00', '2099-04-06T22:00:00+02:00',
      '2099-04-06T19:45:00+02:00', NULL, '5 verfügbar',
      'https://www.op.gg/multisearch/euw', NULL, 0, '2099-04-01T12:00:00Z'
    );
    INSERT INTO team_calendar_assignments VALUES (10, 'Top', 'Joe Kurt', 'player');
    INSERT INTO players VALUES (7, 1, 'Joe Kurt', NULL, 'joe', 0);
    INSERT INTO weekly_availability_choices VALUES (7, '2099-04-06', '2099-04-08');
  `);
  return database;
}

test('Snapshot trennt Teams und enthält Aufstellung sowie Entweder-oder-Angabe', () => {
  const database = createTestDatabase();
  const snapshot = buildPlannerSnapshot({ isReady: () => true }, database);

  assert.equal(snapshot.botOnline, true);
  assert.equal(snapshot.teams.length, 2);
  assert.equal(snapshot.teams[0].events[0].opponent, 'Beispiel Gaming');
  assert.deepEqual(snapshot.teams[0].events[0].lineup, [
    { role: 'Top', player: 'Joe Kurt', type: 'player' }
  ]);
  assert.deepEqual(snapshot.teams[0].events[0].eitherOr, [
    { player: 'Joe Kurt', firstDate: '2099-04-06', secondDate: '2099-04-08' }
  ]);
  assert.equal(snapshot.teams[1].events.length, 0);
  database.close();
});

test('Webserver liefert Healthcheck, API und Oberfläche aus', async t => {
  const database = createTestDatabase();
  const authenticator = {
    handle: async () => false,
    requireSession: () => ({ user: { id: 'test' } })
  };
  const server = startPlannerWebServer({
    client: { isReady: () => true },
    database,
    authenticator,
    host: '127.0.0.1',
    port: 0
  });

  await new Promise((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  t.after(() => {
    server.close();
    database.close();
  });

  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const health = await fetch(`${baseUrl}/healthz`).then(response => response.json());
  const planner = await fetch(`${baseUrl}/api/planner`).then(response => response.json());
  const page = await fetch(baseUrl).then(response => response.text());

  assert.deepEqual(health, { status: 'ok', botOnline: true });
  assert.equal(planner.teams[0].events[0].id, 10);
  assert.match(page, /SchiggyGang Planer/);
});
