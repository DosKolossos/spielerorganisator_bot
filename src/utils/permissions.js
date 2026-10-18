const { PermissionFlagsBits, MessageFlags } = require('discord.js');
const ADMIN_ROLE_NAME = process.env.ADMIN_ROLE_NAME || 'Schillok | Coaches';
const ADMIN_USER_IDS = new Set(
  String(process.env.ADMIN_USER_IDS || '')
    .split(/[\s,]+/)
    .map(value => value.trim())
    .filter(Boolean)
);

function memberHasNamedRole(member) {
  if (!member?.roles?.cache) return false;
  return member.roles.cache.some(role => role.name === ADMIN_ROLE_NAME);
}

function isAdminMember(member) {
  const userId = String(member?.user?.id || member?.id || '');

  // Sobald eine explizite Liste gesetzt ist, ist sie die alleinige Quelle
  // für Verwaltungsrechte. Das ist für getrennte Gastinstanzen wichtig,
  // damit Server-Admins nicht automatisch Zugriff auf den Planer erhalten.
  if (ADMIN_USER_IDS.size > 0) {
    return ADMIN_USER_IDS.has(userId);
  }

  return Boolean(
    memberHasNamedRole(member) ||
    member?.permissions?.has?.(PermissionFlagsBits.Administrator) ||
    member?.permissions?.has?.(PermissionFlagsBits.ManageGuild)
  );
}

function isAdminInteraction(interaction) {
  return isAdminMember(interaction?.member);
}

async function requireAdmin(interaction) {
  if (isAdminInteraction(interaction)) return true;

  if (interaction.replied || interaction.deferred) {
    await interaction.followUp({
      content: `Dafür brauchst du die Rolle **${ADMIN_ROLE_NAME}**.`,
      flags: MessageFlags.Ephemeral
    }).catch(() => null);
  } else {
    await interaction.reply({
      content: `Dafür brauchst du die Rolle **${ADMIN_ROLE_NAME}**.`,
      flags: MessageFlags.Ephemeral
    }).catch(() => null);
  }

  return false;
}

module.exports = {
  ADMIN_ROLE_NAME,
  ADMIN_USER_IDS,
  isAdminMember,
  isAdminInteraction,
  requireAdmin
};
