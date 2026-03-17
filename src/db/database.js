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
    start_at TEXT NOT NULL,
    end_at TEXT NOT NULL,
    meeting_at TEXT NOT NULL,
    note TEXT,
    created_by_discord_user_id TEXT NOT NULL,
    updated_by_discord_user_id TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
`);

db.exec(`
  CREATE INDEX IF NOT EXISTS idx_availability_entries_player_time
  ON availability_entries (player_id, start_at, end_at);
`);

db.exec(`
  CREATE INDEX IF NOT EXISTS idx_availability_rules_player_active
  ON availability_rules (player_id, active);
`);

db.exec(`
  CREATE INDEX IF NOT EXISTS idx_team_calendar_events_time
  ON team_calendar_events (start_at, status);
`);

function columnExists(tableName, columnName) {
  const columns = db.prepare(`PRAGMA table_info(${tableName})`).all();
  return columns.some(column => column.name === columnName);
}

if (!columnExists('availability_rules', 'recurrence_type')) {
  db.exec(`
    ALTER TABLE availability_rules
    ADD COLUMN recurrence_type TEXT NOT NULL DEFAULT 'weekly';
  `);
}

if (!columnExists('availability_rules', 'anchor_date')) {
  db.exec(`
    ALTER TABLE availability_rules
    ADD COLUMN anchor_date TEXT;
  `);
}

if (!columnExists('availability_rules', 'active')) {
  db.exec(`
    ALTER TABLE availability_rules
    ADD COLUMN active INTEGER NOT NULL DEFAULT 1;
  `);
}

if (!columnExists('team_calendar_events', 'note')) {
  db.exec(`
    ALTER TABLE team_calendar_events
    ADD COLUMN note TEXT;
  `);
}

module.exports = db;