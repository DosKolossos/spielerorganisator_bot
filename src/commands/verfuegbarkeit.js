
const { SlashCommandBuilder, MessageFlags } = require('discord.js');
const { requireAdmin } = require('../utils/permissions');
const { postOrRefreshWeeklyAvailabilityCards, canHandleInteraction, handleInteraction } = require('../services/weeklyAvailabilityService');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('verfuegbarkeit')
    .setDescription('Verwaltet die Wochen-Check-in-Karten auf dem Server.')
    .addSubcommand(sub =>
      sub
        .setName('wochenkarten')
        .setDescription('Erstellt oder aktualisiert die Wochenkarten für alle aktiven Spieler.')
    ),

  async execute(interaction) {
    if (!(await requireAdmin(interaction))) return;

    const subcommand = interaction.options.getSubcommand();
    if (subcommand === 'wochenkarten') {
      await interaction.reply({ content: 'Baue Wochenkarten auf …', flags: MessageFlags.Ephemeral });
      try {
        const result = await postOrRefreshWeeklyAvailabilityCards(interaction.client);
        await interaction.followUp({
          content: `Wochenkarten aktualisiert.\n\`\`\`json\n${JSON.stringify(result, null, 2)}\n\`\`\``,
          flags: MessageFlags.Ephemeral
        });
      } catch (error) {
        console.error('[Verfügbarkeit] Wochenkarten fehlgeschlagen:', error);
        await interaction.followUp({
          content: 'Die Wochenkarten konnten nicht aufgebaut werden. Schau in die Railway-Logs.',
          flags: MessageFlags.Ephemeral
        });
      }
    }
  },

  canHandleInteraction,
  handleInteraction
};
