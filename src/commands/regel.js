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
    if (mask === 0) return '-';

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

function formatDateDE(dateStr) {
    const [year, month, day] = dateStr.split('-');
    return `${day}.${month}.${year}`;
}

function formatDayMonth(dateStr) {
    const [, month, day] = dateStr.split('-');
    return `${day}.${month}.`;
}

function getWeekdayIndexFromIsoDate(dateStr) {
    const [year, month, day] = dateStr.split('-').map(Number);
    return new Date(Date.UTC(year, month - 1, day)).getUTCDay();
}

function getWeekdayNameFromIsoDate(dateStr) {
    const names = ['Sonntag', 'Montag', 'Dienstag', 'Mittwoch', 'Donnerstag', 'Freitag', 'Samstag'];
    return names[getWeekdayIndexFromIsoDate(dateStr)];
}

function recurrenceToLabel(recurrenceType, weekdayMask, anchorDate) {
    const startLabel = `aktiv ab ${getWeekdayNameFromIsoDate(anchorDate)}, ${formatDateDE(anchorDate)}`;

    switch (recurrenceType) {
        case 'weekly':
            return `Wöchentlich • ${weekdayMaskToLabel(weekdayMask)} • ${startLabel}`;
        case 'biweekly':
            return `Alle 2 Wochen • ${weekdayMaskToLabel(weekdayMask)} • ${startLabel}`;
        case 'monthly': {
            const day = Number(anchorDate.split('-')[2]);
            return `Monatlich • am ${day}. • ${startLabel}`;
        }
        case 'yearly':
            return `Jährlich • am ${formatDayMonth(anchorDate)} • ${startLabel}`;
        default:
            return `Wöchentlich • ${weekdayMaskToLabel(weekdayMask)} • ${startLabel}`;
    }
}

function ruleToLabel(ruleType, timeValue) {
    if (ruleType === 'nicht_verfuegbar') {
        return 'nicht verfügbar';
    }

    return `${ruleLabelMap[ruleType]} ${timeValue}`;
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
                        .setName('wiederholung')
                        .setDescription('Wie oft wiederholt sich die Regel?')
                        .setRequired(true)
                        .addChoices(
                            { name: 'Wöchentlich', value: 'weekly' },
                            { name: 'Alle 2 Wochen', value: 'biweekly' },
                            { name: 'Monatlich', value: 'monthly' },
                            { name: 'Jährlich / Geburtstag', value: 'yearly' }
                        )
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
                        .setName('startdatum')
                        .setDescription('Pflicht: TT.MM.JJJJ oder YYYY-MM-DD, ab wann die Regel gilt')
                        .setRequired(true)
                )
                .addStringOption(option =>
                    option
                        .setName('tage')
                        .setDescription('Für wöchentliche Regeln: werktage, wochenende, alle oder montag,dienstag')
                        .setRequired(false)
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
                        .setDescription('Optional: z. B. Arbeit, Uni, Training, Geburtstag')
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
            const recurrenceType = interaction.options.getString('wiederholung', true);
            const ruleType = interaction.options.getString('typ', true);
            const startdatumInput = interaction.options.getString('startdatum', true).trim();
            const tageInput = interaction.options.getString('tage')?.trim() ?? null;
            const timeValue = interaction.options.getString('uhrzeit')?.trim() ?? null;
            const note = interaction.options.getString('notiz')?.trim() ?? null;

            const anchorDate = parseDateInput(startdatumInput);

            if (!anchorDate) {
                return interaction.reply({
                    content: 'Startdatum ungültig. Nutze TT.MM.JJJJ oder YYYY-MM-DD, z. B. 11.04.2026.',
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

            let weekdayMask = 0;

            if (recurrenceType === 'weekly' || recurrenceType === 'biweekly') {
                if (!tageInput) {
                    return interaction.reply({
                        content: 'Für wöchentliche oder zweiwöchentliche Regeln musst du Tage angeben.',
                        ephemeral: true
                    });
                }

                weekdayMask = parseWeekdayMask(tageInput);

                if (weekdayMask === null) {
                    return interaction.reply({
                        content: 'Ungültige Tage. Nutze z. B. werktage, wochenende, alle oder montag,dienstag.',
                        ephemeral: true
                    });
                }
            } else if (tageInput) {
                return interaction.reply({
                    content: 'Für monatliche oder jährliche Regeln nutze bitte kein Feld "tage", sondern nur das Startdatum.',
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
          recurrence_type,
          anchor_date,
          active,
          created_at,
          updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
      `).run(
                player.id,
                weekdayMask,
                ruleType,
                timeValue,
                note,
                recurrenceType,
                anchorDate,
                now,
                now
            );

            return interaction.reply({
                content:
                    `Regel gespeichert.\n` +
                    `ID: **${result.lastInsertRowid}**\n` +
                    `Wiederholung: **${recurrenceToLabel(recurrenceType, weekdayMask, anchorDate)}**\n` +
                    `Regel: **${ruleToLabel(ruleType, timeValue)}**\n` +
                    `Notiz: **${note ?? '-'}**`,
                ephemeral: true
            });
        }

        if (subcommand === 'anzeigen') {
            const rows = db.prepare(`
        SELECT id, weekday_mask, rule_type, time_value, note, recurrence_type, anchor_date
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
                const recurrenceLabel = recurrenceToLabel(
                    row.recurrence_type ?? 'weekly',
                    row.weekday_mask,
                    row.anchor_date
                );

                return `**#${row.id}** • ${recurrenceLabel} • ${ruleToLabel(row.rule_type, row.time_value)} • Notiz: ${row.note ?? '-'}`;
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