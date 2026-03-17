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

function isValidIsoDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;

  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));

  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
  );
}

function parseDateInput(value) {
  if (!value) return null;

  const trimmed = value.trim();

  if (isValidIsoDate(trimmed)) {
    return trimmed;
  }

  if (/^\d{2}\.\d{2}\.\d{4}$/.test(trimmed)) {
    const [day, month, year] = trimmed.split('.');
    const iso = `${year}-${month}-${day}`;
    return isValidIsoDate(iso) ? iso : null;
  }

  return null;
}

function todayAsDateString() {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function extractDatePart(dateTime) {
  return dateTime.slice(0, 10);
}

function formatDateDE(dateStr) {
  const [year, month, day] = dateStr.split('-');
  return `${day}.${month}.${year}`;
}

function formatVacationRange(startAt, endAt) {
  const startDate = extractDatePart(startAt);
  const endDate = extractDatePart(endAt);

  if (startDate === endDate) {
    return formatDateDE(startDate);
  }

  return `${formatDateDE(startDate)} → ${formatDateDE(endDate)}`;
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName('urlaub')
    .setDescription('Verwalte deine Urlaubszeiten.')
    .addSubcommand(sub =>
      sub
        .setName('hinzufuegen')
        .setDescription('Trägt einen Urlaub ein.')
        .addStringOption(option =>
          option
            .setName('startdatum')
            .setDescription('Optional: TT.MM.JJJJ oder YYYY-MM-DD. Standard: heute')
            .setRequired(false)
        )
        .addStringOption(option =>
          option
            .setName('enddatum')
            .setDescription('Optional: TT.MM.JJJJ oder YYYY-MM-DD. Standard: Startdatum')
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
        .setDescription('Zeigt deine eingetragenen Urlaube an.')
    )
    .addSubcommand(sub =>
      sub
        .setName('bearbeiten')
        .setDescription('Bearbeitet einen bestehenden Urlaub anhand der ID.')
        .addIntegerOption(option =>
          option
            .setName('id')
            .setDescription('Die ID aus /urlaub anzeigen')
            .setRequired(true)
        )
        .addStringOption(option =>
          option
            .setName('startdatum')
            .setDescription('Optional: Neues Startdatum, TT.MM.JJJJ oder YYYY-MM-DD')
            .setRequired(false)
        )
        .addStringOption(option =>
          option
            .setName('enddatum')
            .setDescription('Optional: Neues Enddatum, TT.MM.JJJJ oder YYYY-MM-DD')
            .setRequired(false)
        )
        .addStringOption(option =>
          option
            .setName('grund')
            .setDescription('Optional: Neuer Grund')
            .setRequired(false)
        )
    )
    .addSubcommand(sub =>
      sub
        .setName('loeschen')
        .setDescription('Löscht einen Urlaub anhand der ID.')
        .addIntegerOption(option =>
          option
            .setName('id')
            .setDescription('Die ID aus /urlaub anzeigen')
            .setRequired(true)
        )
    ),

  async execute(interaction) {
    const subcommand = interaction.options.getSubcommand();
    const player = ensurePlayer(interaction.user);

    if (subcommand === 'hinzufuegen') {
      const startdatumInput = interaction.options.getString('startdatum')?.trim() ?? null;
      const enddatumInput = interaction.options.getString('enddatum')?.trim() ?? null;
      const grund = interaction.options.getString('grund')?.trim() ?? null;

      const parsedStartDate = parseDateInput(startdatumInput);
      const parsedEndDate = parseDateInput(enddatumInput);

      if (startdatumInput && !parsedStartDate) {
        return interaction.reply({
          content: 'Startdatum ungültig. Nutze TT.MM.JJJJ oder YYYY-MM-DD, z. B. 11.04.2026.',
          ephemeral: true
        });
      }

      if (enddatumInput && !parsedEndDate) {
        return interaction.reply({
          content: 'Enddatum ungültig. Nutze TT.MM.JJJJ oder YYYY-MM-DD, z. B. 11.04.2026.',
          ephemeral: true
        });
      }

      const startdatum = parsedStartDate ?? todayAsDateString();
      const enddatum = parsedEndDate ?? startdatum;

      const startAt = `${startdatum} 00:00`;
      const endAt = `${enddatum} 23:59`;

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
        'vacation',
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
          `Urlaub gespeichert.\n` +
          `ID: **${result.lastInsertRowid}**\n` +
          `Zeitraum: **${formatVacationRange(startAt, endAt)}**\n` +
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
          AND entry_type = 'vacation'
          AND end_at >= ?
        ORDER BY start_at ASC
        LIMIT 20
      `).all(player.id, `${today} 00:00`);

      if (rows.length === 0) {
        return interaction.reply({
          content: 'Du hast aktuell keine kommenden Urlaube eingetragen.',
          ephemeral: true
        });
      }

      const lines = rows.map(row =>
        `**#${row.id}** • ${formatVacationRange(row.start_at, row.end_at)} • Grund: ${row.reason ?? '-'}`
      );

      return interaction.reply({
        content: `**Deine kommenden Urlaube**\n${lines.join('\n')}`,
        ephemeral: true
      });
    }

    if (subcommand === 'bearbeiten') {
      const id = interaction.options.getInteger('id', true);
      const startdatumInput = interaction.options.getString('startdatum')?.trim() ?? null;
      const enddatumInput = interaction.options.getString('enddatum')?.trim() ?? null;
      const grund = interaction.options.getString('grund')?.trim() ?? null;

      const existing = db.prepare(`
        SELECT id, start_at, end_at
        FROM availability_entries
        WHERE id = ?
          AND player_id = ?
          AND entry_type = 'vacation'
      `).get(id, player.id);

      if (!existing) {
        return interaction.reply({
          content: 'Ich habe keinen eigenen Urlaub mit dieser ID gefunden.',
          ephemeral: true
        });
      }

      const parsedStartDate = parseDateInput(startdatumInput);
      const parsedEndDate = parseDateInput(enddatumInput);

      if (startdatumInput && !parsedStartDate) {
        return interaction.reply({
          content: 'Startdatum ungültig. Nutze TT.MM.JJJJ oder YYYY-MM-DD, z. B. 11.04.2026.',
          ephemeral: true
        });
      }

      if (enddatumInput && !parsedEndDate) {
        return interaction.reply({
          content: 'Enddatum ungültig. Nutze TT.MM.JJJJ oder YYYY-MM-DD, z. B. 11.04.2026.',
          ephemeral: true
        });
      }

      const startdatum = parsedStartDate ?? extractDatePart(existing.start_at);
      const enddatum = parsedEndDate ?? extractDatePart(existing.end_at);

      const startAt = `${startdatum} 00:00`;
      const endAt = `${enddatum} 23:59`;

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
          AND entry_type = 'vacation'
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
          `Urlaub **#${id}** wurde aktualisiert.\n` +
          `Zeitraum: **${formatVacationRange(startAt, endAt)}**\n` +
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
          AND entry_type = 'vacation'
      `).get(id, player.id);

      if (!existing) {
        return interaction.reply({
          content: 'Ich habe keinen eigenen Urlaub mit dieser ID gefunden.',
          ephemeral: true
        });
      }

      db.prepare(`
        DELETE FROM availability_entries
        WHERE id = ?
          AND player_id = ?
          AND entry_type = 'vacation'
      `).run(id, player.id);

      return interaction.reply({
        content: `Urlaub **#${id}** wurde gelöscht.`,
        ephemeral: true
      });
    }
  }
};