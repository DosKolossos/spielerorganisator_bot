const { SlashCommandBuilder } = require('discord.js');
const db = require('../db/database');
const { requireAdmin } = require('../utils/permissions');
const { logAdminAction, notifyUser } = require('../utils/adminTools');
const { upsertPlayer, playerDisplay } = require('../utils/playerUtils');
const { todayInBerlin, parseDateInput, isValidTime, formatDateDE } = require('../utils/time');

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

function getWeekdayIndexFromIsoDate(dateStr) {
  const [year, month, day] = dateStr.split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, day)).getUTCDay();
}

function getWeekdayNameFromIsoDate(dateStr) {
  const names = ['Sonntag', 'Montag', 'Dienstag', 'Mittwoch', 'Donnerstag', 'Freitag', 'Samstag'];
  return names[getWeekdayIndexFromIsoDate(dateStr)];
}

function formatDayMonth(dateStr) {
  const [, month, day] = dateStr.split('-');
  return `${day}.${month}.`;
}

function recurrenceToLabel(recurrenceType, weekdayMask, anchorDate) {
  const startLabel = `aktiv ab ${getWeekdayNameFromIsoDate(anchorDate)}, ${formatDateDE(anchorDate)}`;

  switch (recurrenceType) {
    case 'weekly':
      return `Wöchentlich • ${weekdayMaskToLabel(weekdayMask)} • ${startLabel}`;
    case 'biweekly':
      return `Alle 2 Wochen • ${weekdayMaskToLabel(weekdayMask)} • ${startLabel}`;
    case 'monthly':
      return `Monatlich • am ${Number(anchorDate.split('-')[2])}. • ${startLabel}`;
    case 'yearly':
      return `Jährlich • am ${formatDayMonth(anchorDate)} • ${startLabel}`;
    default:
      return `Wöchentlich • ${weekdayMaskToLabel(weekdayMask)} • ${startLabel}`;
  }
}

function ruleToLabel(ruleType, timeValue) {
  if (ruleType === 'nicht_verfuegbar') return 'nicht verfügbar';
  return `${ruleLabelMap[ruleType]} ${timeValue}`;
}

function suspensionLabel(rule) {
  if (!rule.suspended_from) return null;
  const from = formatDateDE(rule.suspended_from);
  const until = rule.suspended_until ? formatDateDE(rule.suspended_until) : 'bis auf Weiteres';
  return `Ausgesetzt: ${from} → ${until}${rule.suspension_note ? ` • ${rule.suspension_note}` : ''}`;
}

function buildRuleLine(row) {
  const recurrenceLabel = recurrenceToLabel(row.recurrence_type ?? 'weekly', row.weekday_mask, row.anchor_date);
  const suspension = suspensionLabel(row);
  return `**#${row.id}** • ${recurrenceLabel} • ${ruleToLabel(row.rule_type, row.time_value)} • Notiz: ${row.note ?? '-'}${suspension ? ` • ${suspension}` : ''}`;
}

function validateRulePayload({ recurrenceType, ruleType, startdatumInput, tageInput, timeValue }, existing = null) {
  const anchorDate = startdatumInput ? parseDateInput(startdatumInput) : existing?.anchor_date;
  if (!anchorDate) return { error: 'Startdatum ungültig. Nutze TT.MM.JJJJ oder YYYY-MM-DD.' };

  if ((ruleType === 'erst_ab' || ruleType === 'bis') && !timeValue) {
    return { error: 'Für diesen Regeltyp musst du eine Uhrzeit angeben.' };
  }

  if (timeValue && !isValidTime(timeValue)) {
    return { error: 'Uhrzeit ungültig. Bitte nutze HH:MM.' };
  }

  let weekdayMask = existing?.weekday_mask ?? 0;
  if (recurrenceType === 'weekly' || recurrenceType === 'biweekly') {
    const source = tageInput ?? (existing ? weekdayMaskToLabel(existing.weekday_mask) : null);
    if (!source) return { error: 'Für wöchentliche oder zweiwöchentliche Regeln musst du Tage angeben.' };
    weekdayMask = parseWeekdayMask(source);
    if (weekdayMask === null) return { error: 'Ungültige Tage. Nutze z. B. werktage, wochenende, alle oder montag,dienstag.' };
  } else if (tageInput) {
    return { error: 'Für monatliche oder jährliche Regeln nutze bitte kein Feld "tage".' };
  } else {
    weekdayMask = 0;
  }

  return { anchorDate, weekdayMask };
}

function addSelfSubcommands(builder) {
  return builder
    .addSubcommand(sub =>
      sub
        .setName('hinzufuegen')
        .setDescription('Fügt eine neue Regel hinzu.')
        .addStringOption(option => option.setName('wiederholung').setDescription('Wie oft wiederholt sich die Regel?').setRequired(true)
          .addChoices(
            { name: 'Wöchentlich', value: 'weekly' },
            { name: 'Alle 2 Wochen', value: 'biweekly' },
            { name: 'Monatlich', value: 'monthly' },
            { name: 'Jährlich / Geburtstag', value: 'yearly' }
          ))
        .addStringOption(option => option.setName('typ').setDescription('Welche Regel soll gelten?').setRequired(true)
          .addChoices(
            { name: 'Nicht verfügbar', value: 'nicht_verfuegbar' },
            { name: 'Erst ab Uhrzeit verfügbar', value: 'erst_ab' },
            { name: 'Nur bis Uhrzeit verfügbar', value: 'bis' }
          ))
        .addStringOption(option => option.setName('startdatum').setDescription('Pflicht: TT.MM.JJJJ oder YYYY-MM-DD').setRequired(true))
        .addStringOption(option => option.setName('tage').setDescription('Für weekly/biweekly: werktage, wochenende, alle oder montag,dienstag').setRequired(false))
        .addStringOption(option => option.setName('uhrzeit').setDescription('Für erst_ab/bis: HH:MM').setRequired(false))
        .addStringOption(option => option.setName('notiz').setDescription('Optional').setRequired(false))
    )
    .addSubcommand(sub =>
      sub
        .setName('bearbeiten')
        .setDescription('Bearbeitet eine bestehende Regel anhand der ID.')
        .addIntegerOption(option => option.setName('id').setDescription('Die ID aus /regel anzeigen').setRequired(true))
        .addStringOption(option => option.setName('wiederholung').setDescription('Optional: neuer Wiederholungstyp').setRequired(false)
          .addChoices(
            { name: 'Wöchentlich', value: 'weekly' },
            { name: 'Alle 2 Wochen', value: 'biweekly' },
            { name: 'Monatlich', value: 'monthly' },
            { name: 'Jährlich / Geburtstag', value: 'yearly' }
          ))
        .addStringOption(option => option.setName('typ').setDescription('Optional: neuer Regeltyp').setRequired(false)
          .addChoices(
            { name: 'Nicht verfügbar', value: 'nicht_verfuegbar' },
            { name: 'Erst ab Uhrzeit verfügbar', value: 'erst_ab' },
            { name: 'Nur bis Uhrzeit verfügbar', value: 'bis' }
          ))
        .addStringOption(option => option.setName('startdatum').setDescription('Optional: neues Startdatum').setRequired(false))
        .addStringOption(option => option.setName('tage').setDescription('Optional: neue Tage').setRequired(false))
        .addStringOption(option => option.setName('uhrzeit').setDescription('Optional: neue Uhrzeit').setRequired(false))
        .addStringOption(option => option.setName('notiz').setDescription('Optional: neue Notiz, mit "-" löschen').setRequired(false))
    )
    .addSubcommand(sub => sub.setName('anzeigen').setDescription('Zeigt deine Regeln an.'))
    .addSubcommand(sub =>
      sub
        .setName('loeschen')
        .setDescription('Löscht eine Regel anhand der ID.')
        .addIntegerOption(option => option.setName('id').setDescription('Die ID aus /regel anzeigen').setRequired(true))
    )
    .addSubcommand(sub =>
      sub
        .setName('aussetzen')
        .setDescription('Setzt eine Regel zeitweise aus.')
        .addIntegerOption(option => option.setName('id').setDescription('Regel-ID').setRequired(true))
        .addStringOption(option => option.setName('von').setDescription('Pflicht: Start der Aussetzung').setRequired(true))
        .addStringOption(option => option.setName('bis').setDescription('Optional: Ende der Aussetzung').setRequired(false))
        .addStringOption(option => option.setName('grund').setDescription('Optionaler Grund').setRequired(false))
    )
    .addSubcommand(sub =>
      sub
        .setName('fortsetzen')
        .setDescription('Hebt eine Aussetzung wieder auf.')
        .addIntegerOption(option => option.setName('id').setDescription('Regel-ID').setRequired(true))
    );
}

function addAdminSubcommands(builder) {
  return builder
    .addSubcommand(sub =>
      sub
        .setName('admin-anzeigen')
        .setDescription('Zeigt Regeln eines Spielers oder eine Übersicht an.')
        .addUserOption(option => option.setName('spieler').setDescription('Optional: bestimmter Spieler').setRequired(false))
    )
    .addSubcommand(sub => {
      sub
        .setName('admin-hinzufuegen')
        .setDescription('Fügt einem Spieler eine Regel hinzu.')
        .addUserOption(option => option.setName('spieler').setDescription('Betroffener Spieler').setRequired(true))
        .addStringOption(option => option.setName('wiederholung').setDescription('Wie oft?').setRequired(true)
          .addChoices(
            { name: 'Wöchentlich', value: 'weekly' },
            { name: 'Alle 2 Wochen', value: 'biweekly' },
            { name: 'Monatlich', value: 'monthly' },
            { name: 'Jährlich / Geburtstag', value: 'yearly' }
          ))
        .addStringOption(option => option.setName('typ').setDescription('Regeltyp').setRequired(true)
          .addChoices(
            { name: 'Nicht verfügbar', value: 'nicht_verfuegbar' },
            { name: 'Erst ab Uhrzeit verfügbar', value: 'erst_ab' },
            { name: 'Nur bis Uhrzeit verfügbar', value: 'bis' }
          ))
        .addStringOption(option => option.setName('startdatum').setDescription('Pflicht: Startdatum').setRequired(true))
        .addStringOption(option => option.setName('tage').setDescription('Optional: Tage').setRequired(false))
        .addStringOption(option => option.setName('uhrzeit').setDescription('Optional: HH:MM').setRequired(false))
        .addStringOption(option => option.setName('notiz').setDescription('Optional').setRequired(false));
      return sub;
    })
    .addSubcommand(sub =>
      sub
        .setName('admin-bearbeiten')
        .setDescription('Bearbeitet eine Regel global über die ID.')
        .addIntegerOption(option => option.setName('id').setDescription('Regel-ID').setRequired(true))
        .addStringOption(option => option.setName('wiederholung').setDescription('Optional').setRequired(false)
          .addChoices(
            { name: 'Wöchentlich', value: 'weekly' },
            { name: 'Alle 2 Wochen', value: 'biweekly' },
            { name: 'Monatlich', value: 'monthly' },
            { name: 'Jährlich / Geburtstag', value: 'yearly' }
          ))
        .addStringOption(option => option.setName('typ').setDescription('Optional').setRequired(false)
          .addChoices(
            { name: 'Nicht verfügbar', value: 'nicht_verfuegbar' },
            { name: 'Erst ab Uhrzeit verfügbar', value: 'erst_ab' },
            { name: 'Nur bis Uhrzeit verfügbar', value: 'bis' }
          ))
        .addStringOption(option => option.setName('startdatum').setDescription('Optional').setRequired(false))
        .addStringOption(option => option.setName('tage').setDescription('Optional').setRequired(false))
        .addStringOption(option => option.setName('uhrzeit').setDescription('Optional').setRequired(false))
        .addStringOption(option => option.setName('notiz').setDescription('Optional, mit "-" löschen').setRequired(false))
    )
    .addSubcommand(sub =>
      sub.setName('admin-loeschen').setDescription('Löscht eine Regel global über die ID.')
        .addIntegerOption(option => option.setName('id').setDescription('Regel-ID').setRequired(true))
    )
    .addSubcommand(sub =>
      sub.setName('admin-aussetzen').setDescription('Setzt eine Regel zeitweise aus.')
        .addIntegerOption(option => option.setName('id').setDescription('Regel-ID').setRequired(true))
        .addStringOption(option => option.setName('von').setDescription('Pflicht: Start der Aussetzung').setRequired(true))
        .addStringOption(option => option.setName('bis').setDescription('Optional: Ende der Aussetzung').setRequired(false))
        .addStringOption(option => option.setName('grund').setDescription('Optional').setRequired(false))
    )
    .addSubcommand(sub =>
      sub.setName('admin-fortsetzen').setDescription('Hebt eine Aussetzung auf.')
        .addIntegerOption(option => option.setName('id').setDescription('Regel-ID').setRequired(true))
    );
}

async function saveRule({ interaction, player, recurrenceType, ruleType, anchorDate, weekdayMask, timeValue, note }) {
  const now = new Date().toISOString();
  const result = db.prepare(`
    INSERT INTO availability_rules (
      player_id, weekday_mask, rule_type, time_value, note,
      recurrence_type, anchor_date, active, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
  `).run(player.id, weekdayMask, ruleType, timeValue, note, recurrenceType, anchorDate, now, now);

  return Number(result.lastInsertRowid);
}

function getRuleByIdForPlayer(id, playerId) {
  return db.prepare(`
    SELECT *
    FROM availability_rules
    WHERE id = ? AND player_id = ? AND active = 1
  `).get(id, playerId);
}

function getRuleById(id) {
  return db.prepare(`
    SELECT r.*, p.discord_user_id, p.alias, p.global_name, p.username
    FROM availability_rules r
    INNER JOIN players p ON p.id = r.player_id
    WHERE r.id = ?
  `).get(id);
}

function applySuspension(id, from, until, note, actorDiscordUserId) {
  const now = new Date().toISOString();
  db.prepare(`
    UPDATE availability_rules
    SET suspended_from = ?,
        suspended_until = ?,
        suspension_note = ?,
        suspended_by_discord_user_id = ?,
        suspended_at = ?,
        updated_at = ?
    WHERE id = ?
  `).run(from, until, note, actorDiscordUserId, now, now, id);
}

function clearSuspension(id) {
  db.prepare(`
    UPDATE availability_rules
    SET suspended_from = NULL,
        suspended_until = NULL,
        suspension_note = NULL,
        suspended_by_discord_user_id = NULL,
        suspended_at = NULL,
        updated_at = ?
    WHERE id = ?
  `).run(new Date().toISOString(), id);
}

const command = {
  data: addAdminSubcommands(addSelfSubcommands(
    new SlashCommandBuilder().setName('regel').setDescription('Verwalte wiederkehrende Verfügbarkeitsregeln.')
  )),

  async execute(interaction) {
    const subcommand = interaction.options.getSubcommand();
    const actorLabel = interaction.member?.displayName || interaction.user.username;
    const selfPlayer = upsertPlayer(interaction.user);

    if (subcommand === 'anzeigen') {
      const rows = db.prepare(`
        SELECT *
        FROM availability_rules
        WHERE player_id = ? AND active = 1
        ORDER BY id ASC
      `).all(selfPlayer.id);

      return interaction.reply({
        content: rows.length ? `**Deine Regeln**\n${rows.map(buildRuleLine).join('\n')}` : 'Du hast aktuell keine Regeln gespeichert.',
        ephemeral: true
      });
    }

    if (subcommand === 'hinzufuegen') {
      const recurrenceType = interaction.options.getString('wiederholung', true);
      const ruleType = interaction.options.getString('typ', true);
      const startdatumInput = interaction.options.getString('startdatum', true).trim();
      const tageInput = interaction.options.getString('tage')?.trim() ?? null;
      const timeValue = interaction.options.getString('uhrzeit')?.trim() ?? null;
      const note = interaction.options.getString('notiz')?.trim() ?? null;

      const validated = validateRulePayload({ recurrenceType, ruleType, startdatumInput, tageInput, timeValue });
      if (validated.error) return interaction.reply({ content: validated.error, ephemeral: true });

      const id = await saveRule({ interaction, player: selfPlayer, recurrenceType, ruleType, anchorDate: validated.anchorDate, weekdayMask: validated.weekdayMask, timeValue, note });
      return interaction.reply({
        content:
          `Regel gespeichert.\n` +
          `ID: **${id}**\n` +
          `Wiederholung: **${recurrenceToLabel(recurrenceType, validated.weekdayMask, validated.anchorDate)}**\n` +
          `Regel: **${ruleToLabel(ruleType, timeValue)}**\n` +
          `Notiz: **${note ?? '-'}**`,
        ephemeral: true
      });
    }

    if (subcommand === 'bearbeiten') {
      const id = interaction.options.getInteger('id', true);
      const existing = getRuleByIdForPlayer(id, selfPlayer.id);
      if (!existing) return interaction.reply({ content: 'Ich habe keine eigene Regel mit dieser ID gefunden.', ephemeral: true });

      const recurrenceType = interaction.options.getString('wiederholung') ?? (existing.recurrence_type ?? 'weekly');
      const ruleType = interaction.options.getString('typ') ?? existing.rule_type;
      const timeValue = ruleType === 'nicht_verfuegbar'
        ? null
        : (interaction.options.getString('uhrzeit')?.trim() ?? existing.time_value);
      const validated = validateRulePayload({
        recurrenceType,
        ruleType,
        startdatumInput: interaction.options.getString('startdatum')?.trim() ?? null,
        tageInput: interaction.options.getString('tage')?.trim() ?? null,
        timeValue
      }, existing);
      if (validated.error) return interaction.reply({ content: validated.error, ephemeral: true });

      const noteInput = interaction.options.getString('notiz');
      const note = noteInput === null ? existing.note : (noteInput.trim() === '-' ? null : noteInput.trim());

      db.prepare(`
        UPDATE availability_rules
        SET weekday_mask = ?, rule_type = ?, time_value = ?, note = ?,
            recurrence_type = ?, anchor_date = ?, updated_at = ?
        WHERE id = ? AND player_id = ?
      `).run(validated.weekdayMask, ruleType, timeValue, note, recurrenceType, validated.anchorDate, new Date().toISOString(), id, selfPlayer.id);

      return interaction.reply({
        content:
          `Regel **#${id}** wurde aktualisiert.\n` +
          `Wiederholung: **${recurrenceToLabel(recurrenceType, validated.weekdayMask, validated.anchorDate)}**\n` +
          `Regel: **${ruleToLabel(ruleType, timeValue)}**\n` +
          `Notiz: **${note ?? '-'}**`,
        ephemeral: true
      });
    }

    if (subcommand === 'loeschen') {
      const id = interaction.options.getInteger('id', true);
      const existing = getRuleByIdForPlayer(id, selfPlayer.id);
      if (!existing) return interaction.reply({ content: 'Ich habe keine eigene Regel mit dieser ID gefunden.', ephemeral: true });

      db.prepare(`UPDATE availability_rules SET active = 0, updated_at = ? WHERE id = ? AND player_id = ?`).run(new Date().toISOString(), id, selfPlayer.id);
      return interaction.reply({ content: `Regel **#${id}** wurde gelöscht.`, ephemeral: true });
    }

    if (subcommand === 'aussetzen' || subcommand === 'fortsetzen') {
      const id = interaction.options.getInteger('id', true);
      const existing = getRuleByIdForPlayer(id, selfPlayer.id);
      if (!existing) return interaction.reply({ content: 'Ich habe keine eigene Regel mit dieser ID gefunden.', ephemeral: true });

      if (subcommand === 'fortsetzen') {
        clearSuspension(id);
        return interaction.reply({ content: `Regel **#${id}** ist wieder aktiv.`, ephemeral: true });
      }

      const from = parseDateInput(interaction.options.getString('von', true).trim());
      const untilInput = interaction.options.getString('bis')?.trim() ?? null;
      const until = untilInput ? parseDateInput(untilInput) : null;
      const note = interaction.options.getString('grund')?.trim() ?? null;
      if (!from) return interaction.reply({ content: 'Startdatum der Aussetzung ist ungültig.', ephemeral: true });
      if (untilInput && !until) return interaction.reply({ content: 'Enddatum der Aussetzung ist ungültig.', ephemeral: true });
      if (from < todayInBerlin()) return interaction.reply({ content: 'Aussetzungen können nicht in der Vergangenheit beginnen.', ephemeral: true });
      if (until && until < from) return interaction.reply({ content: 'Das Ende der Aussetzung darf nicht vor dem Start liegen.', ephemeral: true });

      applySuspension(id, from, until, note, interaction.user.id);
      return interaction.reply({ content: `Regel **#${id}** wurde ausgesetzt.`, ephemeral: true });
    }

    if (!(await requireAdmin(interaction))) return;

    if (subcommand === 'admin-anzeigen') {
      const targetUser = interaction.options.getUser('spieler');
      if (targetUser) {
        const targetPlayer = upsertPlayer(targetUser);
        const rows = db.prepare(`SELECT * FROM availability_rules WHERE player_id = ? AND active = 1 ORDER BY id ASC`).all(targetPlayer.id);
        return interaction.reply({
          content: rows.length ? `**Regeln von ${playerDisplay(targetPlayer)}**\n${rows.map(buildRuleLine).join('\n')}` : 'Keine Regeln gefunden.',
          ephemeral: true
        });
      }

      const rows = db.prepare(`
        SELECT r.*, p.alias, p.global_name, p.username, p.discord_user_id
        FROM availability_rules r
        INNER JOIN players p ON p.id = r.player_id
        WHERE r.active = 1 AND p.is_archived = 0
        ORDER BY COALESCE(p.alias, p.global_name, p.username) COLLATE NOCASE ASC, r.id ASC
        LIMIT 40
      `).all();

      const lines = rows.map(row => `**${playerDisplay(row)}** • ${buildRuleLine(row)}`);
      return interaction.reply({
        content: lines.length ? `**Regel-Übersicht**\n${lines.join('\n')}` : 'Keine aktiven Regeln gefunden.',
        ephemeral: true
      });
    }

    if (subcommand === 'admin-hinzufuegen') {
      const targetUser = interaction.options.getUser('spieler', true);
      const targetPlayer = upsertPlayer(targetUser);
      const recurrenceType = interaction.options.getString('wiederholung', true);
      const ruleType = interaction.options.getString('typ', true);
      const startdatumInput = interaction.options.getString('startdatum', true).trim();
      const tageInput = interaction.options.getString('tage')?.trim() ?? null;
      const timeValue = interaction.options.getString('uhrzeit')?.trim() ?? null;
      const note = interaction.options.getString('notiz')?.trim() ?? null;
      const validated = validateRulePayload({ recurrenceType, ruleType, startdatumInput, tageInput, timeValue });
      if (validated.error) return interaction.reply({ content: validated.error, ephemeral: true });

      const id = await saveRule({ interaction, player: targetPlayer, recurrenceType, ruleType, anchorDate: validated.anchorDate, weekdayMask: validated.weekdayMask, timeValue, note });
      await notifyUser(interaction.client, targetUser.id,
        `📐 Für dich wurde von **${actorLabel}** eine Regel angelegt.\n${buildRuleLine({ id, recurrence_type: recurrenceType, weekday_mask: validated.weekdayMask, anchor_date: validated.anchorDate, rule_type: ruleType, time_value: timeValue, note })}`
      );
      await logAdminAction(interaction.client, {
        actorDiscordUserId: interaction.user.id,
        actorLabel,
        targetDiscordUserId: targetUser.id,
        targetLabel: playerDisplay(targetPlayer),
        entityType: 'regel',
        entityId: id,
        actionType: 'erstellt',
        details: ruleToLabel(ruleType, timeValue)
      });
      return interaction.reply({ content: `Regel **#${id}** wurde für **${playerDisplay(targetPlayer)}** erstellt.`, ephemeral: true });
    }

    const id = interaction.options.getInteger('id', true);
    const rule = getRuleById(id);
    if (!rule) return interaction.reply({ content: 'Keine Regel mit dieser ID gefunden.', ephemeral: true });

    if (subcommand === 'admin-bearbeiten') {
      const recurrenceType = interaction.options.getString('wiederholung') ?? (rule.recurrence_type ?? 'weekly');
      const ruleType = interaction.options.getString('typ') ?? rule.rule_type;
      const timeValue = ruleType === 'nicht_verfuegbar'
        ? null
        : (interaction.options.getString('uhrzeit')?.trim() ?? rule.time_value);
      const validated = validateRulePayload({
        recurrenceType,
        ruleType,
        startdatumInput: interaction.options.getString('startdatum')?.trim() ?? null,
        tageInput: interaction.options.getString('tage')?.trim() ?? null,
        timeValue
      }, rule);
      if (validated.error) return interaction.reply({ content: validated.error, ephemeral: true });

      const noteInput = interaction.options.getString('notiz');
      const note = noteInput === null ? rule.note : (noteInput.trim() === '-' ? null : noteInput.trim());

      db.prepare(`
        UPDATE availability_rules
        SET weekday_mask = ?, rule_type = ?, time_value = ?, note = ?,
            recurrence_type = ?, anchor_date = ?, updated_at = ?
        WHERE id = ?
      `).run(validated.weekdayMask, ruleType, timeValue, note, recurrenceType, validated.anchorDate, new Date().toISOString(), id);

      await notifyUser(interaction.client, rule.discord_user_id,
        `🛠️ Deine Regel **#${id}** wurde von **${actorLabel}** angepasst.`
      );
      await logAdminAction(interaction.client, {
        actorDiscordUserId: interaction.user.id,
        actorLabel,
        targetDiscordUserId: rule.discord_user_id,
        targetLabel: playerDisplay(rule),
        entityType: 'regel',
        entityId: id,
        actionType: 'bearbeitet',
        details: ruleToLabel(ruleType, timeValue)
      });

      return interaction.reply({ content: `Regel **#${id}** wurde aktualisiert.`, ephemeral: true });
    }

    if (subcommand === 'admin-loeschen') {
      db.prepare(`UPDATE availability_rules SET active = 0, updated_at = ? WHERE id = ?`).run(new Date().toISOString(), id);
      await notifyUser(interaction.client, rule.discord_user_id,
        `🗑️ Deine Regel **#${id}** wurde von **${actorLabel}** gelöscht.`
      );
      await logAdminAction(interaction.client, {
        actorDiscordUserId: interaction.user.id,
        actorLabel,
        targetDiscordUserId: rule.discord_user_id,
        targetLabel: playerDisplay(rule),
        entityType: 'regel',
        entityId: id,
        actionType: 'gelöscht',
        details: ruleToLabel(rule.rule_type, rule.time_value)
      });
      return interaction.reply({ content: `Regel **#${id}** wurde gelöscht.`, ephemeral: true });
    }

    if (subcommand === 'admin-aussetzen' || subcommand === 'admin-fortsetzen') {
      if (subcommand === 'admin-fortsetzen') {
        clearSuspension(id);
        await notifyUser(interaction.client, rule.discord_user_id,
          `✅ Die Aussetzung deiner Regel **#${id}** wurde von **${actorLabel}** aufgehoben.`
        );
        await logAdminAction(interaction.client, {
          actorDiscordUserId: interaction.user.id,
          actorLabel,
          targetDiscordUserId: rule.discord_user_id,
          targetLabel: playerDisplay(rule),
          entityType: 'regel',
          entityId: id,
          actionType: 'fortgesetzt',
          details: 'Regel wieder aktiv'
        });
        return interaction.reply({ content: `Regel **#${id}** ist wieder aktiv.`, ephemeral: true });
      }

      const from = parseDateInput(interaction.options.getString('von', true).trim());
      const untilInput = interaction.options.getString('bis')?.trim() ?? null;
      const until = untilInput ? parseDateInput(untilInput) : null;
      const note = interaction.options.getString('grund')?.trim() ?? null;
      if (!from) return interaction.reply({ content: 'Startdatum der Aussetzung ist ungültig.', ephemeral: true });
      if (untilInput && !until) return interaction.reply({ content: 'Enddatum der Aussetzung ist ungültig.', ephemeral: true });
      if (until && until < from) return interaction.reply({ content: 'Das Ende der Aussetzung darf nicht vor dem Start liegen.', ephemeral: true });

      applySuspension(id, from, until, note, interaction.user.id);
      await notifyUser(interaction.client, rule.discord_user_id,
        `⏸️ Deine Regel **#${id}** wurde von **${actorLabel}** ausgesetzt.`
      );
      await logAdminAction(interaction.client, {
        actorDiscordUserId: interaction.user.id,
        actorLabel,
        targetDiscordUserId: rule.discord_user_id,
        targetLabel: playerDisplay(rule),
        entityType: 'regel',
        entityId: id,
        actionType: 'ausgesetzt',
        details: `${from}${until ? ` bis ${until}` : ' bis auf Weiteres'}`
      });
      return interaction.reply({ content: `Regel **#${id}** wurde ausgesetzt.`, ephemeral: true });
    }
  }
};

module.exports = command;
