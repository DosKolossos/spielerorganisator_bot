const { SlashCommandBuilder, MessageFlags } = require('discord.js');
const { requireAdmin } = require('../utils/permissions');
const {
  buildAvailabilityRangeModal,
  canHandleInteraction,
  handleInteraction
} = require('../services/weeklyAvailabilityService');
const { resolveTeamForInteraction } = require('../services/teamService');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('verfuegbarkeit')
    .setDescription('Verwalte die Wochen-Check-in-Nachrichten.')
    .addSubcommand(sub =>
      sub
        .setName('wochenkarten')
        .setDescription('Erstellt oder aktualisiert Wochen-Check-in-Nachrichten für einen Zeitraum.')
    ),

  canHandleInteraction,
  handleInteraction,

  async execute(interaction) {
    if (!(await requireAdmin(interaction))) return;
    const subcommand = interaction.options.getSubcommand();

    if (subcommand === 'wochenkarten') {
      try {
        const team = resolveTeamForInteraction(interaction);
        if (!team) {
          return interaction.reply({ content: 'Für diesen Kanal ist kein Team eingerichtet.', flags: MessageFlags.Ephemeral });
        }
        await interaction.showModal(buildAvailabilityRangeModal(team.id));
      } catch (error) {
        console.error('[Verfuegbarkeit] Zeitraum-Modal konnte nicht geöffnet werden:', error);
        if (!interaction.replied && !interaction.deferred) {
          await interaction.reply({
            content: 'Das Zeitraum-Popup konnte nicht geöffnet werden. Schau in die Logs.',
            flags: MessageFlags.Ephemeral
          });
        }
      }
    }
  }
};
