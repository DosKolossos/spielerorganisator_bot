const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const dataDir = path.join(process.cwd(), 'data');
if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

const dbPath = path.join(dataDir, 'spielerorganisator.db');
const db = new Database(dbPath);

db.pragma('journal_mode = WAL');

function tableExists(tableName) {
  const row = db.prepare(`
    SELECT name
    FROM sqlite_master
    WHERE type = 'table' AND name = ?
  `).get(tableName);

  return !!row;
}

function columnExists(tableName, columnName) {
  if (!tableExists(tableName)) return false;

  const columns = db.prepare(`PRAGMA table_info(${tableName})`).all();
  return columns.some(column => column.name === columnName);
}

function addColumnIfMissing(tableName, columnName, definitionSql) {
  if (!columnExists(tableName, columnName)) {
    db.exec(`ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${definitionSql};`);
  }
}

db.exec(`
  CREATE TABLE IF NOT EXISTS players (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    discord_user_id TEXT NOT NULL UNIQUE,
    username TEXT NOT NULL,
    global_name TEXT,
    alias TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS availability_entries (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    player_id INTEGER NOT NULL,
    entry_type TEXT NOT NULL DEFAULT 'absence',
    start_at TEXT NOT NULL,
    end_at TEXT NOT NULL,
    reason TEXT,
    created_by_discord_user_id TEXT NOT NULL,
    updated_by_discord_user_id TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    FOREIGN KEY(player_id) REFERENCES players(id)
  );
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS availability_rules (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    player_id INTEGER NOT NULL,
    weekday_mask INTEGER NOT NULL DEFAULT 0,
    rule_type TEXT NOT NULL,
    time_value TEXT,
    note TEXT,
    recurrence_type TEXT NOT NULL DEFAULT 'weekly',
    anchor_date TEXT,
    active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    FOREIGN KEY(player_id) REFERENCES players(id)
  );
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS job_runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    job_name TEXT NOT NULL,
    run_key TEXT NOT NULL UNIQUE,
    created_at TEXT NOT NULL
  );
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS team_calendar_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    event_type TEXT NOT NULL DEFAULT 'scrim',
    status TEXT NOT NULL DEFAULT 'pending',
    option_date TEXT NOT NULL,
    window_start_at TEXT NOT NULL,
    window_end_at TEXT NOT NULL,
    scheduled_start_at TEXT,
    scheduled_end_at TEXT,
    meeting_scrim_at TEXT,
    meeting_primeleague_at TEXT,
    available_players_text TEXT,
    opgg_url TEXT,
    note TEXT,
    suggestion_key TEXT,
    is_auto_generated INTEGER NOT NULL DEFAULT 0,
    created_by_discord_user_id TEXT NOT NULL,
    updated_by_discord_user_id TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS team_calendar_assignments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    event_id INTEGER NOT NULL,
    role_label TEXT NOT NULL,
    player_label TEXT NOT NULL,
    note TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE(event_id, role_label),
    FOREIGN KEY(event_id) REFERENCES team_calendar_events(id)
  );
`);

// ---- Migrationen zuerst ----

addColumnIfMissing('availability_rules', 'recurrence_type', `TEXT NOT NULL DEFAULT 'weekly'`);
addColumnIfMissing('availability_rules', 'anchor_date', `TEXT`);
addColumnIfMissing('availability_rules', 'active', `INTEGER NOT NULL DEFAULT 1`);

if (tableExists('team_calendar_events')) {
  addColumnIfMissing('team_calendar_events', 'option_date', `TEXT`);
  addColumnIfMissing('team_calendar_events', 'window_start_at', `TEXT`);
  addColumnIfMissing('team_calendar_events', 'window_end_at', `TEXT`);
  addColumnIfMissing('team_calendar_events', 'scheduled_start_at', `TEXT`);
  addColumnIfMissing('team_calendar_events', 'scheduled_end_at', `TEXT`);
  addColumnIfMissing('team_calendar_events', 'meeting_scrim_at', `TEXT`);
  addColumnIfMissing('team_calendar_events', 'meeting_primeleague_at', `TEXT`);
  addColumnIfMissing('team_calendar_events', 'available_players_text', `TEXT`);
  addColumnIfMissing('team_calendar_events', 'opgg_url', `TEXT`);
  addColumnIfMissing('team_calendar_events', 'note', `TEXT`);
  addColumnIfMissing('team_calendar_events', 'suggestion_key', `TEXT`);
  addColumnIfMissing('team_calendar_events', 'is_auto_generated', `INTEGER NOT NULL DEFAULT 0`);

  const hasOldStartAt = columnExists('team_calendar_events', 'start_at');
  const hasOldEndAt = columnExists('team_calendar_events', 'end_at');
  const hasOldMeetingAt = columnExists('team_calendar_events', 'meeting_at');

  if (hasOldStartAt && hasOldEndAt) {
    db.exec(`
      UPDATE team_calendar_events
      SET
        option_date = COALESCE(option_date, substr(start_at, 1, 10)),
        window_start_at = COALESCE(window_start_at, start_at),
        window_end_at = COALESCE(window_end_at, end_at),
        scheduled_start_at = COALESCE(scheduled_start_at, start_at),
        scheduled_end_at = COALESCE(scheduled_end_at, end_at)
      WHERE
        option_date IS NULL
        OR window_start_at IS NULL
        OR window_end_at IS NULL
        OR scheduled_start_at IS NULL
        OR scheduled_end_at IS NULL;
    `);
  }

  if (hasOldMeetingAt) {
    db.exec(`
      UPDATE team_calendar_events
      SET
        meeting_scrim_at = COALESCE(meeting_scrim_at, meeting_at),
        meeting_primeleague_at = COALESCE(meeting_primeleague_at, meeting_at)
      WHERE
        meeting_scrim_at IS NULL
        OR meeting_primeleague_at IS NULL;
    `);
  }

  // Fallback für halb migrierte Datensätze ohne alte Spalten
  db.exec(`
    UPDATE team_calendar_events
    SET option_date = substr(window_start_at, 1, 10)
    WHERE option_date IS NULL
      AND window_start_at IS NOT NULL;
  `);

  db.exec(`
    UPDATE team_calendar_events
    SET scheduled_start_at = window_start_at
    WHERE scheduled_start_at IS NULL
      AND window_start_at IS NOT NULL;
  `);

  db.exec(`
    UPDATE team_calendar_events
    SET scheduled_end_at = window_end_at
    WHERE scheduled_end_at IS NULL
      AND window_end_at IS NOT NULL;
  `);
}

// ---- Indexe erst nach Migrationen ----

db.exec(`
  CREATE INDEX IF NOT EXISTS idx_availability_entries_player_time
  ON availability_entries (player_id, start_at, end_at);
`);

db.exec(`
  CREATE INDEX IF NOT EXISTS idx_availability_rules_player_active
  ON availability_rules (player_id, active);
`);

db.exec(`
  CREATE INDEX IF NOT EXISTS idx_team_calendar_events_option_date
  ON team_calendar_events (option_date, status);
`);

db.exec(`
  CREATE UNIQUE INDEX IF NOT EXISTS idx_team_calendar_events_suggestion_key_unique
  ON team_calendar_events (suggestion_key)
  WHERE suggestion_key IS NOT NULL;
`);

db.exec(`
  CREATE INDEX IF NOT EXISTS idx_team_calendar_assignments_event
  ON team_calendar_assignments (event_id);
`);

module.exports = db;