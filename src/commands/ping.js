const { SlashCommandBuilder, MessageFlags } = require('discord.js');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('ping')
    .setDescription('Testet, ob der Bot online ist.'),

  async execute(interaction) {
    await interaction.reply({
      content: 'Pong! Bot läuft.',
      flags: MessageFlags.Ephemeral
    });
  }
};