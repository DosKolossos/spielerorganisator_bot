const { SlashCommandBuilder, MessageFlags } = require('discord.js');
const db = require('../db/database');
const { requireAdmin } = require('../utils/permissions');
const { logAdminAction, notifyUser } = require('../utils/adminTools');
const {
  upsertPlayer,
  getPlayerByDiscordUserId,
  playerDisplay,
  archivePlayer,
  restorePlayer
} = require('../utils/playerUtils');

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

function formatProfile(player, heading = 'Dein Profil') {
  const riotId = player.riot_game_name && player.riot_tag
    ? `${player.riot_game_name}#${player.riot_tag}`
    : '-';

  return (
    `**${heading}**\n` +
    `Discord-ID: \`${player.discord_user_id}\`\n` +
    `Username: **${player.username}**\n` +
    `Global Name: **${player.global_name ?? '-'}**\n` +
    `Alias: **${player.alias ?? '-'}**\n` +
    `Riot-ID: **${riotId}**\n` +
    `OPGG-Region: **${(player.riot_region ?? 'euw').toUpperCase()}**\n` +
    `Archiviert: **${player.is_archived ? 'Ja' : 'Nein'}**`
  );
}

function patchValue(input) {
  if (input === null || input === undefined) return undefined;
  const trimmed = input.trim();
  return trimmed === '-' ? '__CLEAR__' : trimmed;
}

const command = {
  data: new SlashCommandBuilder()
    .setName('profil')
    .setDescription('Verwalte Spielerprofile.')
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

          for (const choice of REGION_CHOICES) option.addChoices(choice);
          return option;
        })
    )
    .addSubcommand(sub =>
      sub
        .setName('anzeigen')
        .setDescription('Zeigt dein aktuelles Profil an.')
    )
    .addSubcommand(sub =>
      sub
        .setName('admin-anzeigen')
        .setDescription('Zeigt das Profil eines Spielers an.')
        .addUserOption(option =>
          option.setName('spieler').setDescription('Betroffener Spieler').setRequired(true)
        )
    )
    .addSubcommand(sub => {
      sub
        .setName('admin-bearbeiten')
        .setDescription('Bearbeitet ein Profil als Admin.')
        .addUserOption(option =>
          option.setName('spieler').setDescription('Betroffener Spieler').setRequired(true)
        )
        .addStringOption(option =>
          option.setName('alias').setDescription('Neuer Alias, "-" löscht den Alias').setRequired(false)
        )
        .addStringOption(option =>
          option.setName('game_name').setDescription('Neuer Riot Game Name, "-" löscht ihn').setRequired(false)
        )
        .addStringOption(option =>
          option.setName('tag').setDescription('Neuer Riot Tag, "-" löscht ihn').setRequired(false)
        )
        .addStringOption(option => {
          option
            .setName('region')
            .setDescription('Neue Region (optional)')
            .setRequired(false);
          for (const choice of REGION_CHOICES) option.addChoices(choice);
          return option;
        });
      return sub;
    })
    .addSubcommand(sub =>
      sub
        .setName('admin-archivieren')
        .setDescription('Archiviert einen Spieler, damit er nicht mehr in Planung und Auswahl auftaucht.')
        .addUserOption(option =>
          option.setName('spieler').setDescription('Betroffener Spieler').setRequired(true)
        )
    )
    .addSubcommand(sub =>
      sub
        .setName('admin-wiederherstellen')
        .setDescription('Hebt die Archivierung eines Spielers wieder auf.')
        .addUserOption(option =>
          option.setName('spieler').setDescription('Betroffener Spieler').setRequired(true)
        )
    ),

  async execute(interaction) {
    const subcommand = interaction.options.getSubcommand();
    const user = interaction.user;

    if (subcommand === 'alias-setzen') {
      const alias = interaction.options.getString('alias', true).trim();
      if (alias.length < 2 || alias.length > 32) {
        return interaction.reply({ content: 'Alias muss zwischen 2 und 32 Zeichen lang sein.', flags: MessageFlags.Ephemeral });
      }

      const player = upsertPlayer(user, { alias });
      return interaction.reply({
        content: `Alias gespeichert.\nDiscord: **${player.username}**\nAlias: **${player.alias}**`,
        flags: MessageFlags.Ephemeral
      });
    }

    if (subcommand === 'riot-setzen') {
      const riotGameName = interaction.options.getString('game_name', true).trim();
      const riotTag = interaction.options.getString('tag', true).trim().replace(/^#/, '').toUpperCase();
      const riotRegionInput = interaction.options.getString('region');
      const riotRegion = riotRegionInput ? riotRegionInput.trim().toLowerCase() : undefined;

      if (riotGameName.length < 2 || riotGameName.length > 32) {
        return interaction.reply({ content: 'Der Riot Game Name muss zwischen 2 und 32 Zeichen lang sein.', flags: MessageFlags.Ephemeral });
      }

      if (riotTag.length < 2 || riotTag.length > 10) {
        return interaction.reply({ content: 'Der Riot-Tag muss zwischen 2 und 10 Zeichen lang sein.', flags: MessageFlags.Ephemeral });
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
        flags: MessageFlags.Ephemeral
      });
    }

    if (subcommand === 'anzeigen') {
      const player = upsertPlayer(user);
      return interaction.reply({ content: formatProfile(player), flags: MessageFlags.Ephemeral });
    }

    if (!(await requireAdmin(interaction))) return;

    const targetUser = interaction.options.getUser('spieler', true);
    const targetPlayer = upsertPlayer(targetUser);

    if (subcommand === 'admin-anzeigen') {
      return interaction.reply({
        content: formatProfile(targetPlayer, `Profil von ${playerDisplay(targetPlayer)}`),
        flags: MessageFlags.Ephemeral
      });
    }

    if (subcommand === 'admin-bearbeiten') {
      const alias = patchValue(interaction.options.getString('alias'));
      const riotGameName = patchValue(interaction.options.getString('game_name'));
      let riotTag = patchValue(interaction.options.getString('tag'));
      if (typeof riotTag === 'string' && riotTag !== '__CLEAR__') riotTag = riotTag.replace(/^#/, '').toUpperCase();
      const riotRegionInput = interaction.options.getString('region');
      const riotRegion = riotRegionInput ? riotRegionInput.trim().toLowerCase() : undefined;

      const now = new Date().toISOString();
      db.prepare(`
        UPDATE players
        SET alias = CASE WHEN ? = '__CLEAR__' THEN NULL ELSE COALESCE(?, alias) END,
            riot_game_name = CASE WHEN ? = '__CLEAR__' THEN NULL ELSE COALESCE(?, riot_game_name) END,
            riot_tag = CASE WHEN ? = '__CLEAR__' THEN NULL ELSE COALESCE(?, riot_tag) END,
            riot_region = COALESCE(?, riot_region, 'euw'),
            updated_at = ?
        WHERE id = ?
      `).run(
        alias ?? null,
        alias ?? null,
        riotGameName ?? null,
        riotGameName ?? null,
        riotTag ?? null,
        riotTag ?? null,
        riotRegion ?? null,
        now,
        targetPlayer.id
      );

      const updated = getPlayerByDiscordUserId(targetUser.id);
      const adminLabel = interaction.member?.displayName || interaction.user.username;
      const targetLabel = playerDisplay(updated);

      await notifyUser(interaction.client, targetUser.id,
        `🛠️ Dein Profil wurde von **${adminLabel}** angepasst.\n${formatProfile(updated, 'Aktueller Stand')}`
      );
      await logAdminAction(interaction.client, {
        actorDiscordUserId: interaction.user.id,
        actorLabel: adminLabel,
        targetDiscordUserId: targetUser.id,
        targetLabel,
        entityType: 'profil',
        entityId: updated.id,
        actionType: 'bearbeitet',
        details: 'Alias/Riot-Daten angepasst'
      });

      return interaction.reply({
        content: `Profil aktualisiert.\n${formatProfile(updated, `Profil von ${targetLabel}`)}`,
        flags: MessageFlags.Ephemeral
      });
    }

    if (subcommand === 'admin-archivieren') {
      const archived = archivePlayer(targetPlayer.id, interaction.user.id);
      const adminLabel = interaction.member?.displayName || interaction.user.username;
      await notifyUser(interaction.client, targetUser.id,
        `📦 Dein Spielerprofil wurde von **${adminLabel}** archiviert. Du tauchst damit nicht mehr in Planung, Auswahl und Erinnerungen auf.`
      );
      await logAdminAction(interaction.client, {
        actorDiscordUserId: interaction.user.id,
        actorLabel: adminLabel,
        targetDiscordUserId: targetUser.id,
        targetLabel: playerDisplay(archived),
        entityType: 'profil',
        entityId: archived.id,
        actionType: 'archiviert',
        details: 'Spieler aus aktiver Auswahl entfernt'
      });

      return interaction.reply({
        content: `Spieler **${playerDisplay(archived)}** wurde archiviert.`,
        flags: MessageFlags.Ephemeral
      });
    }

    if (subcommand === 'admin-wiederherstellen') {
      const restored = restorePlayer(targetPlayer.id);
      const adminLabel = interaction.member?.displayName || interaction.user.username;
      await notifyUser(interaction.client, targetUser.id,
        `✅ Dein Spielerprofil wurde von **${adminLabel}** wieder aktiviert. Du tauchst jetzt wieder in Planung und Auswahl auf.`
      );
      await logAdminAction(interaction.client, {
        actorDiscordUserId: interaction.user.id,
        actorLabel: adminLabel,
        targetDiscordUserId: targetUser.id,
        targetLabel: playerDisplay(restored),
        entityType: 'profil',
        entityId: restored.id,
        actionType: 'wiederhergestellt',
        details: 'Spieler wieder aktiv'
      });

      return interaction.reply({
        content: `Spieler **${playerDisplay(restored)}** wurde wiederhergestellt.`,
        flags: MessageFlags.Ephemeral
      });
    }
  }
};

module.exports = command;
