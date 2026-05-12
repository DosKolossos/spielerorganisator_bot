const { SlashCommandBuilder, MessageFlags } = require('discord.js');
const db = require('../db/database');
const { requireAdmin } = require('../utils/permissions');
const { POSITION_CHOICES, normalizePosition, opggRegion } = require('../utils/rosterUtils');

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

function standinDisplay(row) {
  return row.display_name || `${row.riot_game_name}#${row.riot_tag}`;
}

function formatStandin(row) {
  const activeLabel = row.is_active ? 'Aktiv' : 'Archiviert';
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
        .setDescription('Zeigt alle aktiven Standins an.')
    )
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
        ORDER BY is_active DESC, COALESCE(preferred_position, 'ZZZ') ASC, display_name COLLATE NOCASE ASC
      `).all();

      if (!rows.length) {
        return interaction.reply({ content: 'Es sind noch keine Standins hinterlegt.', flags: MessageFlags.Ephemeral });
      }

      const lines = rows.map(formatStandin);
      return interaction.reply({ content: lines.join('\n\n'), flags: MessageFlags.Ephemeral });
    }

    if (subcommand === 'archive' || subcommand === 'restore') {
      const id = interaction.options.getInteger('id', true);
      const standin = getStandinById(id);
      if (!standin) {
        return interaction.reply({ content: `Standin #${id} wurde nicht gefunden.`, flags: MessageFlags.Ephemeral });
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
