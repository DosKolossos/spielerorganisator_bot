const test = require('node:test');
const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');
const { buildPlannerSnapshot, startPlannerWebServer } = require('../src/web/plannerServer');
const { updateEvent, exportPreview, exportWeek, undoExport, copyPreviousWeek, createStandin } = require('../src/services/plannerWebService');

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
      is_streamed INTEGER, updated_at TEXT, planner_state TEXT NOT NULL DEFAULT 'open',
      match_format TEXT NOT NULL DEFAULT '3_games', fearless_mode INTEGER NOT NULL DEFAULT 1,
      drafter_url TEXT, drafter_opponent_name TEXT, opponent_lineup_json TEXT,
      result_text TEXT, show_in_player_calendar INTEGER NOT NULL DEFAULT 0,
      updated_by_discord_user_id TEXT, last_exported_at TEXT
    );
    CREATE TABLE team_calendar_assignments (
      id INTEGER PRIMARY KEY AUTOINCREMENT, event_id INTEGER, role_label TEXT,
      player_label TEXT, assignee_type TEXT, player_id INTEGER, standin_id INTEGER,
      note TEXT, created_at TEXT, updated_at TEXT, UNIQUE(event_id, role_label)
    );
    CREATE TABLE players (
      id INTEGER PRIMARY KEY, team_id INTEGER, alias TEXT, global_name TEXT,
      username TEXT, discord_user_id TEXT, roster_status TEXT,
      primary_position TEXT, secondary_position TEXT, is_archived INTEGER
    );
    CREATE TABLE weekly_availability_choices (
      player_id INTEGER, first_date TEXT, second_date TEXT
    );
    CREATE TABLE availability_entries (
      player_id INTEGER, start_at TEXT, end_at TEXT, reason TEXT,
      approval_status TEXT, updated_at TEXT
    );
    CREATE TABLE standins (
      id INTEGER PRIMARY KEY AUTOINCREMENT, display_name TEXT, riot_game_name TEXT,
      riot_tag TEXT, riot_region TEXT, preferred_position TEXT, note TEXT,
      is_active INTEGER, promoted_to_player_id INTEGER, team_id INTEGER,
      created_by_discord_user_id TEXT, updated_by_discord_user_id TEXT,
      created_at TEXT, updated_at TEXT
    );

    INSERT INTO teams VALUES (1, 'SchiggyGang Main', 'main', 'MAIN', 1, 1);
    INSERT INTO teams VALUES (2, 'SchiggyGang Shinys', 'shinys', 'SHINY', 1, 0);
    INSERT INTO team_calendar_events (
      id, team_id, title, opponent_name, event_type, status, option_date,
      window_start_at, window_end_at, scheduled_start_at, scheduled_end_at,
      meeting_scrim_at, meeting_primeleague_at, available_players_text,
      opgg_url, note, is_streamed, updated_at, planner_state, match_format,
      fearless_mode, show_in_player_calendar
    ) VALUES (
      10, 1, 'Scrim', 'Beispiel Gaming', 'scrim', 'confirmed',
      '2099-04-06', '2099-04-06T20:00:00+02:00', '2099-04-06T22:00:00+02:00',
      '2099-04-06T20:00:00+02:00', '2099-04-06T22:00:00+02:00',
      '2099-04-06T19:45:00+02:00', NULL, '5 verfügbar',
      'https://www.op.gg/multisearch/euw', NULL, 0, '2099-04-01T12:00:00Z',
      'preplanned', '3_games', 1, 0
    );
    INSERT INTO team_calendar_assignments (
      event_id, role_label, player_label, assignee_type, player_id, created_at, updated_at
    ) VALUES (10, 'Top', 'Joe Kurt', 'player', 7, '2099-04-01', '2099-04-01');
    INSERT INTO players VALUES (7, 1, 'Joe Kurt', NULL, 'joe', 'discord-7', 'main', 'Top', NULL, 0);
    INSERT INTO weekly_availability_choices VALUES (7, '2099-04-06', '2099-04-08');
    INSERT INTO availability_entries VALUES (7, '2099-04-06 00:00', '2099-04-06 18:00', 'später', 'approved', '2099-04-01');
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
    { role: 'Top', player: 'Joe Kurt', type: 'player', playerId: 7, standinId: null }
  ]);
  assert.deepEqual(snapshot.teams[0].events[0].eitherOr, [
    { player: 'Joe Kurt', playerId: 7, firstDate: '2099-04-06', secondDate: '2099-04-08' }
  ]);
  assert.equal(snapshot.teams[0].roster[0].days['2099-04-06'].restriction, 'ab 18:00');
  assert.equal(snapshot.teams[1].events.length, 0);
  database.close();
});

test('Aufgabenlogik erkennt die gespeicherte eigene Aufstellung', () => {
  const database = createTestDatabase();
  let snapshot = buildPlannerSnapshot({ isReady: () => true }, database, {
    week: '2099-04-06', today: '2099-04-05'
  });
  assert.equal(snapshot.tasks[0].label, 'Eigene Aufstellung fehlt');

  database.exec(`
    INSERT INTO players VALUES (8, 1, 'Jungle', NULL, 'jungle', 'discord-8', 'main', 'Jgl', NULL, 0);
    INSERT INTO players VALUES (9, 1, 'Mitte', NULL, 'mitte', 'discord-9', 'main', 'Mid', NULL, 0);
    INSERT INTO players VALUES (10, 1, 'Carry', NULL, 'carry', 'discord-10', 'main', 'ADC', NULL, 0);
    INSERT INTO players VALUES (11, 1, 'Support', NULL, 'support', 'discord-11', 'main', 'Supp', NULL, 0);
    INSERT INTO team_calendar_assignments (event_id, role_label, player_label, assignee_type, player_id, created_at, updated_at)
      VALUES (10, 'Jgl', 'Jungle', 'player', 8, '2099-04-01', '2099-04-01');
    INSERT INTO team_calendar_assignments (event_id, role_label, player_label, assignee_type, player_id, created_at, updated_at)
      VALUES (10, 'Mid', 'Mitte', 'player', 9, '2099-04-01', '2099-04-01');
    INSERT INTO team_calendar_assignments (event_id, role_label, player_label, assignee_type, player_id, created_at, updated_at)
      VALUES (10, 'ADC', 'Carry', 'player', 10, '2099-04-01', '2099-04-01');
    INSERT INTO team_calendar_assignments (event_id, role_label, player_label, assignee_type, player_id, created_at, updated_at)
      VALUES (10, 'Supp', 'Support', 'player', 11, '2099-04-01', '2099-04-01');
  `);
  snapshot = buildPlannerSnapshot({ isReady: () => true }, database, {
    week: '2099-04-06', today: '2099-04-05'
  });
  assert.equal(snapshot.tasks[0].label, 'Drafter fehlt');
  database.close();
});

test('Open-Platzhalter erzeugen keine Aufgaben und sind nicht bearbeitbar', () => {
  const database = createTestDatabase();
  database.prepare(`UPDATE team_calendar_events SET event_type = 'open' WHERE id = 10`).run();
  const snapshot = buildPlannerSnapshot({ isReady: () => true }, database, {
    week: '2099-04-06', today: '2099-04-05'
  });
  assert.equal(snapshot.tasks.length, 0);
  assert.throws(() => updateEvent(database, 10, { title: 'Nicht erlaubt' }, 'coach'), /event_not_editable/);
  database.prepare(`UPDATE team_calendar_events SET event_type = 'scrim', planner_state = 'open' WHERE id = 10`).run();
  assert.throws(() => updateEvent(database, 10, { title: 'Auch nicht erlaubt' }, 'coach'), /event_not_editable/);
  database.close();
});

test('Teamgebundener Stand-in kann im Planner angelegt werden', () => {
  const database = createTestDatabase();
  const standin = createStandin(database, {
    teamId: 1, displayName: 'Ersatz', riotGameName: 'Ersatzname', riotTag: 'EUW', preferredPosition: 'Jgl'
  }, 'coach');
  assert.equal(standin.teamId, 1);
  assert.equal(standin.preferredPosition, 'Jgl');
  assert.equal(database.prepare('SELECT team_id FROM standins WHERE id = ?').get(standin.id).team_id, 1);
  updateEvent(database, 10, {
    lineup: [
      { role: 'Top', preserve: true },
      { role: 'Jgl', standinId: standin.id },
      { role: 'Mid' }, { role: 'ADC' }, { role: 'Supp' }
    ]
  }, 'coach');
  const assignment = database.prepare(`
    SELECT assignee_type, player_id, standin_id, player_label
    FROM team_calendar_assignments WHERE event_id = 10 AND role_label = 'Jgl'
  `).get();
  assert.equal(assignment.assignee_type, 'standin');
  assert.equal(assignment.player_id, null);
  assert.equal(assignment.standin_id, standin.id);
  assert.equal(assignment.player_label, 'Ersatz');
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
  assert.match(page, /id="own-lineup"/);
});

test('Terminbearbeitung validiert Auswahlfelder und Export erfasst nur Planner-Karten', async () => {
  const database = createTestDatabase();
  database.exec(`
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
    lineup: [
      { role: 'Top', playerId: 7 },
      { role: 'Jgl', playerId: null },
      { role: 'Mid', playerId: null },
      { role: 'ADC', playerId: null },
      { role: 'Supp', playerId: null }
    ],
    opponentLineup: [{ role: 'Top', player: 'Opponent Top' }]
  }, 'coach-1');

  const ownLineup = database.prepare(`SELECT role_label, player_id FROM team_calendar_assignments WHERE event_id = 10`).all();
  assert.equal(ownLineup.length, 1);
  assert.equal(ownLineup[0].role_label, 'Top');
  assert.equal(ownLineup[0].player_id, 7);
  assert.throws(() => updateEvent(database, 10, {
    lineup: [
      { role: 'Top', playerId: 7 },
      { role: 'Jgl', playerId: 7 }
    ]
  }, 'coach-1'), /invalid_lineup/);

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

  database.prepare(`UPDATE team_calendar_events SET event_type = 'open', planner_state = 'preplanned' WHERE id = 10`).run();
  assert.equal(exportPreview(database, '2099-04-06').total, 0);

  database.close();
});
