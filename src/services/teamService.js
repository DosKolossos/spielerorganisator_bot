const db = require('../db/database');

function normalizeSlug(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue').replace(/ß/g, 'ss')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'team';
}

function listTeams({ activeOnly = true } = {}) {
  return db.prepare(`
    SELECT * FROM teams
    ${activeOnly ? 'WHERE is_active = 1' : ''}
    ORDER BY is_default DESC, name COLLATE NOCASE ASC
  `).all();
}

function getTeamById(id) {
  return db.prepare('SELECT * FROM teams WHERE id = ?').get(id);
}

function getDefaultTeam() {
  return db.prepare(`SELECT * FROM teams WHERE is_active = 1 ORDER BY is_default DESC, id ASC LIMIT 1`).get();
}

function getTeamForChannel(channelId) {
  if (!channelId) return null;
  return db.prepare(`
    SELECT * FROM teams
    WHERE is_active = 1 AND ? IN (
      admin_channel_id,
      availability_channel_id,
      player_calendar_channel_id,
      scrim_channel_id,
      primeleague_channel_id
    )
    ORDER BY is_default DESC, id ASC
    LIMIT 1
  `).get(channelId);
}

function resolveTeamForInteraction(interaction) {
  return getTeamForChannel(interaction.channelId) || getDefaultTeam();
}

function createTeam({ name, shortName, discordRoleId, adminChannelId, availabilityChannelId, playerCalendarChannelId, scrimChannelId, primeleagueChannelId, createdBy }) {
  const now = new Date().toISOString();
  const slugBase = normalizeSlug(shortName || name);
  let slug = slugBase;
  let suffix = 2;
  while (db.prepare('SELECT 1 FROM teams WHERE slug = ?').get(slug)) slug = `${slugBase}-${suffix++}`;

  const result = db.prepare(`
    INSERT INTO teams (
      name, slug, short_name, discord_role_id, admin_channel_id,
      availability_channel_id, player_calendar_channel_id,
      scrim_channel_id, primeleague_channel_id,
      is_default, is_active, created_by_discord_user_id, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 1, ?, ?, ?)
  `).run(
    name.trim(), slug, shortName?.trim() || null, discordRoleId || null,
    adminChannelId || null, availabilityChannelId || null, playerCalendarChannelId || null,
    scrimChannelId || null, primeleagueChannelId || null,
    createdBy, now, now
  );
  return getTeamById(result.lastInsertRowid);
}

function updateTeam(teamId, patch) {
  const team = getTeamById(teamId);
  if (!team) return null;
  const now = new Date().toISOString();
  db.prepare(`
    UPDATE teams SET
      name = COALESCE(?, name),
      short_name = COALESCE(?, short_name),
      discord_role_id = COALESCE(?, discord_role_id),
      admin_channel_id = COALESCE(?, admin_channel_id),
      availability_channel_id = COALESCE(?, availability_channel_id),
      player_calendar_channel_id = COALESCE(?, player_calendar_channel_id),
      scrim_channel_id = COALESCE(?, scrim_channel_id),
      primeleague_channel_id = COALESCE(?, primeleague_channel_id),
      updated_at = ?
    WHERE id = ?
  `).run(
    patch.name ?? null, patch.short_name ?? null, patch.discord_role_id ?? null,
    patch.admin_channel_id ?? null, patch.availability_channel_id ?? null,
    patch.player_calendar_channel_id ?? null, patch.scrim_channel_id ?? null,
    patch.primeleague_channel_id ?? null, now, teamId
  );
  return getTeamById(teamId);
}

function setDefaultTeam(teamId) {
  const tx = db.transaction(() => {
    db.prepare('UPDATE teams SET is_default = 0').run();
    db.prepare('UPDATE teams SET is_default = 1, updated_at = ? WHERE id = ?').run(new Date().toISOString(), teamId);
  });
  tx();
  return getTeamById(teamId);
}

module.exports = {
  normalizeSlug,
  listTeams,
  getTeamById,
  getDefaultTeam,
  getTeamForChannel,
  resolveTeamForInteraction,
  createTeam,
  updateTeam,
  setDefaultTeam
};
