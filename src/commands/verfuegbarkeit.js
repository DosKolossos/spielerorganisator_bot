const { SlashCommandBuilder, MessageFlags } = require('discord.js');
const { requireAdmin } = require('../utils/permissions');
const {
  publishWeeklyAvailabilityPrompt,
  canHandleInteraction,
  handleInteraction
} = require('../services/weeklyAvailabilityService');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('verfuegbarkeit')
    .setDescription('Verwalte die Wochen-Check-in-Nachricht.')
    .addSubcommand(sub =>
      sub
        .setName('wochenkarten')
        .setDescription('Erstellt oder aktualisiert die Wochen-Check-in-Nachricht im Server.')
    ),

  canHandleInteraction,
  handleInteraction,

  async execute(interaction) {
    if (!(await requireAdmin(interaction))) return;

    const subcommand = interaction.options.getSubcommand();

    if (subcommand === 'wochenkarten') {
      await interaction.reply({
        content: 'Baue Wochenkarten auf ...',
        flags: MessageFlags.Ephemeral
      });

      try {
        const result = await publishWeeklyAvailabilityPrompt(interaction.client);
        await interaction.followUp({
          content: `Wochenkarten aktualisiert.\n\`\`\`json\n${JSON.stringify(result, null, 2)}\n\`\`\``,
          flags: MessageFlags.Ephemeral
        });
      } catch (error) {
        console.error('[Verfuegbarkeit] Wochenkarten-Aufbau fehlgeschlagen:', error);
        await interaction.followUp({
          content: 'Wochenkarten-Aufbau ist fehlgeschlagen. Schau in die Railway-Logs.',
          flags: MessageFlags.Ephemeral
        });
      }
    }
  }
};
