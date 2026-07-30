const { SlashCommandBuilder, MessageFlags, EmbedBuilder } = require('discord.js');
const db = require('../db/database');
const { requireAdmin } = require('../utils/permissions');
const { logAdminAction, notifyUser } = require('../utils/adminTools');
const { getTeamById, listTeams } = require('../services/teamService');
const { refreshPlayerReferences } = require('./spieltermin');
const {
  ROSTER_STATUS_CHOICES,
  POSITION_CHOICES,
  normalizeRosterStatus,
  normalizePosition,
  rosterStatusLabel
} = require('../utils/rosterUtils');
const {
  upsertPlayer,
  getPlayerByDiscordUserId,
  getPlayerById,
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

const PLAYER_LIST_PAGE_SIZE = 10;

function teamChoices() {
  return listTeams({ activeOnly: false })
    .slice(0, 25)
    .map(team => ({
      name: `${team.name}${team.is_default ? ' (Standard)' : ''}`,
      value: String(team.id)
    }));
}

function formatPlayerListEntry(player) {
  const riotId = player.riot_game_name && player.riot_tag
    ? `${player.riot_game_name}#${player.riot_tag}`
    : '-';
  const positions = [player.primary_position, player.secondary_position]
    .filter(Boolean)
    .join(' / ') || '-';

  return [
    `Discord: <@${player.discord_user_id}> · \`${player.discord_user_id}\``,
    `Team: **${player.team_name || 'Nicht zugewiesen'}**`,
    `Roster: **${rosterStatusLabel(player.roster_status)}** · Positionen: **${positions}**`,
    `Riot-ID: **${riotId}** · Region: **${(player.riot_region || 'euw').toUpperCase()}**`,
    `Datenbankstatus: **${player.is_archived ? 'Archiviert' : 'Aktiv'}**`
  ].join('\n');
}

function buildPlayerListEmbed(interaction) {
  const teamValue = interaction.options.getString('team');
  const statusValue = interaction.options.getString('status');
  const archiveValue = interaction.options.getString('archiviert') || 'alle';
  const requestedPage = interaction.options.getInteger('seite') || 1;

  const conditions = [];
  const params = [];

  if (teamValue) {
    conditions.push('p.team_id = ?');
    params.push(Number(teamValue));
  }

  if (statusValue) {
    conditions.push(`COALESCE(p.roster_status, 'sub') = ?`);
    params.push(statusValue);
  }

  if (archiveValue === 'aktiv') {
    conditions.push('p.is_archived = 0');
  } else if (archiveValue === 'archiviert') {
    conditions.push('p.is_archived = 1');
  }

  const whereSql = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  const total = Number(db.prepare(`
    SELECT COUNT(*) AS count
    FROM players p
    ${whereSql}
  `).get(...params).count);

  const totalPages = Math.max(1, Math.ceil(total / PLAYER_LIST_PAGE_SIZE));
  const page = Math.min(Math.max(1, requestedPage), totalPages);
  const offset = (page - 1) * PLAYER_LIST_PAGE_SIZE;

  const players = db.prepare(`
    SELECT p.*, t.name AS team_name
    FROM players p
    LEFT JOIN teams t ON t.id = p.team_id
    ${whereSql}
    ORDER BY
      p.is_archived ASC,
      COALESCE(t.is_default, 0) DESC,
      COALESCE(t.name, 'ZZZ') COLLATE NOCASE ASC,
      CASE COALESCE(p.roster_status, 'sub')
        WHEN 'main' THEN 0
        WHEN 'sub' THEN 1
        WHEN 'coach' THEN 2
        WHEN 'admin' THEN 3
        WHEN 'inactive' THEN 4
        ELSE 9
      END ASC,
      COALESCE(NULLIF(p.alias, ''), NULLIF(p.global_name, ''), p.username) COLLATE NOCASE ASC,
      p.id ASC
    LIMIT ? OFFSET ?
  `).all(...params, PLAYER_LIST_PAGE_SIZE, offset);

  const selectedTeam = teamValue ? getTeamById(Number(teamValue)) : null;
  const filterParts = [
    `Team: **${selectedTeam?.name || 'Alle'}**`,
    `Roster-Status: **${statusValue ? rosterStatusLabel(statusValue) : 'Alle'}**`,
    `Datenbankstatus: **${
      archiveValue === 'aktiv'
        ? 'Nur aktive'
        : archiveValue === 'archiviert'
          ? 'Nur archivierte'
          : 'Alle'
    }**`
  ];

  const embed = new EmbedBuilder()
    .setTitle(`Spielerdatenbank · Seite ${page}/${totalPages}`)
    .setDescription(
      `Gefundene Spieler: **${total}**\n${filterParts.join(' · ')}\n\n` +
      `Die Nummer vor dem Namen ist die feste Datenbank-ID.`
    )
    .setFooter({
      text: totalPages > 1
        ? `Weitere Seite: /profil admin-liste seite:${page < totalPages ? page + 1 : 1}`
        : 'Details per Datenbank-ID: /profil admin-anzeigen-id'
    })
    .setTimestamp();

  if (!players.length) {
    embed.addFields({
      name: 'Keine Treffer',
      value: 'Für die gewählten Filter wurden keine Spieler gefunden.'
    });
  } else {
    for (const player of players) {
      const name = `#${player.id} • ${playerDisplay(player)}`.slice(0, 256);
      embed.addFields({
        name,
        value: formatPlayerListEntry(player).slice(0, 1024),
        inline: false
      });
    }
  }

  return { embed, page, totalPages, total };
}

function formatProfile(player, heading = 'Dein Profil') {
  const team = player.team_id ? getTeamById(player.team_id) : null;
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
    `Team: **${team?.name ?? 'Nicht zugewiesen'}**\n` +
    `Status: **${rosterStatusLabel(player.roster_status)}**\n` +
    `Hauptposition: **${player.primary_position ?? '-'}**\n` +
    `Nebenposition: **${player.secondary_position ?? '-'}**\n` +
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
    .addSubcommand(sub => {
      sub
        .setName('admin-liste')
        .setDescription('Listet alle Spielerprofile aus der Datenbank auf.')
        .addStringOption(option => {
          option
            .setName('team')
            .setDescription('Optional nach Team filtern')
            .setRequired(false);
          for (const choice of teamChoices()) option.addChoices(choice);
          return option;
        })
        .addStringOption(option => {
          option
            .setName('status')
            .setDescription('Optional nach Roster-Status filtern')
            .setRequired(false);
          for (const choice of ROSTER_STATUS_CHOICES) option.addChoices(choice);
          return option;
        })
        .addStringOption(option =>
          option
            .setName('archiviert')
            .setDescription('Aktive und/oder archivierte Profile anzeigen')
            .setRequired(false)
            .addChoices(
              { name: 'Alle', value: 'alle' },
              { name: 'Nur aktive', value: 'aktiv' },
              { name: 'Nur archivierte', value: 'archiviert' }
            )
        )
        .addIntegerOption(option =>
          option
            .setName('seite')
            .setDescription('Seitennummer, falls mehr als zehn Spieler vorhanden sind')
            .setMinValue(1)
            .setRequired(false)
        );
      return sub;
    })
    .addSubcommand(sub =>
      sub
        .setName('admin-anzeigen-id')
        .setDescription('Zeigt ein Spielerprofil anhand seiner Datenbank-ID an.')
        .addIntegerOption(option =>
          option.setName('id').setDescription('Spieler-ID aus /profil admin-liste').setMinValue(1).setRequired(true)
        )
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
        })
        .addStringOption(option => {
          option
            .setName('status')
            .setDescription('Roster-Status des Spielers')
            .setRequired(false);
          for (const choice of ROSTER_STATUS_CHOICES) option.addChoices(choice);
          return option;
        })
        .addStringOption(option => {
          option
            .setName('hauptposition')
            .setDescription('Hauptposition des Spielers')
            .setRequired(false);
          for (const choice of POSITION_CHOICES) option.addChoices(choice);
          return option;
        })
        .addStringOption(option => {
          option
            .setName('nebenposition')
            .setDescription('Nebenposition des Spielers, optional')
            .setRequired(false);
          option.addChoices({ name: 'Keine', value: '-' });
          for (const choice of POSITION_CHOICES) option.addChoices(choice);
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

      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      const player = upsertPlayer(user, { alias });
      const syncSummary = await refreshPlayerReferences(interaction.client, player.id);

      return interaction.editReply({
        content:
          `Alias gespeichert.\n` +
          `Discord: **${player.username}**\n` +
          `Alias: **${player.alias}**\n` +
          `Betroffene Termine synchronisiert: **${syncSummary.affectedEvents}**`
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

      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      const player = upsertPlayer(user, {
        riot_game_name: riotGameName,
        riot_tag: riotTag,
        riot_region: riotRegion
      });
      const syncSummary = await refreshPlayerReferences(interaction.client, player.id);

      return interaction.editReply({
        content:
          `Riot-Daten gespeichert.\n` +
          `Riot-ID: **${player.riot_game_name}#${player.riot_tag}**\n` +
          `Region: **${(player.riot_region ?? 'euw').toUpperCase()}**\n` +
          `Betroffene Termine synchronisiert: **${syncSummary.affectedEvents}**`
      });
    }

    if (subcommand === 'anzeigen') {
      const player = upsertPlayer(user);
      return interaction.reply({ content: formatProfile(player), flags: MessageFlags.Ephemeral });
    }

    if (!(await requireAdmin(interaction))) return;

    if (subcommand === 'admin-liste') {
      const { embed } = buildPlayerListEmbed(interaction);
      return interaction.reply({
        embeds: [embed],
        allowedMentions: { parse: [] },
        flags: MessageFlags.Ephemeral
      });
    }

    if (subcommand === 'admin-anzeigen-id') {
      const playerId = interaction.options.getInteger('id', true);
      const player = getPlayerById(playerId);

      if (!player) {
        return interaction.reply({
          content: `Spieler #${playerId} wurde in der Datenbank nicht gefunden.`,
          flags: MessageFlags.Ephemeral
        });
      }

      return interaction.reply({
        content: formatProfile(player, `Datenbankprofil #${player.id} von ${playerDisplay(player)}`),
        allowedMentions: { parse: [] },
        flags: MessageFlags.Ephemeral
      });
    }

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
      const rosterStatusInput = interaction.options.getString('status');
      const rosterStatus = rosterStatusInput ? normalizeRosterStatus(rosterStatusInput) : undefined;
      const primaryPositionInput = interaction.options.getString('hauptposition');
      const primaryPosition = primaryPositionInput ? normalizePosition(primaryPositionInput) : undefined;
      const secondaryPositionInput = interaction.options.getString('nebenposition');
      const secondaryPosition = secondaryPositionInput
        ? (secondaryPositionInput === '-' ? '__CLEAR__' : normalizePosition(secondaryPositionInput))
        : undefined;

      await interaction.deferReply({ flags: MessageFlags.Ephemeral });

      const now = new Date().toISOString();
      db.prepare(`
        UPDATE players
        SET alias = CASE WHEN ? = '__CLEAR__' THEN NULL ELSE COALESCE(?, alias) END,
            riot_game_name = CASE WHEN ? = '__CLEAR__' THEN NULL ELSE COALESCE(?, riot_game_name) END,
            riot_tag = CASE WHEN ? = '__CLEAR__' THEN NULL ELSE COALESCE(?, riot_tag) END,
            riot_region = COALESCE(?, riot_region, 'euw'),
            roster_status = COALESCE(?, roster_status, 'sub'),
            primary_position = COALESCE(?, primary_position),
            secondary_position = CASE WHEN ? = '__CLEAR__' THEN NULL ELSE COALESCE(?, secondary_position) END,
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
        rosterStatus ?? null,
        primaryPosition ?? null,
        secondaryPosition ?? null,
        secondaryPosition ?? null,
        now,
        targetPlayer.id
      );

      const updated = getPlayerByDiscordUserId(targetUser.id);
      const adminLabel = interaction.member?.displayName || interaction.user.username;
      const targetLabel = playerDisplay(updated);
      const syncSummary = await refreshPlayerReferences(interaction.client, updated.id);

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
        details: 'Alias/Riot/Roster-Daten angepasst'
      });

      return interaction.editReply({
        content:
          `Profil aktualisiert.\n` +
          `${formatProfile(updated, `Profil von ${targetLabel}`)}\n` +
          `Betroffene Termine synchronisiert: **${syncSummary.affectedEvents}**`
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
