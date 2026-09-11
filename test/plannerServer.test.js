const test = require('node:test');
const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');
const { buildPlannerSnapshot, startPlannerWebServer } = require('../src/web/plannerServer');
const { updateEvent, exportPreview, exportWeek, undoExport, generateDrafter, copyPreviousWeek } = require('../src/services/plannerWebService');

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
  const snapshot = buildPlannerSnapshot({ isReady: () => true }, database, { week: '2099-04-06' });

  assert.equal(snapshot.botOnline, true);
  assert.equal(snapshot.teams.length, 2);
  assert.equal(snapshot.teams[0].events[0].opponent, 'Beispiel Gaming');
  assert.deepEqual(snapshot.teams[0].events[0].lineup, [
    { role: 'Top', player: 'Joe Kurt', type: 'player', playerId: null }
  ]);
  assert.deepEqual(snapshot.teams[0].events[0].eitherOr, [
    { player: 'Joe Kurt', playerId: 7, firstDate: '2099-04-06', secondDate: '2099-04-08' }
  ]);
  assert.equal(snapshot.teams[1].events.length, 0);
  database.close();
});

test('Vorwoche kopieren übernimmt Struktur, aber keine Gegnerdaten', () => {
  const database = new DatabaseSync(':memory:');
  database.exec(`
    CREATE TABLE team_calendar_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT, team_id INTEGER, title TEXT NOT NULL,
      opponent_name TEXT, event_type TEXT, status TEXT, option_date TEXT,
      window_start_at TEXT, window_end_at TEXT, scheduled_start_at TEXT, scheduled_end_at TEXT,
      meeting_scrim_at TEXT, meeting_primeleague_at TEXT, available_players_text TEXT,
      opgg_url TEXT, note TEXT, is_auto_generated INTEGER, admin_card_collapsed INTEGER,
      show_in_player_calendar INTEGER, planner_state TEXT, match_format TEXT, fearless_mode INTEGER,
      drafter_url TEXT, drafter_opponent_name TEXT, opponent_lineup_json TEXT, result_text TEXT,
      is_streamed INTEGER, start_at TEXT, end_at TEXT, meeting_at TEXT,
      created_by_discord_user_id TEXT, updated_by_discord_user_id TEXT, created_at TEXT, updated_at TEXT
    );
    INSERT INTO team_calendar_events (
      team_id, title, opponent_name, event_type, status, option_date, window_start_at,
      window_end_at, scheduled_start_at, scheduled_end_at, opgg_url, planner_state,
      match_format, fearless_mode, drafter_url, result_text, created_by_discord_user_id,
      updated_by_discord_user_id, created_at, updated_at
    ) VALUES (1, 'Scrim', 'Old Opponent', 'scrim', 'fixed', '2099-03-30',
      '2099-03-30 20:00', '2099-03-30 22:30', '2099-03-30 20:00',
      '2099-03-30 22:30', 'https://op.gg/old', 'published', 'bo3', 1,
      'https://drafter.lol/old', '2:1', 'coach', 'coach', '2099-01-01', '2099-01-01');
  `);
  database.transaction = callback => callback;
  const copied = copyPreviousWeek(database, '2099-04-06', 'coach-2');
  assert.equal(copied.copied.length, 1);
  const event = database.prepare(`SELECT * FROM team_calendar_events WHERE option_date = '2099-04-06'`).get();
  assert.equal(event.planner_state, 'preplanned');
  assert.equal(event.opponent_name, null);
  assert.equal(event.opgg_url, null);
  assert.equal(event.drafter_url, null);
  assert.equal(event.match_format, 'bo3');
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
  const planner = await fetch(`${baseUrl}/api/planner?week=2099-04-06`).then(response => response.json());
  const page = await fetch(baseUrl).then(response => response.text());

  assert.deepEqual(health, { status: 'ok', botOnline: true });
  assert.equal(planner.teams[0].events[0].id, 10);
  assert.match(page, /SchiggyGang Planer/);
});

test('Terminbearbeitung validiert Auswahlfelder und Export erfasst nur Planner-Karten', async () => {
  const database = createTestDatabase();
  database.exec(`
    ALTER TABLE team_calendar_events ADD COLUMN planner_state TEXT NOT NULL DEFAULT 'open';
    ALTER TABLE team_calendar_events ADD COLUMN match_format TEXT NOT NULL DEFAULT '3_games';
    ALTER TABLE team_calendar_events ADD COLUMN fearless_mode INTEGER NOT NULL DEFAULT 1;
    ALTER TABLE team_calendar_events ADD COLUMN drafter_url TEXT;
    ALTER TABLE team_calendar_events ADD COLUMN drafter_opponent_name TEXT;
    ALTER TABLE team_calendar_events ADD COLUMN opponent_lineup_json TEXT;
    ALTER TABLE team_calendar_events ADD COLUMN result_text TEXT;
    ALTER TABLE team_calendar_events ADD COLUMN show_in_player_calendar INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE team_calendar_events ADD COLUMN updated_by_discord_user_id TEXT;
    ALTER TABLE team_calendar_events ADD COLUMN last_exported_at TEXT;
    CREATE TABLE planner_exports (
      id INTEGER PRIMARY KEY AUTOINCREMENT, week_start_date TEXT,
      actor_discord_user_id TEXT, changes_json TEXT, created_at TEXT,
      reverted_at TEXT, reverted_by_discord_user_id TEXT
    );
  `);
  database.transaction = callback => callback;

  updateEvent(database, 10, {
    plannerState: 'preplanned',
    matchFormat: 'bo3',
    fearless: false,
    opponentLineup: [{ role: 'Top', player: 'Opponent Top' }]
  }, 'coach-1');

  const preview = exportPreview(database, '2099-04-06');
  assert.equal(preview.publish.length, 1);
  assert.equal(preview.remove.length, 0);
  assert.equal(preview.publish[0].id, 10);
  assert.throws(() => updateEvent(database, 10, { matchFormat: 'best-of-99' }, 'coach-1'), /invalid_match_format/);

  const synced = [];
  const exported = await exportWeek({}, database, '2099-04-06', 'coach-1', async (_, id) => synced.push(id));
  assert.equal(exported.exportId, 1);
  assert.deepEqual(synced, [10]);
  assert.equal(database.prepare('SELECT show_in_player_calendar FROM team_calendar_events WHERE id = 10').get().show_in_player_calendar, 1);

  const undone = await undoExport({}, database, '2099-04-06', 'coach-1', async () => {});
  assert.equal(undone.restored, 1);
  assert.equal(database.prepare('SELECT show_in_player_calendar FROM team_calendar_events WHERE id = 10').get().show_in_player_calendar, 0);

  let drafterRequest;
  const generated = await generateDrafter(database, 10, 'coach-1', {
    DRAFTER_API_TOKEN: 'test-token', DRAFTER_HOME_TEAM_NAME: 'SchiggyGang'
  }, async (url, options) => {
    drafterRequest = { url, options, body: JSON.parse(options.body) };
    return { ok: true, json: async () => ({ id: 'series_1', url: 'https://drafter.lol/draft/series_1' }) };
  });
  assert.equal(generated.url, 'https://drafter.lol/draft/series_1');
  assert.equal(drafterRequest.url, 'https://api.drafter.lol/api/series');
  assert.equal(drafterRequest.options.headers.Authorization, 'Bearer test-token');
  assert.deepEqual(drafterRequest.body, {
    team1Name: 'SchiggyGang', team2Name: 'Beispiel Gaming', fearless: false,
    ironman: false, firstSelection: false, gameAmount: 3, disabledChampions: []
  });
  database.close();
});
