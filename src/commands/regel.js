const { SlashCommandBuilder } = require('discord.js');
const db = require('../db/database');

const DAY_BITS = {
  sonntag: 1,
  montag: 2,
  dienstag: 4,
  mittwoch: 8,
  donnerstag: 16,
  freitag: 32,
  samstag: 64,
  so: 1,
  mo: 2,
  di: 4,
  mi: 8,
  do: 16,
  fr: 32,
  sa: 64
};

const ruleLabelMap = {
  nicht_verfuegbar: 'nicht verfügbar',
  erst_ab: 'erst ab',
  bis: 'verfügbar bis'
};

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

function isValidTime(value) {
  if (!/^\d{2}:\d{2}$/.test(value)) return false;

  const [hours, minutes] = value.split(':').map(Number);
  return hours >= 0 && hours <= 23 && minutes >= 0 && minutes <= 59;
}

function parseWeekdayMask(input) {
  const normalized = input.toLowerCase().replace(/\s+/g, '');

  if (normalized === 'werktage') return 2 | 4 | 8 | 16 | 32;
  if (normalized === 'wochenende') return 1 | 64;
  if (normalized === 'alle') return 1 | 2 | 4 | 8 | 16 | 32 | 64;

  const parts = normalized.split(',').filter(Boolean);
  if (!parts.length) return null;

  let mask = 0;

  for (const part of parts) {
    if (!DAY_BITS[part]) return null;
    mask |= DAY_BITS[part];
  }

  return mask;
}

function weekdayMaskToLabel(mask) {
  if (mask === (2 | 4 | 8 | 16 | 32)) return 'Werktage';
  if (mask === (1 | 64)) return 'Wochenende';
  if (mask === (1 | 2 | 4 | 8 | 16 | 32 | 64)) return 'Alle Tage';

  const labels = [];
  if (mask & 1) labels.push('Sonntag');
  if (mask & 2) labels.push('Montag');
  if (mask & 4) labels.push('Dienstag');
  if (mask & 8) labels.push('Mittwoch');
  if (mask & 16) labels.push('Donnerstag');
  if (mask & 32) labels.push('Freitag');
  if (mask & 64) labels.push('Samstag');

  return labels.join(', ');
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName('regel')
    .setDescription('Verwalte deine wiederkehrenden Verfügbarkeitsregeln.')
    .addSubcommand(sub =>
      sub
        .setName('hinzufuegen')
        .setDescription('Fügt eine neue Regel hinzu.')
        .addStringOption(option =>
          option
            .setName('tage')
            .setDescription('Z. B. werktage, wochenende, alle oder montag,dienstag')
            .setRequired(true)
        )
        .addStringOption(option =>
          option
            .setName('typ')
            .setDescription('Welche Regel soll gelten?')
            .setRequired(true)
            .addChoices(
              { name: 'Nicht verfügbar', value: 'nicht_verfuegbar' },
              { name: 'Erst ab Uhrzeit verfügbar', value: 'erst_ab' },
              { name: 'Nur bis Uhrzeit verfügbar', value: 'bis' }
            )
        )
        .addStringOption(option =>
          option
            .setName('uhrzeit')
            .setDescription('Erforderlich für "erst_ab" oder "bis", Format HH:MM')
            .setRequired(false)
        )
        .addStringOption(option =>
          option
            .setName('notiz')
            .setDescription('Optional: z. B. Arbeit, Uni, Training')
            .setRequired(false)
        )
    )
    .addSubcommand(sub =>
      sub
        .setName('anzeigen')
        .setDescription('Zeigt deine Regeln an.')
    )
    .addSubcommand(sub =>
      sub
        .setName('loeschen')
        .setDescription('Löscht eine Regel anhand der ID.')
        .addIntegerOption(option =>
          option
            .setName('id')
            .setDescription('Die ID aus /regel anzeigen')
            .setRequired(true)
        )
    ),

  async execute(interaction) {
    const subcommand = interaction.options.getSubcommand();
    const player = ensurePlayer(interaction.user);

    if (subcommand === 'hinzufuegen') {
      const tageInput = interaction.options.getString('tage', true).trim();
      const ruleType = interaction.options.getString('typ', true);
      const timeValue = interaction.options.getString('uhrzeit')?.trim() ?? null;
      const note = interaction.options.getString('notiz')?.trim() ?? null;

      const weekdayMask = parseWeekdayMask(tageInput);

      if (weekdayMask === null) {
        return interaction.reply({
          content: 'Ungültige Tage. Nutze z. B. werktage, wochenende, alle oder montag,dienstag.',
          ephemeral: true
        });
      }

      if ((ruleType === 'erst_ab' || ruleType === 'bis') && !timeValue) {
        return interaction.reply({
          content: 'Für diesen Regeltyp musst du eine Uhrzeit angeben.',
          ephemeral: true
        });
      }

      if (timeValue && !isValidTime(timeValue)) {
        return interaction.reply({
          content: 'Uhrzeit ungültig. Bitte nutze HH:MM, z. B. 19:30.',
          ephemeral: true
        });
      }

      const now = new Date().toISOString();

      const result = db.prepare(`
        INSERT INTO availability_rules (
          player_id,
          weekday_mask,
          rule_type,
          time_value,
          note,
          active,
          created_at,
          updated_at
        )
        VALUES (?, ?, ?, ?, ?, 1, ?, ?)
      `).run(
        player.id,
        weekdayMask,
        ruleType,
        timeValue,
        note,
        now,
        now
      );

      const readable =
        ruleType === 'nicht_verfuegbar'
          ? 'nicht verfügbar'
          : `${ruleLabelMap[ruleType]} ${timeValue}`;

      return interaction.reply({
        content:
          `Regel gespeichert.\n` +
          `ID: **${result.lastInsertRowid}**\n` +
          `Tage: **${weekdayMaskToLabel(weekdayMask)}**\n` +
          `Regel: **${readable}**\n` +
          `Notiz: **${note ?? '-'}**`,
        ephemeral: true
      });
    }

    if (subcommand === 'anzeigen') {
      const rows = db.prepare(`
        SELECT id, weekday_mask, rule_type, time_value, note
        FROM availability_rules
        WHERE player_id = ?
          AND active = 1
        ORDER BY id ASC
      `).all(player.id);

      if (rows.length === 0) {
        return interaction.reply({
          content: 'Du hast aktuell keine Regeln gespeichert.',
          ephemeral: true
        });
      }

      const lines = rows.map(row => {
        let detail = ruleLabelMap[row.rule_type] ?? row.rule_type;

        if (row.rule_type === 'erst_ab' || row.rule_type === 'bis') {
          detail += ` ${row.time_value}`;
        }

        return `**#${row.id}** • ${weekdayMaskToLabel(row.weekday_mask)} • ${detail} • Notiz: ${row.note ?? '-'}`;
      });

      return interaction.reply({
        content: `**Deine Regeln**\n${lines.join('\n')}`,
        ephemeral: true
      });
    }

    if (subcommand === 'loeschen') {
      const id = interaction.options.getInteger('id', true);

      const existing = db.prepare(`
        SELECT id
        FROM availability_rules
        WHERE id = ?
          AND player_id = ?
          AND active = 1
      `).get(id, player.id);

      if (!existing) {
        return interaction.reply({
          content: 'Ich habe keine eigene Regel mit dieser ID gefunden.',
          ephemeral: true
        });
      }

      db.prepare(`
        UPDATE availability_rules
        SET active = 0,
            updated_at = ?
        WHERE id = ?
          AND player_id = ?
      `).run(new Date().toISOString(), id, player.id);

      return interaction.reply({
        content: `Regel **#${id}** wurde gelöscht.`,
        ephemeral: true
      });
    }
  }
};