const db = require('../db/database');

function normalizeRegion(value) {
  if (!value) return 'euw';
  return String(value).trim().toLowerCase() || 'euw';
}

function playerDisplay(player) {
  return player?.alias || player?.global_name || player?.username || player?.discord_user_id || 'Unbekannt';
}

function getPlayerByDiscordUserId(discordUserId) {
  return db.prepare(`
    SELECT *
    FROM players
    WHERE discord_user_id = ?
  `).get(discordUserId);
}

function getPlayerById(id) {
  return db.prepare(`
    SELECT *
    FROM players
    WHERE id = ?
  `).get(id);
}

function upsertPlayer(user, patch = {}) {
  const now = new Date().toISOString();
  const existing = getPlayerByDiscordUserId(user.id);

  if (!existing) {
    db.prepare(`
      INSERT INTO players (
        discord_user_id,
        username,
        global_name,
        alias,
        riot_game_name,
        riot_tag,
        riot_region,
        is_archived,
        created_at,
        updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?)
    `).run(
      user.id,
      user.username,
      user.globalName ?? null,
      patch.alias ?? null,
      patch.riot_game_name ?? null,
      patch.riot_tag ?? null,
      normalizeRegion(patch.riot_region),
      now,
      now
    );
  } else {
    db.prepare(`
      UPDATE players
      SET username = ?,
          global_name = ?,
          alias = CASE
            WHEN ? = '__CLEAR__' THEN NULL
            ELSE COALESCE(?, alias)
          END,
          riot_game_name = CASE
            WHEN ? = '__CLEAR__' THEN NULL
            ELSE COALESCE(?, riot_game_name)
          END,
          riot_tag = CASE
            WHEN ? = '__CLEAR__' THEN NULL
            ELSE COALESCE(?, riot_tag)
          END,
          riot_region = CASE
            WHEN ? = '__CLEAR__' THEN 'euw'
            ELSE COALESCE(?, riot_region, 'euw')
          END,
          updated_at = ?
      WHERE discord_user_id = ?
    `).run(
      user.username,
      user.globalName ?? null,
      patch.alias ?? null,
      patch.alias ?? null,
      patch.riot_game_name ?? null,
      patch.riot_game_name ?? null,
      patch.riot_tag ?? null,
      patch.riot_tag ?? null,
      patch.riot_region ?? null,
      patch.riot_region ? normalizeRegion(patch.riot_region) : null,
      now,
      user.id
    );
  }

  return getPlayerByDiscordUserId(user.id);
}

function archivePlayer(playerId, actorDiscordUserId) {
  const now = new Date().toISOString();
  db.prepare(`
    UPDATE players
    SET is_archived = 1,
        archived_at = ?,
        archived_by_discord_user_id = ?,
        updated_at = ?
    WHERE id = ?
  `).run(now, actorDiscordUserId, now, playerId);

  return getPlayerById(playerId);
}

function restorePlayer(playerId) {
  const now = new Date().toISOString();
  db.prepare(`
    UPDATE players
    SET is_archived = 0,
        archived_at = NULL,
        archived_by_discord_user_id = NULL,
        updated_at = ?
    WHERE id = ?
  `).run(now, playerId);

  return getPlayerById(playerId);
}

module.exports = {
  normalizeRegion,
  playerDisplay,
  getPlayerByDiscordUserId,
  getPlayerById,
  upsertPlayer,
  archivePlayer,
  restorePlayer
};
