const { SlashCommandBuilder, MessageFlags, ChannelType } = require('discord.js');
const { requireAdmin } = require('../utils/permissions');
const db = require('../db/database');
const {
  listTeams, getTeamById, createTeam, updateTeam, setDefaultTeam
} = require('../services/teamService');

function teamChoices() {
  return listTeams({ activeOnly: false }).slice(0, 25).map(team => ({ name: `${team.name}${team.is_default ? ' (Standard)' : ''}`, value: String(team.id) }));
}

function formatTeam(team) {
  const channel = id => id ? `<#${id}>` : '-';
  return [
    `**${team.name}**${team.is_default ? ' ⭐' : ''} (ID: \`${team.id}\`, Kürzel: **${team.short_name || '-'}**)`,
    `Rolle: ${team.discord_role_id ? `<@&${team.discord_role_id}>` : '-'}`,
    `Admin: ${channel(team.admin_channel_id)}`,
    `Verfügbarkeit: ${channel(team.availability_channel_id)}`,
    `Spielerkalender: ${channel(team.player_calendar_channel_id)}`,
    `Scrim: ${channel(team.scrim_channel_id)}`,
    `Prime League: ${channel(team.primeleague_channel_id)}`
  ].join('\n');
}

const data = new SlashCommandBuilder()
  .setName('team')
  .setDescription('Verwaltet Teams und deren private Kanäle.')
  .addSubcommand(sub => sub.setName('liste').setDescription('Zeigt alle eingerichteten Teams.'))
.addSubcommand(sub => sub.setName('erstellen').setDescription('Legt ein neues Team an.')
  .addStringOption(o => o
    .setName('name')
    .setDescription('Teamname')
    .setRequired(true))
  .addChannelOption(o => o
    .setName('admin_kanal')
    .setDescription('Privater Adminkanal')
    .addChannelTypes(ChannelType.GuildText)
    .setRequired(true))
  .addChannelOption(o => o
    .setName('verfuegbarkeit_kanal')
    .setDescription('Kanal für Wochenkarten')
    .addChannelTypes(ChannelType.GuildText)
    .setRequired(true))
  .addChannelOption(o => o
    .setName('spielerkalender_kanal')
    .setDescription('Kanal für gespiegelte Termine')
    .addChannelTypes(ChannelType.GuildText)
    .setRequired(true))
  .addStringOption(o => o
    .setName('kuerzel')
    .setDescription('Kurzes Kürzel, z. B. MAIN oder ACA')
    .setRequired(false))
  .addRoleOption(o => o
    .setName('rolle')
    .setDescription('Discord-Rolle des Teams')
    .setRequired(false))
  .addChannelOption(o => o
    .setName('scrim_kanal')
    .setDescription('Optionaler Scrim-Kanal')
    .addChannelTypes(ChannelType.GuildText)
    .setRequired(false))
  .addChannelOption(o => o
    .setName('primeleague_kanal')
    .setDescription('Optionaler Prime-League-Kanal')
    .addChannelTypes(ChannelType.GuildText)
    .setRequired(false)))
  .addSubcommand(sub => {
    sub.setName('bearbeiten').setDescription('Ändert die Kanäle oder Rolle eines Teams.')
      .addStringOption(o => { o.setName('team').setDescription('Team').setRequired(true); for (const c of teamChoices()) o.addChoices(c); return o; })
      .addStringOption(o => o.setName('name').setDescription('Neuer Teamname').setRequired(false))
      .addStringOption(o => o.setName('kuerzel').setDescription('Neues Kürzel').setRequired(false))
      .addRoleOption(o => o.setName('rolle').setDescription('Discord-Rolle').setRequired(false))
      .addChannelOption(o => o.setName('admin_kanal').setDescription('Adminkanal').addChannelTypes(ChannelType.GuildText).setRequired(false))
      .addChannelOption(o => o.setName('verfuegbarkeit_kanal').setDescription('Wochenkarten-Kanal').addChannelTypes(ChannelType.GuildText).setRequired(false))
      .addChannelOption(o => o.setName('spielerkalender_kanal').setDescription('Spielerkalender-Kanal').addChannelTypes(ChannelType.GuildText).setRequired(false));
    return sub;
  })
  .addSubcommand(sub => {
    sub.setName('standard').setDescription('Setzt das Standardteam für alte/noch nicht zugeordnete Daten.')
      .addStringOption(o => { o.setName('team').setDescription('Team').setRequired(true); for (const c of teamChoices()) o.addChoices(c); return o; });
    return sub;
  })
  .addSubcommand(sub => {
    sub.setName('spieler-zuweisen').setDescription('Ordnet einen Spieler einem Team zu.')
      .addUserOption(o => o.setName('spieler').setDescription('Spieler').setRequired(true))
      .addStringOption(o => { o.setName('team').setDescription('Team').setRequired(true); for (const c of teamChoices()) o.addChoices(c); return o; });
    return sub;
  });

module.exports = {
  data,
  async execute(interaction) {
    if (!(await requireAdmin(interaction))) return;
    const sub = interaction.options.getSubcommand();

    if (sub === 'liste') {
      const teams = listTeams({ activeOnly: false });
      return interaction.reply({ content: teams.length ? teams.map(formatTeam).join('\n\n') : 'Noch keine Teams vorhanden.', flags: MessageFlags.Ephemeral });
    }

    if (sub === 'erstellen') {
      const team = createTeam({
        name: interaction.options.getString('name', true),
        shortName: interaction.options.getString('kuerzel'),
        discordRoleId: interaction.options.getRole('rolle')?.id,
        adminChannelId: interaction.options.getChannel('admin_kanal', true).id,
        availabilityChannelId: interaction.options.getChannel('verfuegbarkeit_kanal', true).id,
        playerCalendarChannelId: interaction.options.getChannel('spielerkalender_kanal', true).id,
        scrimChannelId: interaction.options.getChannel('scrim_kanal')?.id,
        primeleagueChannelId: interaction.options.getChannel('primeleague_kanal')?.id,
        createdBy: interaction.user.id
      });
      return interaction.reply({ content: `Team angelegt.\n\n${formatTeam(team)}`, flags: MessageFlags.Ephemeral });
    }

    const teamId = Number(interaction.options.getString('team', true));
    const team = getTeamById(teamId);
    if (!team) return interaction.reply({ content: 'Team nicht gefunden.', flags: MessageFlags.Ephemeral });

    if (sub === 'bearbeiten') {
      const updated = updateTeam(teamId, {
        name: interaction.options.getString('name'),
        short_name: interaction.options.getString('kuerzel'),
        discord_role_id: interaction.options.getRole('rolle')?.id,
        admin_channel_id: interaction.options.getChannel('admin_kanal')?.id,
        availability_channel_id: interaction.options.getChannel('verfuegbarkeit_kanal')?.id,
        player_calendar_channel_id: interaction.options.getChannel('spielerkalender_kanal')?.id
      });
      return interaction.reply({ content: `Team aktualisiert.\n\n${formatTeam(updated)}`, flags: MessageFlags.Ephemeral });
    }

    if (sub === 'standard') {
      const updated = setDefaultTeam(teamId);
      return interaction.reply({ content: `**${updated.name}** ist jetzt das Standardteam.`, flags: MessageFlags.Ephemeral });
    }

    if (sub === 'spieler-zuweisen') {
      const user = interaction.options.getUser('spieler', true);
      const now = new Date().toISOString();
      const result = db.prepare(`UPDATE players SET team_id = ?, updated_at = ? WHERE discord_user_id = ?`).run(teamId, now, user.id);
      if (!result.changes) return interaction.reply({ content: 'Für diesen Discord-Nutzer existiert noch kein Spielerprofil. Er soll zuerst `/profil anzeigen` oder `/profil alias-setzen` verwenden.', flags: MessageFlags.Ephemeral });
      return interaction.reply({ content: `${user} wurde **${team.name}** zugewiesen.`, flags: MessageFlags.Ephemeral });
    }
  }
};
