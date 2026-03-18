const { SlashCommandBuilder } = require('discord.js');
const db = require('../db/database');

const REGION_CHOICES = [
  { name: 'EUW', value: 'euw' },
  { name: 'EUNE', value: 'eune' },
  { name: 'NA', value: 'na' },
  { name: 'KR', value: 'kr' },
  { name: 'OCE', value: 'oce' },
  { name: 'TR', value: 'tr' },
  { name: 'BR', value: 'br' },
  { name: 'JP', value: 'jp' },
  { name: 'LAN', value: 'lan' },
  { name: 'LAS', value: 'las' },
  { name: 'RU', value: 'ru' }
];

function upsertPlayer(user, patch = {}) {
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
        riot_game_name,
        riot_tag,
        riot_region,
        created_at,
        updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      user.id,
      user.username,
      user.globalName ?? null,
      patch.alias ?? null,
      patch.riot_game_name ?? null,
      patch.riot_tag ?? null,
      patch.riot_region ?? 'euw',
      now,
      now
    );
  } else {
    db.prepare(`
      UPDATE players
      SET username = ?,
          global_name = ?,
          alias = COALESCE(?, alias),
          riot_game_name = COALESCE(?, riot_game_name),
          riot_tag = COALESCE(?, riot_tag),
          riot_region = COALESCE(?, riot_region, 'euw'),
          updated_at = ?
      WHERE discord_user_id = ?
    `).run(
      user.username,
      user.globalName ?? null,
      patch.alias ?? null,
      patch.riot_game_name ?? null,
      patch.riot_tag ?? null,
      patch.riot_region ?? null,
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
        .setName('riot-setzen')
        .setDescription('Speichert deinen Riot Game Name, Tag und optional die Region für OPGG.')
        .addStringOption(option =>
          option
            .setName('game_name')
            .setDescription('Dein Riot Game Name, z. B. DosKolossos')
            .setRequired(true)
        )
        .addStringOption(option =>
          option
            .setName('tag')
            .setDescription('Dein Riot Tag, z. B. EUW')
            .setRequired(true)
        )
        .addStringOption(option => {
          option
            .setName('region')
            .setDescription('Deine OPGG-Region (optional, Standard: EUW)')
            .setRequired(false);

          for (const choice of REGION_CHOICES) {
            option.addChoices(choice);
          }

          return option;
        })
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
          ephemeral: true
        });
      }

      const player = upsertPlayer(user, { alias });

      return interaction.reply({
        content:
          `Alias gespeichert.\n` +
          `Discord: **${player.username}**\n` +
          `Alias: **${player.alias}**`,
        ephemeral: true
      });
    }

    if (subcommand === 'riot-setzen') {
      const riotGameName = interaction.options.getString('game_name', true).trim();
      const riotTag = interaction.options.getString('tag', true).trim().replace(/^#/, '').toUpperCase();
      const riotRegionInput = interaction.options.getString('region');
      const riotRegion = riotRegionInput ? riotRegionInput.trim().toLowerCase() : undefined;

      if (riotGameName.length < 2 || riotGameName.length > 32) {
        return interaction.reply({
          content: 'Der Riot Game Name muss zwischen 2 und 32 Zeichen lang sein.',
          ephemeral: true
        });
      }

      if (riotTag.length < 2 || riotTag.length > 10) {
        return interaction.reply({
          content: 'Der Riot-Tag muss zwischen 2 und 10 Zeichen lang sein.',
          ephemeral: true
        });
      }

      const player = upsertPlayer(user, {
        riot_game_name: riotGameName,
        riot_tag: riotTag,
        riot_region: riotRegion
      });

      return interaction.reply({
        content:
          `Riot-Daten gespeichert.\n` +
          `Riot-ID: **${player.riot_game_name}#${player.riot_tag}**\n` +
          `Region: **${(player.riot_region ?? 'euw').toUpperCase()}**`,
        ephemeral: true
      });
    }

    if (subcommand === 'anzeigen') {
      const player = upsertPlayer(user);

      const riotId = player.riot_game_name && player.riot_tag
        ? `${player.riot_game_name}#${player.riot_tag}`
        : '-';

      return interaction.reply({
        content:
          `**Dein Profil**\n` +
          `Discord-ID: \`${player.discord_user_id}\`\n` +
          `Username: **${player.username}**\n` +
          `Global Name: **${player.global_name ?? '-'}**\n` +
          `Alias: **${player.alias ?? '-'}**\n` +
          `Riot-ID: **${riotId}**\n` +
          `OPGG-Region: **${(player.riot_region ?? '-').toUpperCase()}**`,
        ephemeral: true
      });
    }
  }
};