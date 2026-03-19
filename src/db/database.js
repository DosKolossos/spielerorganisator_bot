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
    is_archived INTEGER NOT NULL DEFAULT 0,
    archived_at TEXT,
    archived_by_discord_user_id TEXT,
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
    approval_status TEXT NOT NULL DEFAULT 'approved',
    reviewed_by_discord_user_id TEXT,
    reviewed_at TEXT,
    review_note TEXT,
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
    suspended_from TEXT,
    suspended_until TEXT,
    suspension_note TEXT,
    suspended_by_discord_user_id TEXT,
    suspended_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    FOREIGN KEY(player_id) REFERENCES players(id)
  );
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS admin_audit_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    actor_discord_user_id TEXT NOT NULL,
    actor_label TEXT NOT NULL,
    target_discord_user_id TEXT,
    target_label TEXT,
    entity_type TEXT NOT NULL,
    entity_id INTEGER,
    action_type TEXT NOT NULL,
    details TEXT,
    created_at TEXT NOT NULL
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
  CREATE TABLE IF NOT EXISTS birthdays (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    birthday_month INTEGER NOT NULL,
    birthday_day INTEGER NOT NULL,
    note TEXT,
    created_by_discord_user_id TEXT NOT NULL,
    updated_by_discord_user_id TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
`);

db.exec(`
  CREATE INDEX IF NOT EXISTS idx_birthdays_month_day
  ON birthdays (birthday_month, birthday_day);
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS team_calendar_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    opponent_name TEXT,
    event_type TEXT NOT NULL DEFAULT 'open',
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
    player_channel_id TEXT,
    player_message_id TEXT,
    show_in_player_calendar INTEGER NOT NULL DEFAULT 0,

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
  addColumnIfMissing('players', 'is_archived', 'INTEGER NOT NULL DEFAULT 0');
  addColumnIfMissing('players', 'archived_at', 'TEXT');
  addColumnIfMissing('players', 'archived_by_discord_user_id', 'TEXT');

  db.exec(`
    UPDATE players
    SET riot_region = 'euw'
    WHERE riot_region IS NULL OR trim(riot_region) = '';
  `);
}

function migrateAvailabilityEntries() {
  if (!tableExists('availability_entries')) return;

  addColumnIfMissing('availability_entries', 'approval_status', `TEXT NOT NULL DEFAULT 'approved'`);
  addColumnIfMissing('availability_entries', 'reviewed_by_discord_user_id', `TEXT`);
  addColumnIfMissing('availability_entries', 'reviewed_at', `TEXT`);
  addColumnIfMissing('availability_entries', 'review_note', `TEXT`);

  db.exec(`
    UPDATE availability_entries
    SET approval_status = 'approved'
    WHERE approval_status IS NULL OR trim(approval_status) = '';
  `);
}

function migrateAvailabilityRules() {
  if (!tableExists('availability_rules')) return;

  addColumnIfMissing('availability_rules', 'recurrence_type', `TEXT NOT NULL DEFAULT 'weekly'`);
  addColumnIfMissing('availability_rules', 'anchor_date', `TEXT`);
  addColumnIfMissing('availability_rules', 'active', `INTEGER NOT NULL DEFAULT 1`);
  addColumnIfMissing('availability_rules', 'suspended_from', `TEXT`);
  addColumnIfMissing('availability_rules', 'suspended_until', `TEXT`);
  addColumnIfMissing('availability_rules', 'suspension_note', `TEXT`);
  addColumnIfMissing('availability_rules', 'suspended_by_discord_user_id', `TEXT`);
  addColumnIfMissing('availability_rules', 'suspended_at', `TEXT`);
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
  addColumnIfMissing('team_calendar_events', 'opponent_name', `TEXT`);

  addColumnIfMissing('team_calendar_events', 'opgg_url', `TEXT`);
  addColumnIfMissing('team_calendar_events', 'note', `TEXT`);
  addColumnIfMissing('team_calendar_events', 'suggestion_key', `TEXT`);
  addColumnIfMissing('team_calendar_events', 'is_auto_generated', `INTEGER NOT NULL DEFAULT 0`);
  addColumnIfMissing('team_calendar_events', 'admin_channel_id', `TEXT`);
  addColumnIfMissing('team_calendar_events', 'admin_message_id', `TEXT`);
  addColumnIfMissing('team_calendar_events', 'player_channel_id', `TEXT`);
  addColumnIfMissing('team_calendar_events', 'player_message_id', `TEXT`);
  addColumnIfMissing('team_calendar_events', 'show_in_player_calendar', `INTEGER NOT NULL DEFAULT 0`);

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

  db.exec(`
    UPDATE team_calendar_events
    SET event_type = 'open'
    WHERE event_type IS NULL OR trim(event_type) = '' OR event_type = 'scrim';
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

function migrateTeamCalendarAssignments() {
  if (!tableExists('team_calendar_assignments')) return;

  addColumnIfMissing('team_calendar_assignments', 'player_id', `INTEGER`);

  if (!columnExists('team_calendar_assignments', 'player_label')) return;

  db.exec(`
    UPDATE team_calendar_assignments
    SET player_id = (
      SELECT p.id
      FROM players p
      WHERE p.alias IS NOT NULL
        AND lower(trim(p.alias)) = lower(trim(team_calendar_assignments.player_label))
      ORDER BY p.id ASC
      LIMIT 1
    )
    WHERE player_id IS NULL
      AND player_label IS NOT NULL;
  `);

  db.exec(`
    UPDATE team_calendar_assignments
    SET player_id = (
      SELECT p.id
      FROM players p
      WHERE p.global_name IS NOT NULL
        AND lower(trim(p.global_name)) = lower(trim(team_calendar_assignments.player_label))
      ORDER BY p.id ASC
      LIMIT 1
    )
    WHERE player_id IS NULL
      AND player_label IS NOT NULL;
  `);

  db.exec(`
    UPDATE team_calendar_assignments
    SET player_id = (
      SELECT p.id
      FROM players p
      WHERE lower(trim(p.username)) = lower(trim(team_calendar_assignments.player_label))
      ORDER BY p.id ASC
      LIMIT 1
    )
    WHERE player_id IS NULL
      AND player_label IS NOT NULL;
  `);

  db.exec(`
    UPDATE team_calendar_assignments
    SET player_id = (
      SELECT p.id
      FROM players p
      WHERE p.discord_user_id = team_calendar_assignments.player_label
      ORDER BY p.id ASC
      LIMIT 1
    )
    WHERE player_id IS NULL
      AND player_label IS NOT NULL;
  `);
}

migratePlayers();
migrateAvailabilityEntries();
migrateAvailabilityRules();
migrateTeamCalendarEvents();
dedupeSuggestionKeys();
migrateTeamCalendarAssignments();

db.exec(`
  CREATE INDEX IF NOT EXISTS idx_players_archived
  ON players (is_archived);
`);

db.exec(`
  CREATE INDEX IF NOT EXISTS idx_availability_entries_player_time
  ON availability_entries (player_id, start_at, end_at);
`);

db.exec(`
  CREATE INDEX IF NOT EXISTS idx_availability_entries_status
  ON availability_entries (approval_status, start_at, end_at);
`);

db.exec(`
  CREATE INDEX IF NOT EXISTS idx_availability_rules_player_active
  ON availability_rules (player_id, active);
`);

db.exec(`
  CREATE INDEX IF NOT EXISTS idx_admin_audit_log_created
  ON admin_audit_log (created_at DESC);
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
