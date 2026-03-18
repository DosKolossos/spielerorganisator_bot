const db = require('../db/database');

async function logAdminAction(client, {
  actorDiscordUserId,
  actorLabel,
  targetDiscordUserId = null,
  targetLabel = null,
  entityType,
  entityId = null,
  actionType,
  details = null
}) {
  const now = new Date().toISOString();

  db.prepare(`
    INSERT INTO admin_audit_log (
      actor_discord_user_id,
      actor_label,
      target_discord_user_id,
      target_label,
      entity_type,
      entity_id,
      action_type,
      details,
      created_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    actorDiscordUserId,
    actorLabel,
    targetDiscordUserId,
    targetLabel,
    entityType,
    entityId,
    actionType,
    details,
    now
  );

  const logChannelId = process.env.ADMIN_LOG_CHANNEL_ID;
  if (!client || !logChannelId) return;

  try {
    const channel = await client.channels.fetch(logChannelId);
    if (!channel?.isTextBased()) return;

    await channel.send(
      `🛡️ **Admin-Aktion**\n` +
      `Admin: **${actorLabel}**\n` +
      `Aktion: **${actionType}**\n` +
      `Bereich: **${entityType}${entityId ? ` #${entityId}` : ''}**\n` +
      `Betroffen: **${targetLabel ?? '-'}**\n` +
      `Details: **${details ?? '-'}**`
    );
  } catch (error) {
    console.warn('[AdminLog] Konnte Eintrag nicht in den Log-Channel senden.', error.message);
  }
}

async function notifyUser(client, discordUserId, message) {
  if (!client || !discordUserId || !message) return { sent: false, reason: 'missing_data' };

  try {
    const user = await client.users.fetch(discordUserId);
    await user.send(message);
    return { sent: true };
  } catch (error) {
    console.warn(`[NotifyUser] Konnte DM an ${discordUserId} nicht senden.`);
    return { sent: false, reason: 'dm_failed' };
  }
}

module.exports = {
  logAdminAction,
  notifyUser
};
