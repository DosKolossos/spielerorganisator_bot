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
db.pragma('foreign_keys = ON');

function quoteIdentifier(value) {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(value)) {
    throw new Error(`Ungültiger SQL-Identifier: ${value}`);
  }

  return `"${value}"`;
}

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

  const safeTableName = quoteIdentifier(tableName);
  const columns = db.prepare(`PRAGMA table_info(${safeTableName})`).all();
  return columns.some(column => column.name === columnName);
}

function addColumnIfMissing(tableName, columnName, definitionSql) {
  if (columnExists(tableName, columnName)) return;

  const safeTableName = quoteIdentifier(tableName);
  const safeColumnName = quoteIdentifier(columnName);
  db.exec(`ALTER TABLE ${safeTableName} ADD COLUMN ${safeColumnName} ${definitionSql};`);
}

db.exec(`
  CREATE TABLE IF NOT EXISTS players (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    discord_user_id TEXT NOT NULL UNIQUE,
    username TEXT NOT NULL,
    global_name TEXT,
    alias TEXT,
    riot_game_name TEXT,
    riot_tag TEXT,
    riot_region TEXT,
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
    admin_channel_id TEXT,
    admin_message_id TEXT,

    start_at TEXT,
    end_at TEXT,
    meeting_at TEXT,

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
    player_id INTEGER,
    note TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE(event_id, role_label),
    FOREIGN KEY(event_id) REFERENCES team_calendar_events(id),
    FOREIGN KEY(player_id) REFERENCES players(id)
  );
`);

function migratePlayers() {
  if (!tableExists('players')) return;

  addColumnIfMissing('players', 'riot_game_name', 'TEXT');
  addColumnIfMissing('players', 'riot_tag', 'TEXT');
  addColumnIfMissing('players', 'riot_region', 'TEXT');

  db.exec(`
    UPDATE players
    SET riot_region = 'euw'
    WHERE riot_region IS NULL OR trim(riot_region) = '';
  `);
}

function migrateAvailabilityRules() {
  addColumnIfMissing('availability_rules', 'recurrence_type', `TEXT NOT NULL DEFAULT 'weekly'`);
  addColumnIfMissing('availability_rules', 'anchor_date', `TEXT`);
  addColumnIfMissing('availability_rules', 'active', `INTEGER NOT NULL DEFAULT 1`);
}

function migrateTeamCalendarEvents() {
  if (!tableExists('team_calendar_events')) return;

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
  addColumnIfMissing('team_calendar_events', 'admin_channel_id', `TEXT`);
  addColumnIfMissing('team_calendar_events', 'admin_message_id', `TEXT`);

  addColumnIfMissing('team_calendar_events', 'start_at', `TEXT`);
  addColumnIfMissing('team_calendar_events', 'end_at', `TEXT`);
  addColumnIfMissing('team_calendar_events', 'meeting_at', `TEXT`);

  db.exec(`
    UPDATE team_calendar_events
    SET
      option_date = COALESCE(
        NULLIF(option_date, ''),
        substr(COALESCE(window_start_at, start_at, scheduled_start_at), 1, 10)
      ),
      window_start_at = COALESCE(
        NULLIF(window_start_at, ''),
        start_at,
        scheduled_start_at
      ),
      window_end_at = COALESCE(
        NULLIF(window_end_at, ''),
        end_at,
        scheduled_end_at
      ),
      scheduled_start_at = CASE
        WHEN scheduled_start_at IS NULL OR scheduled_start_at = '' THEN
          CASE
            WHEN window_start_at IS NULL OR window_start_at = '' THEN start_at
            ELSE NULL
          END
        ELSE scheduled_start_at
      END,
      scheduled_end_at = CASE
        WHEN scheduled_end_at IS NULL OR scheduled_end_at = '' THEN
          CASE
            WHEN window_end_at IS NULL OR window_end_at = '' THEN end_at
            ELSE NULL
          END
        ELSE scheduled_end_at
      END,
      meeting_scrim_at = COALESCE(NULLIF(meeting_scrim_at, ''), meeting_at),
      meeting_primeleague_at = COALESCE(NULLIF(meeting_primeleague_at, ''), meeting_at)
    WHERE
      option_date IS NULL OR option_date = ''
      OR window_start_at IS NULL OR window_start_at = ''
      OR window_end_at IS NULL OR window_end_at = ''
      OR meeting_scrim_at IS NULL OR meeting_scrim_at = ''
      OR meeting_primeleague_at IS NULL OR meeting_primeleague_at = '';
  `);
}

function migrateTeamCalendarAssignments() {
  if (!tableExists('team_calendar_assignments')) return;

  addColumnIfMissing('team_calendar_assignments', 'player_id', `INTEGER`);

  db.exec(`
    UPDATE team_calendar_assignments AS a
    SET player_id = (
      SELECT p.id
      FROM players p
      WHERE
        (p.alias IS NOT NULL AND lower(trim(p.alias)) = lower(trim(a.player_label)))
        OR (p.global_name IS NOT NULL AND lower(trim(p.global_name)) = lower(trim(a.player_label)))
        OR lower(trim(p.username)) = lower(trim(a.player_label))
        OR p.discord_user_id = a.player_label
      ORDER BY
        CASE
          WHEN p.alias IS NOT NULL AND lower(trim(p.alias)) = lower(trim(a.player_label)) THEN 0
          WHEN p.global_name IS NOT NULL AND lower(trim(p.global_name)) = lower(trim(a.player_label)) THEN 1
          WHEN lower(trim(p.username)) = lower(trim(a.player_label)) THEN 2
          ELSE 3
        END,
        p.id ASC
      LIMIT 1
    )
    WHERE player_id IS NULL;
  `);
}

function dedupeSuggestionKeys() {
  if (!tableExists('team_calendar_events') || !columnExists('team_calendar_events', 'suggestion_key')) {
    return;
  }

  const duplicateGroups = db.prepare(`
    SELECT suggestion_key
    FROM team_calendar_events
    WHERE suggestion_key IS NOT NULL
      AND suggestion_key <> ''
    GROUP BY suggestion_key
    HAVING COUNT(*) > 1
  `).all();

  if (duplicateGroups.length === 0) return;

  const selectRows = db.prepare(`
    SELECT
      id,
      status,
      is_auto_generated,
      updated_at,
      created_at
    FROM team_calendar_events
    WHERE suggestion_key = ?
    ORDER BY
      CASE WHEN is_auto_generated = 0 THEN 0 ELSE 1 END ASC,
      CASE WHEN status <> 'pending' THEN 0 ELSE 1 END ASC,
      COALESCE(NULLIF(updated_at, ''), NULLIF(created_at, ''), '') DESC,
      id DESC
  `);

  const clearSuggestionKey = db.prepare(`
    UPDATE team_calendar_events
    SET suggestion_key = NULL
    WHERE id = ?
  `);

  const tx = db.transaction(groups => {
    for (const group of groups) {
      const rows = selectRows.all(group.suggestion_key);
      const [, ...duplicates] = rows;

      for (const row of duplicates) {
        clearSuggestionKey.run(row.id);
      }
    }
  });

  tx(duplicateGroups);
}

migratePlayers();
migrateAvailabilityRules();
migrateTeamCalendarEvents();
migrateTeamCalendarAssignments();
dedupeSuggestionKeys();

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

db.exec(`
  CREATE INDEX IF NOT EXISTS idx_team_calendar_assignments_player
  ON team_calendar_assignments (player_id);
`);

module.exports = db;
