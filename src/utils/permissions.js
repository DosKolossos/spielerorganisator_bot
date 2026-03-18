const { PermissionFlagsBits } = require('discord.js');

const ADMIN_ROLE_NAME = process.env.ADMIN_ROLE_NAME || 'Schillok | Coaches';

function memberHasNamedRole(member) {
  if (!member?.roles?.cache) return false;
  return member.roles.cache.some(role => role.name === ADMIN_ROLE_NAME);
}

function isAdminMember(member) {
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
      ephemeral: true
    }).catch(() => null);
  } else {
    await interaction.reply({
      content: `Dafür brauchst du die Rolle **${ADMIN_ROLE_NAME}**.`,
      ephemeral: true
    }).catch(() => null);
  }

  return false;
}

module.exports = {
  ADMIN_ROLE_NAME,
  isAdminMember,
  isAdminInteraction,
  requireAdmin
};
