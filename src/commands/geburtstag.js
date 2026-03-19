const { SlashCommandBuilder, MessageFlags } = require('discord.js');
const db = require('../db/database');
const { requireAdmin } = require('../utils/permissions');

function parseBirthdayInput(value) {
  const trimmed = String(value || '').trim();

  if (/^\d{2}\.\d{2}$/.test(trimmed)) {
    const [day, month] = trimmed.split('.').map(Number);
    if (month >= 1 && month <= 12 && day >= 1 && day <= 31) {
      return { day, month };
    }
  }

  if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
    const [, monthStr, dayStr] = trimmed.split('-');
    const month = Number(monthStr);
    const day = Number(dayStr);
    if (month >= 1 && month <= 12 && day >= 1 && day <= 31) {
      return { day, month };
    }
  }

  return null;
}

function formatBirthday(row) {
  const day = String(row.birthday_day).padStart(2, '0');
  const month = String(row.birthday_month).padStart(2, '0');

  return (
    `**#${row.id}** • **${row.name}**\n` +
    `Geburtstag: **${day}.${month}.**\n` +
    `Hinweis: **${row.note ?? '-'}**`
  );
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName('geburtstag')
    .setDescription('Verwalte Geburtstage.')

    .addSubcommand(sub =>
      sub
        .setName('eintragen')
        .setDescription('Trägt einen Geburtstag ein.')
        .addStringOption(option =>
          option
            .setName('name')
            .setDescription('Name der Person')
            .setRequired(true)
        )
        .addStringOption(option =>
          option
            .setName('datum')
            .setDescription('Geburtstag als TT.MM oder YYYY-MM-DD')
            .setRequired(true)
        )
        .addStringOption(option =>
          option
            .setName('hinweis')
            .setDescription('Optionaler Hinweis')
            .setRequired(false)
        )
    )

    .addSubcommand(sub =>
      sub
        .setName('anzeigen')
        .setDescription('Zeigt alle gespeicherten Geburtstage an.')
    )

    .addSubcommand(sub =>
      sub
        .setName('loeschen')
        .setDescription('Löscht einen Geburtstag anhand der ID.')
        .addIntegerOption(option =>
          option
            .setName('id')
            .setDescription('Geburtstags-ID')
            .setRequired(true)
        )
    ),

  async execute(interaction) {
    if (!(await requireAdmin(interaction))) return;

    const subcommand = interaction.options.getSubcommand();

    if (subcommand === 'eintragen') {
      const name = interaction.options.getString('name', true).trim();
      const datumInput = interaction.options.getString('datum', true);
      const hinweis = interaction.options.getString('hinweis')?.trim() || null;

      const parsed = parseBirthdayInput(datumInput);
      if (!parsed) {
        return interaction.reply({
          content: 'Datum ungültig. Nutze **TT.MM** oder **YYYY-MM-DD**.',
          flags: MessageFlags.Ephemeral
        });
      }

      const now = new Date().toISOString();

      const result = db.prepare(`
        INSERT INTO birthdays (
          name,
          birthday_month,
          birthday_day,
          note,
          created_by_discord_user_id,
          updated_by_discord_user_id,
          created_at,
          updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        name,
        parsed.month,
        parsed.day,
        hinweis,
        interaction.user.id,
        interaction.user.id,
        now,
        now
      );

      return interaction.reply({
        content:
          `Geburtstag **#${Number(result.lastInsertRowid)}** wurde gespeichert.\n` +
          `Name: **${name}**\n` +
          `Datum: **${String(parsed.day).padStart(2, '0')}.${String(parsed.month).padStart(2, '0')}.**\n` +
          `Hinweis: **${hinweis ?? '-'}**`,
        flags: MessageFlags.Ephemeral
      });
    }

    if (subcommand === 'anzeigen') {
      const rows = db.prepare(`
        SELECT *
        FROM birthdays
        ORDER BY birthday_month ASC, birthday_day ASC, lower(name) ASC
      `).all();

      if (rows.length === 0) {
        return interaction.reply({
          content: 'Es sind noch keine Geburtstage gespeichert.',
          flags: MessageFlags.Ephemeral
        });
      }

      return interaction.reply({
        content: rows.map(formatBirthday).join('\n\n'),
        flags: MessageFlags.Ephemeral
      });
    }

    if (subcommand === 'loeschen') {
      const id = interaction.options.getInteger('id', true);

      const existing = db.prepare(`
        SELECT *
        FROM birthdays
        WHERE id = ?
      `).get(id);

      if (!existing) {
        return interaction.reply({
          content: 'Ich habe keinen Geburtstag mit dieser ID gefunden.',
          flags: MessageFlags.Ephemeral
        });
      }

      db.prepare(`
        DELETE FROM birthdays
        WHERE id = ?
      `).run(id);

      return interaction.reply({
        content: `Geburtstag **#${id}** von **${existing.name}** wurde gelöscht.`,
        flags: MessageFlags.Ephemeral
      });
    }
  }
};