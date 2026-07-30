const { SlashCommandBuilder, MessageFlags } = require('discord.js');
const db = require('../db/database');
const { requireAdmin } = require('../utils/permissions');
const { logAdminAction, notifyUser } = require('../utils/adminTools');
const {
  listTeams,
  getTeamById,
  resolveTeamForInteraction
} = require('../services/teamService');
const { playerDisplay, getPlayerByDiscordUserId } = require('../utils/playerUtils');
const { refreshPlayerReferences } = require('./spieltermin');
const {
  POSITION_CHOICES,
  normalizePosition,
  rosterStatusLabel,
  opggRegion
} = require('../utils/rosterUtils');

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

const PROMOTION_STATUS_CHOICES = [
  { name: 'Main-Line-up', value: 'main' },
  { name: 'Sub', value: 'sub' }
];

function teamChoices() {
  return listTeams({ activeOnly: true })
    .slice(0, 25)
    .map(team => ({
      name: `${team.name}${team.is_default ? ' (Standard)' : ''}`,
      value: String(team.id)
    }));
}

function standinDisplay(row) {
  return row.display_name || `${row.riot_game_name}#${row.riot_tag}`;
}

function formatStandin(row) {
  const promoted = Number(row.promoted_to_player_id) > 0;
  const activeLabel = promoted
    ? `Befördert zu Spieler #${row.promoted_to_player_id}`
    : row.is_active
      ? 'Aktiv'
      : 'Archiviert';
  const opgg = `https://op.gg/lol/summoners/${opggRegion(row.riot_region)}/${encodeURIComponent(`${row.riot_game_name}-${row.riot_tag}`)}`;

  return (
    `**#${row.id} • ${standinDisplay(row)}**\n` +
    `Riot-ID: **${row.riot_game_name}#${row.riot_tag}**\n` +
    `Region: **${opggRegion(row.riot_region).toUpperCase()}**\n` +
    `Position: **${row.preferred_position || '-'}**\n` +
    `Status: **${activeLabel}**\n` +
    `OP.GG: ${opgg}\n` +
    `Notiz: ${row.note || '-'}`
  );
}

function getStandinById(id) {
  return db.prepare(`SELECT * FROM standins WHERE id = ?`).get(id);
}

function promoteStandin({
  standin,
  targetUser,
  rosterStatus,
  teamId,
  primaryPosition,
  secondaryPosition,
  actorDiscordUserId
}) {
  const now = new Date().toISOString();

  const transaction = db.transaction(() => {
    let player = getPlayerByDiscordUserId(targetUser.id);

    if (!player) {
      const result = db.prepare(`
        INSERT INTO players (
          discord_user_id,
          username,
          global_name,
          alias,
          riot_game_name,
          riot_tag,
          riot_region,
          roster_status,
          primary_position,
          secondary_position,
          team_id,
          is_archived,
          archived_at,
          archived_by_discord_user_id,
          created_at,
          updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, NULL, NULL, ?, ?)
      `).run(
        targetUser.id,
        targetUser.username,
        targetUser.globalName ?? null,
        standin.display_name || null,
        standin.riot_game_name,
        standin.riot_tag,
        opggRegion(standin.riot_region),
        rosterStatus,
        primaryPosition,
        secondaryPosition,
        teamId,
        now,
        now
      );

      player = db.prepare(`SELECT * FROM players WHERE id = ?`).get(result.lastInsertRowid);
    } else {
      db.prepare(`
        UPDATE players
        SET username = ?,
            global_name = ?,
            alias = COALESCE(NULLIF(trim(alias), ''), ?),
            riot_game_name = ?,
            riot_tag = ?,
            riot_region = ?,
            roster_status = ?,
            primary_position = COALESCE(?, primary_position),
            secondary_position = CASE
              WHEN ? = '__CLEAR__' THEN NULL
              ELSE COALESCE(?, secondary_position)
            END,
            team_id = ?,
            is_archived = 0,
            archived_at = NULL,
            archived_by_discord_user_id = NULL,
            updated_at = ?
        WHERE id = ?
      `).run(
        targetUser.username,
        targetUser.globalName ?? null,
        standin.display_name || null,
        standin.riot_game_name,
        standin.riot_tag,
        opggRegion(standin.riot_region),
        rosterStatus,
        primaryPosition,
        secondaryPosition,
        secondaryPosition,
        teamId,
        now,
        player.id
      );

      player = db.prepare(`SELECT * FROM players WHERE id = ?`).get(player.id);
    }

    const assignmentResult = db.prepare(`
      UPDATE team_calendar_assignments
      SET assignee_type = 'player',
          player_id = ?,
          standin_id = NULL,
          player_label = ?,
          updated_at = ?
      WHERE standin_id = ?
    `).run(player.id, playerDisplay(player), now, standin.id);

    db.prepare(`
      UPDATE standins
      SET is_active = 0,
          promoted_to_player_id = ?,
          promoted_at = ?,
          promoted_by_discord_user_id = ?,
          updated_by_discord_user_id = ?,
          updated_at = ?
      WHERE id = ?
    `).run(
      player.id,
      now,
      actorDiscordUserId,
      actorDiscordUserId,
      now,
      standin.id
    );

    return {
      player,
      migratedAssignments: assignmentResult.changes
    };
  });

  return transaction();
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName('standin')
    .setDescription('Verwaltet Standins inklusive Riot-Profil für Team-OP.GG.')
    .addSubcommand(sub => {
      sub
        .setName('add')
        .setDescription('Legt einen Standin an oder aktualisiert ihn anhand der Riot-ID.')
        .addStringOption(option =>
          option.setName('name').setDescription('Anzeigename des Standins').setRequired(true)
        )
        .addStringOption(option =>
          option.setName('game_name').setDescription('Riot Game Name').setRequired(true)
        )
        .addStringOption(option =>
          option.setName('tag').setDescription('Riot Tag, z. B. EUW').setRequired(true)
        )
        .addStringOption(option => {
          option.setName('region').setDescription('OP.GG-Region').setRequired(false);
          for (const choice of REGION_CHOICES) option.addChoices(choice);
          return option;
        })
        .addStringOption(option => {
          option.setName('position').setDescription('Bevorzugte Position').setRequired(false);
          for (const choice of POSITION_CHOICES) option.addChoices(choice);
          return option;
        })
        .addStringOption(option =>
          option.setName('notiz').setDescription('Optionale Notiz').setRequired(false)
        );
      return sub;
    })
    .addSubcommand(sub =>
      sub
        .setName('list')
        .setDescription('Zeigt alle aktiven, archivierten und beförderten Standins an.')
    )
    .addSubcommand(sub => {
      sub
        .setName('befoerdern')
        .setDescription('Befördert einen Standin zu einem regulären Roster-Mitglied.')
        .addIntegerOption(option =>
          option.setName('id').setDescription('Standin-ID aus /standin list').setRequired(true)
        )
        .addUserOption(option =>
          option
            .setName('spieler')
            .setDescription('Discord-Nutzer, mit dem das Roster-Profil verknüpft wird')
            .setRequired(true)
        )
        .addStringOption(option => {
          option
            .setName('status')
            .setDescription('Roster-Status nach der Beförderung (Standard: Sub)')
            .setRequired(false);
          for (const choice of PROMOTION_STATUS_CHOICES) option.addChoices(choice);
          return option;
        })
        .addStringOption(option => {
          option
            .setName('team')
            .setDescription('Zielteam; standardmäßig das Team des Standins bzw. dieses Kanals')
            .setRequired(false);
          for (const choice of teamChoices()) option.addChoices(choice);
          return option;
        })
        .addStringOption(option => {
          option
            .setName('hauptposition')
            .setDescription('Hauptposition; standardmäßig die Standin-Position')
            .setRequired(false);
          for (const choice of POSITION_CHOICES) option.addChoices(choice);
          return option;
        })
        .addStringOption(option => {
          option
            .setName('nebenposition')
            .setDescription('Optionale Nebenposition')
            .setRequired(false)
            .addChoices({ name: 'Keine', value: '-' });
          for (const choice of POSITION_CHOICES) option.addChoices(choice);
          return option;
        });
      return sub;
    })
    .addSubcommand(sub =>
      sub
        .setName('archive')
        .setDescription('Archiviert einen Standin, damit er nicht mehr in der Aufstellungsauswahl auftaucht.')
        .addIntegerOption(option =>
          option.setName('id').setDescription('Standin-ID aus /standin list').setRequired(true)
        )
    )
    .addSubcommand(sub =>
      sub
        .setName('restore')
        .setDescription('Aktiviert einen archivierten Standin wieder.')
        .addIntegerOption(option =>
          option.setName('id').setDescription('Standin-ID').setRequired(true)
        )
    ),

  async execute(interaction) {
    if (!(await requireAdmin(interaction))) return;

    const subcommand = interaction.options.getSubcommand();
    const now = new Date().toISOString();

    if (subcommand === 'add') {
      const displayName = interaction.options.getString('name', true).trim();
      const riotGameName = interaction.options.getString('game_name', true).trim();
      const riotTag = interaction.options.getString('tag', true).trim().replace(/^#/, '').toUpperCase();
      const riotRegion = opggRegion(interaction.options.getString('region'));
      const preferredPosition = normalizePosition(interaction.options.getString('position'));
      const noteInput = interaction.options.getString('notiz');
      const note = noteInput?.trim() || null;

      if (displayName.length < 2 || displayName.length > 64) {
        return interaction.reply({ content: 'Der Anzeigename muss zwischen 2 und 64 Zeichen lang sein.', flags: MessageFlags.Ephemeral });
      }

      if (riotGameName.length < 2 || riotGameName.length > 32) {
        return interaction.reply({ content: 'Der Riot Game Name muss zwischen 2 und 32 Zeichen lang sein.', flags: MessageFlags.Ephemeral });
      }

      if (riotTag.length < 2 || riotTag.length > 10) {
        return interaction.reply({ content: 'Der Riot-Tag muss zwischen 2 und 10 Zeichen lang sein.', flags: MessageFlags.Ephemeral });
      }

      const existing = db.prepare(`
        SELECT *
        FROM standins
        WHERE lower(riot_game_name) = lower(?)
          AND lower(riot_tag) = lower(?)
          AND lower(riot_region) = lower(?)
        LIMIT 1
      `).get(riotGameName, riotTag, riotRegion);

      let standin;
      if (existing) {
        if (existing.promoted_to_player_id) {
          return interaction.reply({
            content:
              `Dieser Standin wurde bereits zu Spieler **#${existing.promoted_to_player_id}** befördert. ` +
              `Änderungen bitte am Spielerprofil vornehmen.`,
            flags: MessageFlags.Ephemeral
          });
        }

        db.prepare(`
          UPDATE standins
          SET display_name = ?,
              riot_game_name = ?,
              riot_tag = ?,
              riot_region = ?,
              preferred_position = ?,
              note = ?,
              is_active = 1,
              updated_by_discord_user_id = ?,
              updated_at = ?
          WHERE id = ?
        `).run(displayName, riotGameName, riotTag, riotRegion, preferredPosition, note, interaction.user.id, now, existing.id);
        standin = getStandinById(existing.id);
      } else {
        const result = db.prepare(`
          INSERT INTO standins (
            display_name,
            riot_game_name,
            riot_tag,
            riot_region,
            preferred_position,
            note,
            is_active,
            created_by_discord_user_id,
            updated_by_discord_user_id,
            created_at,
            updated_at
          )
          VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?)
        `).run(displayName, riotGameName, riotTag, riotRegion, preferredPosition, note, interaction.user.id, interaction.user.id, now, now);
        standin = getStandinById(result.lastInsertRowid);
      }

      return interaction.reply({
        content: `Standin gespeichert.\n${formatStandin(standin)}`,
        flags: MessageFlags.Ephemeral
      });
    }

    if (subcommand === 'list') {
      const rows = db.prepare(`
        SELECT *
        FROM standins
        ORDER BY
          CASE
            WHEN promoted_to_player_id IS NOT NULL THEN 2
            WHEN is_active = 1 THEN 0
            ELSE 1
          END ASC,
          COALESCE(preferred_position, 'ZZZ') ASC,
          display_name COLLATE NOCASE ASC
      `).all();

      if (!rows.length) {
        return interaction.reply({ content: 'Es sind noch keine Standins hinterlegt.', flags: MessageFlags.Ephemeral });
      }

      const chunks = [];
      let current = '';

      for (const row of rows) {
        const block = formatStandin(row);
        if (current && current.length + block.length + 2 > 1900) {
          chunks.push(current);
          current = block;
        } else {
          current = current ? `${current}\n\n${block}` : block;
        }
      }
      if (current) chunks.push(current);

      await interaction.reply({
        content: chunks[0],
        flags: MessageFlags.Ephemeral
      });

      for (const chunk of chunks.slice(1)) {
        await interaction.followUp({
          content: chunk,
          flags: MessageFlags.Ephemeral
        });
      }
      return;
    }

    if (subcommand === 'befoerdern') {
      const id = interaction.options.getInteger('id', true);
      const targetUser = interaction.options.getUser('spieler', true);
      const standin = getStandinById(id);

      if (!standin) {
        return interaction.reply({
          content: `Standin #${id} wurde nicht gefunden.`,
          flags: MessageFlags.Ephemeral
        });
      }

      if (standin.promoted_to_player_id) {
        return interaction.reply({
          content: `Standin **${standinDisplay(standin)}** wurde bereits zu Spieler **#${standin.promoted_to_player_id}** befördert.`,
          flags: MessageFlags.Ephemeral
        });
      }

      const duplicateRiotPlayer = db.prepare(`
        SELECT *
        FROM players
        WHERE discord_user_id <> ?
          AND lower(COALESCE(riot_game_name, '')) = lower(?)
          AND lower(COALESCE(riot_tag, '')) = lower(?)
          AND lower(COALESCE(riot_region, 'euw')) = lower(?)
        LIMIT 1
      `).get(
        targetUser.id,
        standin.riot_game_name,
        standin.riot_tag,
        opggRegion(standin.riot_region)
      );

      if (duplicateRiotPlayer) {
        return interaction.reply({
          content:
            `Die Riot-ID **${standin.riot_game_name}#${standin.riot_tag}** ist bereits mit ` +
            `Spieler **#${duplicateRiotPlayer.id} (${playerDisplay(duplicateRiotPlayer)})** verknüpft. ` +
            `Die Beförderung wurde nicht durchgeführt, damit kein doppeltes Profil entsteht.`,
          flags: MessageFlags.Ephemeral
        });
      }

      const teamOption = interaction.options.getString('team');
      const interactionTeam = resolveTeamForInteraction(interaction);
      const teamId = teamOption
        ? Number(teamOption)
        : standin.team_id || interactionTeam?.id || null;
      const team = teamId ? getTeamById(teamId) : null;

      if (!team) {
        return interaction.reply({
          content: 'Es konnte kein Zielteam ermittelt werden. Bitte gib beim Befehl ein Team an.',
          flags: MessageFlags.Ephemeral
        });
      }

      const rosterStatus = interaction.options.getString('status') || 'sub';
      const primaryPosition = normalizePosition(
        interaction.options.getString('hauptposition') || standin.preferred_position
      );
      const secondaryInput = interaction.options.getString('nebenposition');
      const secondaryPosition = secondaryInput === '-'
        ? '__CLEAR__'
        : normalizePosition(secondaryInput);

      await interaction.deferReply({ flags: MessageFlags.Ephemeral });

      const result = promoteStandin({
        standin,
        targetUser,
        rosterStatus,
        teamId: team.id,
        primaryPosition,
        secondaryPosition,
        actorDiscordUserId: interaction.user.id
      });

      const syncSummary = await refreshPlayerReferences(interaction.client, result.player.id);
      const adminLabel = interaction.member?.displayName || interaction.user.username;

      await notifyUser(
        interaction.client,
        targetUser.id,
        `🎉 Du wurdest von **${adminLabel}** vom Standin zum Roster-Mitglied von **${team.name}** befördert.\n` +
        `Status: **${rosterStatusLabel(result.player.roster_status)}**\n` +
        `Riot-ID: **${result.player.riot_game_name}#${result.player.riot_tag}**`
      );

      await logAdminAction(interaction.client, {
        actorDiscordUserId: interaction.user.id,
        actorLabel: adminLabel,
        targetDiscordUserId: targetUser.id,
        targetLabel: playerDisplay(result.player),
        entityType: 'standin',
        entityId: standin.id,
        actionType: 'befördert',
        details:
          `Zu Spieler #${result.player.id}, Team ${team.name}, Status ${rosterStatusLabel(result.player.roster_status)}, ` +
          `${result.migratedAssignments} Aufstellungen migriert`
      });

      return interaction.editReply({
        content:
          `🎉 **${standinDisplay(standin)}** wurde erfolgreich zum Roster-Mitglied befördert.\n` +
          `Spielerprofil: **#${result.player.id} • ${playerDisplay(result.player)}**\n` +
          `Discord: ${targetUser}\n` +
          `Team: **${team.name}**\n` +
          `Status: **${rosterStatusLabel(result.player.roster_status)}**\n` +
          `Positionen: **${result.player.primary_position || '-'} / ${result.player.secondary_position || '-'}**\n` +
          `Riot-ID: **${result.player.riot_game_name}#${result.player.riot_tag}**\n` +
          `Übernommene Aufstellungen: **${result.migratedAssignments}**\n` +
          `Synchronisierte Termine: **${syncSummary.affectedEvents}**`
      });
    }

    if (subcommand === 'archive' || subcommand === 'restore') {
      const id = interaction.options.getInteger('id', true);
      const standin = getStandinById(id);
      if (!standin) {
        return interaction.reply({ content: `Standin #${id} wurde nicht gefunden.`, flags: MessageFlags.Ephemeral });
      }

      if (subcommand === 'restore' && standin.promoted_to_player_id) {
        return interaction.reply({
          content:
            `Dieser Standin wurde bereits zu Spieler **#${standin.promoted_to_player_id}** befördert und kann nicht wieder als Standin aktiviert werden. ` +
            `Verwalte stattdessen das zugehörige Spielerprofil.`,
          flags: MessageFlags.Ephemeral
        });
      }

      const isActive = subcommand === 'restore' ? 1 : 0;
      db.prepare(`
        UPDATE standins
        SET is_active = ?,
            updated_by_discord_user_id = ?,
            updated_at = ?
        WHERE id = ?
      `).run(isActive, interaction.user.id, now, id);

      const updated = getStandinById(id);
      return interaction.reply({
        content: `${subcommand === 'restore' ? 'Standin aktiviert.' : 'Standin archiviert.'}\n${formatStandin(updated)}`,
        flags: MessageFlags.Ephemeral
      });
    }
  }
};
