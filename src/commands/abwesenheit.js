const { SlashCommandBuilder } = require('discord.js');
const db = require('../db/database');

function ensurePlayer(user) {
  const now = new Date().toISOString();

  let player = db
    .prepare('SELECT * FROM players WHERE discord_user_id = ?')
    .get(user.id);

  if (!player) {
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
      null,
      now,
      now
    );

    player = db
      .prepare('SELECT * FROM players WHERE discord_user_id = ?')
      .get(user.id);
  } else {
    db.prepare(`
      UPDATE players
      SET username = ?,
          global_name = ?,
          updated_at = ?
      WHERE discord_user_id = ?
    `).run(
      user.username,
      user.globalName ?? null,
      now,
      user.id
    );

    player = db
      .prepare('SELECT * FROM players WHERE discord_user_id = ?')
      .get(user.id);
  }

  return player;
}

function isValidDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;

  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));

  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
  );
}

function isValidTime(value) {
  if (!/^\d{2}:\d{2}$/.test(value)) return false;

  const [hours, minutes] = value.split(':').map(Number);
  return hours >= 0 && hours <= 23 && minutes >= 0 && minutes <= 59;
}

function buildDateTime(dateStr, timeStr, fallbackTime) {
  return `${dateStr} ${timeStr ?? fallbackTime}`;
}

function todayAsDateString() {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName('abwesenheit')
    .setDescription('Verwalte deine Abwesenheiten.')
    .addSubcommand(sub =>
      sub
        .setName('hinzufuegen')
        .setDescription('Trägt eine neue Abwesenheit ein.')
        .addStringOption(option =>
          option
            .setName('startdatum')
            .setDescription('Startdatum im Format YYYY-MM-DD')
            .setRequired(true)
        )
        .addStringOption(option =>
          option
            .setName('enddatum')
            .setDescription('Enddatum im Format YYYY-MM-DD')
            .setRequired(true)
        )
        .addStringOption(option =>
          option
            .setName('startzeit')
            .setDescription('Optional: Startzeit im Format HH:MM')
            .setRequired(false)
        )
        .addStringOption(option =>
          option
            .setName('endzeit')
            .setDescription('Optional: Endzeit im Format HH:MM')
            .setRequired(false)
        )
        .addBooleanOption(option =>
          option
            .setName('ganztag')
            .setDescription('Wenn true, gilt der Eintrag als ganztägig')
            .setRequired(false)
        )
        .addStringOption(option =>
          option
            .setName('grund')
            .setDescription('Optionaler Grund')
            .setRequired(false)
        )
    )
    .addSubcommand(sub =>
      sub
        .setName('anzeigen')
        .setDescription('Zeigt deine eingetragenen Abwesenheiten an.')
    )
    .addSubcommand(sub =>
      sub
        .setName('bearbeiten')
        .setDescription('Bearbeitet eine bestehende Abwesenheit anhand der ID.')
        .addIntegerOption(option =>
          option
            .setName('id')
            .setDescription('Die ID aus /abwesenheit anzeigen')
            .setRequired(true)
        )
        .addStringOption(option =>
          option
            .setName('startdatum')
            .setDescription('Neues Startdatum im Format YYYY-MM-DD')
            .setRequired(true)
        )
        .addStringOption(option =>
          option
            .setName('enddatum')
            .setDescription('Neues Enddatum im Format YYYY-MM-DD')
            .setRequired(true)
        )
        .addStringOption(option =>
          option
            .setName('startzeit')
            .setDescription('Optional: Neue Startzeit im Format HH:MM')
            .setRequired(false)
        )
        .addStringOption(option =>
          option
            .setName('endzeit')
            .setDescription('Optional: Neue Endzeit im Format HH:MM')
            .setRequired(false)
        )
        .addBooleanOption(option =>
          option
            .setName('ganztag')
            .setDescription('Wenn true, gilt der Eintrag als ganztägig')
            .setRequired(false)
        )
        .addStringOption(option =>
          option
            .setName('grund')
            .setDescription('Neuer Grund')
            .setRequired(false)
        )
    )
    .addSubcommand(sub =>
      sub
        .setName('loeschen')
        .setDescription('Löscht eine deiner Abwesenheiten anhand der ID.')
        .addIntegerOption(option =>
          option
            .setName('id')
            .setDescription('Die ID aus /abwesenheit anzeigen')
            .setRequired(true)
        )
    ),

  async execute(interaction) {
    const subcommand = interaction.options.getSubcommand();
    const player = ensurePlayer(interaction.user);

    if (subcommand === 'hinzufuegen') {
      const startdatum = interaction.options.getString('startdatum', true).trim();
      const enddatum = interaction.options.getString('enddatum', true).trim();
      const startzeit = interaction.options.getString('startzeit')?.trim() ?? null;
      const endzeit = interaction.options.getString('endzeit')?.trim() ?? null;
      const grund = interaction.options.getString('grund')?.trim() ?? null;
      const ganztag =
        interaction.options.getBoolean('ganztag') ?? (!startzeit && !endzeit);

      if (!isValidDate(startdatum) || !isValidDate(enddatum)) {
        return interaction.reply({
          content: 'Datum ungültig. Bitte nutze YYYY-MM-DD, z. B. 2026-03-20.',
          ephemeral: true
        });
      }

      if (startzeit && !isValidTime(startzeit)) {
        return interaction.reply({
          content: 'Startzeit ungültig. Bitte nutze HH:MM, z. B. 18:30.',
          ephemeral: true
        });
      }

      if (endzeit && !isValidTime(endzeit)) {
        return interaction.reply({
          content: 'Endzeit ungültig. Bitte nutze HH:MM, z. B. 19:45.',
          ephemeral: true
        });
      }

      const startAt = buildDateTime(startdatum, ganztag ? null : startzeit, '00:00');
      const endAt = buildDateTime(enddatum, ganztag ? null : endzeit, '23:59');

      if (startAt > endAt) {
        return interaction.reply({
          content: 'Der Start darf nicht nach dem Ende liegen.',
          ephemeral: true
        });
      }

      const now = new Date().toISOString();

      const result = db.prepare(`
        INSERT INTO availability_entries (
          player_id,
          entry_type,
          start_at,
          end_at,
          reason,
          created_by_discord_user_id,
          updated_by_discord_user_id,
          created_at,
          updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        player.id,
        'absence',
        startAt,
        endAt,
        grund,
        interaction.user.id,
        interaction.user.id,
        now,
        now
      );

      return interaction.reply({
        content:
          `Abwesenheit gespeichert.\n` +
          `ID: **${result.lastInsertRowid}**\n` +
          `Von: **${startAt}**\n` +
          `Bis: **${endAt}**\n` +
          `Grund: **${grund ?? '-'}**`,
        ephemeral: true
      });
    }

    if (subcommand === 'anzeigen') {
      const today = todayAsDateString();

      const rows = db.prepare(`
        SELECT id, start_at, end_at, reason
        FROM availability_entries
        WHERE player_id = ?
          AND entry_type = 'absence'
          AND end_at >= ?
        ORDER BY start_at ASC
        LIMIT 20
      `).all(player.id, `${today} 00:00`);

      if (rows.length === 0) {
        return interaction.reply({
          content: 'Du hast aktuell keine kommenden Abwesenheiten eingetragen.',
          ephemeral: true
        });
      }

      const lines = rows.map(row =>
        `**#${row.id}** • ${row.start_at} → ${row.end_at} • Grund: ${row.reason ?? '-'}`
      );

      return interaction.reply({
        content: `**Deine kommenden Abwesenheiten**\n${lines.join('\n')}`,
        ephemeral: true
      });
    }

    if (subcommand === 'bearbeiten') {
      const id = interaction.options.getInteger('id', true);
      const startdatum = interaction.options.getString('startdatum', true).trim();
      const enddatum = interaction.options.getString('enddatum', true).trim();
      const startzeit = interaction.options.getString('startzeit')?.trim() ?? null;
      const endzeit = interaction.options.getString('endzeit')?.trim() ?? null;
      const grund = interaction.options.getString('grund')?.trim() ?? null;
      const ganztag =
        interaction.options.getBoolean('ganztag') ?? (!startzeit && !endzeit);

      const existing = db.prepare(`
        SELECT id
        FROM availability_entries
        WHERE id = ?
          AND player_id = ?
          AND entry_type = 'absence'
      `).get(id, player.id);

      if (!existing) {
        return interaction.reply({
          content: 'Ich habe keine eigene Abwesenheit mit dieser ID gefunden.',
          ephemeral: true
        });
      }

      if (!isValidDate(startdatum) || !isValidDate(enddatum)) {
        return interaction.reply({
          content: 'Datum ungültig. Bitte nutze YYYY-MM-DD, z. B. 2026-03-20.',
          ephemeral: true
        });
      }

      if (startzeit && !isValidTime(startzeit)) {
        return interaction.reply({
          content: 'Startzeit ungültig. Bitte nutze HH:MM, z. B. 18:30.',
          ephemeral: true
        });
      }

      if (endzeit && !isValidTime(endzeit)) {
        return interaction.reply({
          content: 'Endzeit ungültig. Bitte nutze HH:MM, z. B. 19:45.',
          ephemeral: true
        });
      }

      const startAt = buildDateTime(startdatum, ganztag ? null : startzeit, '00:00');
      const endAt = buildDateTime(enddatum, ganztag ? null : endzeit, '23:59');

      if (startAt > endAt) {
        return interaction.reply({
          content: 'Der Start darf nicht nach dem Ende liegen.',
          ephemeral: true
        });
      }

      const now = new Date().toISOString();

      db.prepare(`
        UPDATE availability_entries
        SET start_at = ?,
            end_at = ?,
            reason = ?,
            updated_by_discord_user_id = ?,
            updated_at = ?
        WHERE id = ?
          AND player_id = ?
          AND entry_type = 'absence'
      `).run(
        startAt,
        endAt,
        grund,
        interaction.user.id,
        now,
        id,
        player.id
      );

      return interaction.reply({
        content:
          `Abwesenheit **#${id}** wurde aktualisiert.\n` +
          `Von: **${startAt}**\n` +
          `Bis: **${endAt}**\n` +
          `Grund: **${grund ?? '-'}**`,
        ephemeral: true
      });
    }

    if (subcommand === 'loeschen') {
      const id = interaction.options.getInteger('id', true);

      const existing = db.prepare(`
        SELECT id
        FROM availability_entries
        WHERE id = ?
          AND player_id = ?
          AND entry_type = 'absence'
      `).get(id, player.id);

      if (!existing) {
        return interaction.reply({
          content: 'Ich habe keine eigene Abwesenheit mit dieser ID gefunden.',
          ephemeral: true
        });
      }

      db.prepare(`
        DELETE FROM availability_entries
        WHERE id = ?
          AND player_id = ?
          AND entry_type = 'absence'
      `).run(id, player.id);

      return interaction.reply({
        content: `Abwesenheit **#${id}** wurde gelöscht.`,
        ephemeral: true
      });
    }
  }
};