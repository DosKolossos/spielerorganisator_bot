const { SlashCommandBuilder, MessageFlags } = require('discord.js');
const db = require('../db/database');

function upsertPlayer(user, alias = null) {
  const now = new Date().toISOString();

  const existing = db
    .prepare('SELECT * FROM players WHERE discord_user_id = ?')
    .get(user.id);

  if (!existing) {
    db.prepare(`
      INSERT INTO players (
        discord_user_id,
        username,
        global_name,
        alias,
        created_at,
        updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      user.id,
      user.username,
      user.globalName ?? null,
      alias,
      now,
      now
    );
  } else {
    db.prepare(`
      UPDATE players
      SET username = ?,
          global_name = ?,
          alias = COALESCE(?, alias),
          updated_at = ?
      WHERE discord_user_id = ?
    `).run(
      user.username,
      user.globalName ?? null,
      alias,
      now,
      user.id
    );
  }

  return db
    .prepare('SELECT * FROM players WHERE discord_user_id = ?')
    .get(user.id);
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName('profil')
    .setDescription('Verwalte dein Spielerprofil.')
    .addSubcommand(sub =>
      sub
        .setName('alias-setzen')
        .setDescription('Setzt deinen internen Spielernamen.')
        .addStringOption(option =>
          option
            .setName('alias')
            .setDescription('Dein gewünschter Alias, z. B. DosKolossos')
            .setRequired(true)
        )
    )
    .addSubcommand(sub =>
      sub
        .setName('anzeigen')
        .setDescription('Zeigt dein aktuelles Profil an.')
    ),

  async execute(interaction) {
    const subcommand = interaction.options.getSubcommand();
    const user = interaction.user;

    if (subcommand === 'alias-setzen') {
      const alias = interaction.options.getString('alias', true).trim();

      if (alias.length < 2 || alias.length > 32) {
        return interaction.reply({
          content: 'Alias muss zwischen 2 und 32 Zeichen lang sein.',
          flags: MessageFlags.Ephemeral
        });
      }

      const player = upsertPlayer(user, alias);

      return interaction.reply({
        content:
          `Alias gespeichert.\n` +
          `Discord: **${player.username}**\n` +
          `Alias: **${player.alias}**`,
        flags: MessageFlags.Ephemeral
      });
    }

    if (subcommand === 'anzeigen') {
      const player = upsertPlayer(user);

      return interaction.reply({
        content:
          `**Dein Profil**\n` +
          `Discord-ID: \`${player.discord_user_id}\`\n` +
          `Username: **${player.username}**\n` +
          `Global Name: **${player.global_name ?? '-'}**\n` +
          `Alias: **${player.alias ?? '-'}**`,
        flags: MessageFlags.Ephemeral
      });
    }
  }
};