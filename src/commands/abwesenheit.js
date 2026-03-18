const { SlashCommandBuilder } = require('discord.js');
const db = require('../db/database');
const { requireAdmin } = require('../utils/permissions');
const { logAdminAction, notifyUser } = require('../utils/adminTools');
const { upsertPlayer, getPlayerByDiscordUserId, playerDisplay } = require('../utils/playerUtils');
const {
  todayInBerlin,
  parseDateInput,
  isValidTime,
  formatEntryRange,
  extractDatePart,
  extractTimePart,
  isInCurrentWeek
} = require('../utils/time');

function buildDateTime(dateStr, timeStr, fallbackTime) {
  return `${dateStr} ${timeStr ?? fallbackTime}`;
}

function formatStatus(status) {
  switch (status) {
    case 'pending_admin':
      return 'Wartet auf Freigabe';
    case 'rejected':
      return 'Abgelehnt';
    default:
      return 'Genehmigt';
  }
}

function listText(rows, heading) {
  if (rows.length === 0) return `${heading}\nKeine Einträge gefunden.`;

  return `${heading}\n` + rows.map(row =>
    `**#${row.id}** • ${formatEntryRange(row.start_at, row.end_at)} • Status: **${formatStatus(row.approval_status)}** • Grund: ${row.reason ?? '-'}${row.review_note ? ` • Review: ${row.review_note}` : ''}`
  ).join('\n');
}

function resolveEntryPayload({ startdatumInput, enddatumInput, startzeitInput, endzeitInput, ganztag }, mode = 'self') {
  const today = todayInBerlin();
  const defaultStartDate = mode === 'self' ? new Date(Date.now() + 86400000).toISOString().slice(0, 10) : today;

  const parsedStartDate = startdatumInput ? parseDateInput(startdatumInput) : defaultStartDate;
  const parsedEndDate = enddatumInput ? parseDateInput(enddatumInput) : parsedStartDate;

  if (startdatumInput && !parsedStartDate) return { error: 'Startdatum ungültig. Nutze TT.MM.JJJJ oder YYYY-MM-DD.' };
  if (enddatumInput && !parsedEndDate) return { error: 'Enddatum ungültig. Nutze TT.MM.JJJJ oder YYYY-MM-DD.' };

  if (startzeitInput && !isValidTime(startzeitInput)) return { error: 'Startzeit ungültig. Bitte nutze HH:MM.' };
  if (endzeitInput && !isValidTime(endzeitInput)) return { error: 'Endzeit ungültig. Bitte nutze HH:MM.' };

  if (mode === 'self' && parsedStartDate <= today) {
    return { error: 'Für heute oder vergangene Tage kannst du keine eigene Abwesenheit mehr eintragen. Bitte melde dich bei einem Coach.' };
  }

  const startAt = ganztag
    ? `${parsedStartDate} 00:00`
    : buildDateTime(parsedStartDate, startzeitInput, '00:00');
  const endAt = ganztag
    ? `${parsedEndDate} 23:59`
    : buildDateTime(parsedEndDate, endzeitInput, '23:59');

  if (startAt > endAt) return { error: 'Der Start darf nicht nach dem Ende liegen.' };

  return {
    startAt,
    endAt,
    startDate: parsedStartDate,
    requiresApproval: mode === 'self' && isInCurrentWeek(parsedStartDate, today)
  };
}

function addSelfSubcommands(builder) {
  return builder
    .addSubcommand(sub =>
      sub
        .setName('hinzufuegen')
        .setDescription('Trägt eine neue Abwesenheit ein.')
        .addStringOption(option => option.setName('startdatum').setDescription('Optional: TT.MM.JJJJ oder YYYY-MM-DD. Standard: morgen').setRequired(false))
        .addStringOption(option => option.setName('enddatum').setDescription('Optional: TT.MM.JJJJ oder YYYY-MM-DD. Standard: Startdatum').setRequired(false))
        .addStringOption(option => option.setName('startzeit').setDescription('Optional: HH:MM').setRequired(false))
        .addStringOption(option => option.setName('endzeit').setDescription('Optional: HH:MM').setRequired(false))
        .addBooleanOption(option => option.setName('ganztag').setDescription('Ganztägig').setRequired(false))
        .addStringOption(option => option.setName('grund').setDescription('Optionaler Grund').setRequired(false))
    )
    .addSubcommand(sub => sub.setName('anzeigen').setDescription('Zeigt deine eingetragenen Abwesenheiten an.'))
    .addSubcommand(sub =>
      sub
        .setName('bearbeiten')
        .setDescription('Bearbeitet eine bestehende Abwesenheit anhand der ID.')
        .addIntegerOption(option => option.setName('id').setDescription('Die ID aus /abwesenheit anzeigen').setRequired(true))
        .addStringOption(option => option.setName('startdatum').setDescription('Optional: neues Startdatum').setRequired(false))
        .addStringOption(option => option.setName('enddatum').setDescription('Optional: neues Enddatum').setRequired(false))
        .addStringOption(option => option.setName('startzeit').setDescription('Optional: neue Startzeit').setRequired(false))
        .addStringOption(option => option.setName('endzeit').setDescription('Optional: neue Endzeit').setRequired(false))
        .addBooleanOption(option => option.setName('ganztag').setDescription('Ganztägig?').setRequired(false))
        .addStringOption(option => option.setName('grund').setDescription('Optional: neuer Grund, "-" löscht ihn').setRequired(false))
    )
    .addSubcommand(sub =>
      sub
        .setName('loeschen')
        .setDescription('Löscht eine Abwesenheit anhand der ID.')
        .addIntegerOption(option => option.setName('id').setDescription('Die ID aus /abwesenheit anzeigen').setRequired(true))
    );
}

function addAdminSubcommands(builder) {
  return builder
    .addSubcommand(sub =>
      sub
        .setName('admin-anzeigen')
        .setDescription('Zeigt Abwesenheiten eines Spielers oder alle offenen Fälle an.')
        .addUserOption(option => option.setName('spieler').setDescription('Optional: bestimmter Spieler').setRequired(false))
    )
    .addSubcommand(sub =>
      sub
        .setName('admin-hinzufuegen')
        .setDescription('Trägt eine Abwesenheit für einen Spieler ein.')
        .addUserOption(option => option.setName('spieler').setDescription('Betroffener Spieler').setRequired(true))
        .addStringOption(option => option.setName('startdatum').setDescription('Optional: TT.MM.JJJJ oder YYYY-MM-DD. Standard: heute').setRequired(false))
        .addStringOption(option => option.setName('enddatum').setDescription('Optional: TT.MM.JJJJ oder YYYY-MM-DD').setRequired(false))
        .addStringOption(option => option.setName('startzeit').setDescription('Optional: HH:MM').setRequired(false))
        .addStringOption(option => option.setName('endzeit').setDescription('Optional: HH:MM').setRequired(false))
        .addBooleanOption(option => option.setName('ganztag').setDescription('Ganztägig').setRequired(false))
        .addStringOption(option => option.setName('grund').setDescription('Optionaler Grund').setRequired(false))
    )
    .addSubcommand(sub =>
      sub
        .setName('admin-bearbeiten')
        .setDescription('Bearbeitet eine Abwesenheit anhand der ID.')
        .addIntegerOption(option => option.setName('id').setDescription('Abwesenheits-ID').setRequired(true))
        .addStringOption(option => option.setName('startdatum').setDescription('Optional: neues Startdatum').setRequired(false))
        .addStringOption(option => option.setName('enddatum').setDescription('Optional: neues Enddatum').setRequired(false))
        .addStringOption(option => option.setName('startzeit').setDescription('Optional: neue Startzeit').setRequired(false))
        .addStringOption(option => option.setName('endzeit').setDescription('Optional: neue Endzeit').setRequired(false))
        .addBooleanOption(option => option.setName('ganztag').setDescription('Ganztägig?').setRequired(false))
        .addStringOption(option => option.setName('grund').setDescription('Optional: neuer Grund, "-" löscht ihn').setRequired(false))
    )
    .addSubcommand(sub =>
      sub
        .setName('admin-loeschen')
        .setDescription('Löscht eine Abwesenheit anhand der ID.')
        .addIntegerOption(option => option.setName('id').setDescription('Abwesenheits-ID').setRequired(true))
    )
    .addSubcommand(sub =>
      sub
        .setName('admin-genehmigen')
        .setDescription('Genehmigt eine kurzfristige Abwesenheit.')
        .addIntegerOption(option => option.setName('id').setDescription('Abwesenheits-ID').setRequired(true))
        .addStringOption(option => option.setName('notiz').setDescription('Optionaler Hinweis').setRequired(false))
    )
    .addSubcommand(sub =>
      sub
        .setName('admin-ablehnen')
        .setDescription('Lehnt eine kurzfristige Abwesenheit ab.')
        .addIntegerOption(option => option.setName('id').setDescription('Abwesenheits-ID').setRequired(true))
        .addStringOption(option => option.setName('notiz').setDescription('Optionaler Hinweis').setRequired(false))
    );
}

const command = {
  data: addAdminSubcommands(addSelfSubcommands(
    new SlashCommandBuilder().setName('abwesenheit').setDescription('Verwalte Abwesenheiten.')
  )),

  async execute(interaction) {
    const subcommand = interaction.options.getSubcommand();
    const actorLabel = interaction.member?.displayName || interaction.user.username;
    const selfPlayer = upsertPlayer(interaction.user);

    if (subcommand === 'anzeigen') {
      const today = todayInBerlin();
      const rows = db.prepare(`
        SELECT id, start_at, end_at, reason, approval_status, review_note
        FROM availability_entries
        WHERE player_id = ?
          AND entry_type = 'absence'
          AND end_at >= ?
        ORDER BY start_at ASC
        LIMIT 25
      `).all(selfPlayer.id, `${today} 00:00`);

      return interaction.reply({ content: listText(rows, '**Deine Abwesenheiten**'), ephemeral: true });
    }

    if (subcommand === 'hinzufuegen') {
      const payload = resolveEntryPayload({
        startdatumInput: interaction.options.getString('startdatum')?.trim() ?? null,
        enddatumInput: interaction.options.getString('enddatum')?.trim() ?? null,
        startzeitInput: interaction.options.getString('startzeit')?.trim() ?? null,
        endzeitInput: interaction.options.getString('endzeit')?.trim() ?? null,
        ganztag: interaction.options.getBoolean('ganztag') ?? false
      }, 'self');

      if (payload.error) return interaction.reply({ content: payload.error, ephemeral: true });

      const reason = interaction.options.getString('grund')?.trim() ?? null;
      const now = new Date().toISOString();
      const status = payload.requiresApproval ? 'pending_admin' : 'approved';

      const result = db.prepare(`
        INSERT INTO availability_entries (
          player_id, entry_type, start_at, end_at, reason,
          approval_status, created_by_discord_user_id, updated_by_discord_user_id,
          created_at, updated_at
        )
        VALUES (?, 'absence', ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(selfPlayer.id, payload.startAt, payload.endAt, reason, status, interaction.user.id, interaction.user.id, now, now);

      if (status === 'pending_admin') {
        await logAdminAction(interaction.client, {
          actorDiscordUserId: interaction.user.id,
          actorLabel,
          targetDiscordUserId: interaction.user.id,
          targetLabel: playerDisplay(selfPlayer),
          entityType: 'abwesenheit',
          entityId: Number(result.lastInsertRowid),
          actionType: 'freigabe_erforderlich',
          details: `Kurzfristige Abwesenheit eingereicht: ${formatEntryRange(payload.startAt, payload.endAt)}`
        });
      }

      return interaction.reply({
        content:
          `Abwesenheit gespeichert.\n` +
          `ID: **${result.lastInsertRowid}**\n` +
          `Zeitraum: **${formatEntryRange(payload.startAt, payload.endAt)}**\n` +
          `Status: **${formatStatus(status)}**\n` +
          `Grund: **${reason ?? '-'}**` +
          (status === 'pending_admin' ? `\n\nDiese kurzfristige Abwesenheit muss noch von einem Coach bestätigt werden.` : ''),
        ephemeral: true
      });
    }

    if (subcommand === 'bearbeiten') {
      const id = interaction.options.getInteger('id', true);
      const existing = db.prepare(`
        SELECT *
        FROM availability_entries
        WHERE id = ? AND player_id = ? AND entry_type = 'absence'
      `).get(id, selfPlayer.id);

      if (!existing) {
        return interaction.reply({ content: 'Ich habe keine eigene Abwesenheit mit dieser ID gefunden.', ephemeral: true });
      }

      const payload = resolveEntryPayload({
        startdatumInput: interaction.options.getString('startdatum')?.trim() ?? extractDatePart(existing.start_at),
        enddatumInput: interaction.options.getString('enddatum')?.trim() ?? extractDatePart(existing.end_at),
        startzeitInput: interaction.options.getString('startzeit')?.trim() ?? extractTimePart(existing.start_at),
        endzeitInput: interaction.options.getString('endzeit')?.trim() ?? extractTimePart(existing.end_at),
        ganztag: interaction.options.getBoolean('ganztag') ?? (extractTimePart(existing.start_at) === '00:00' && extractTimePart(existing.end_at) === '23:59')
      }, 'self');

      if (payload.error) return interaction.reply({ content: payload.error, ephemeral: true });

      const reasonInput = interaction.options.getString('grund');
      const reason = reasonInput === null ? existing.reason : (reasonInput.trim() === '-' ? null : reasonInput.trim());
      const status = payload.requiresApproval ? 'pending_admin' : 'approved';

      db.prepare(`
        UPDATE availability_entries
        SET start_at = ?, end_at = ?, reason = ?, approval_status = ?,
            review_note = CASE WHEN ? = 'approved' THEN NULL ELSE review_note END,
            reviewed_by_discord_user_id = CASE WHEN ? = 'approved' THEN NULL ELSE reviewed_by_discord_user_id END,
            reviewed_at = CASE WHEN ? = 'approved' THEN NULL ELSE reviewed_at END,
            updated_by_discord_user_id = ?, updated_at = ?
        WHERE id = ? AND player_id = ?
      `).run(payload.startAt, payload.endAt, reason, status, status, status, status, interaction.user.id, new Date().toISOString(), id, selfPlayer.id);

      return interaction.reply({
        content:
          `Abwesenheit **#${id}** wurde aktualisiert.\n` +
          `Zeitraum: **${formatEntryRange(payload.startAt, payload.endAt)}**\n` +
          `Status: **${formatStatus(status)}**\n` +
          `Grund: **${reason ?? '-'}**`,
        ephemeral: true
      });
    }

    if (subcommand === 'loeschen') {
      const id = interaction.options.getInteger('id', true);
      const existing = db.prepare(`SELECT id FROM availability_entries WHERE id = ? AND player_id = ? AND entry_type = 'absence'`).get(id, selfPlayer.id);
      if (!existing) return interaction.reply({ content: 'Ich habe keine eigene Abwesenheit mit dieser ID gefunden.', ephemeral: true });

      db.prepare(`DELETE FROM availability_entries WHERE id = ? AND player_id = ?`).run(id, selfPlayer.id);
      return interaction.reply({ content: `Abwesenheit **#${id}** wurde gelöscht.`, ephemeral: true });
    }

    if (!(await requireAdmin(interaction))) return;

    if (subcommand === 'admin-anzeigen') {
      const targetUser = interaction.options.getUser('spieler');
      if (targetUser) {
        const targetPlayer = upsertPlayer(targetUser);
        const rows = db.prepare(`
          SELECT id, start_at, end_at, reason, approval_status, review_note
          FROM availability_entries
          WHERE player_id = ? AND entry_type = 'absence'
          ORDER BY start_at ASC
          LIMIT 25
        `).all(targetPlayer.id);

        return interaction.reply({
          content: listText(rows, `**Abwesenheiten von ${playerDisplay(targetPlayer)}**`),
          ephemeral: true
        });
      }

      const rows = db.prepare(`
        SELECT e.id, e.start_at, e.end_at, e.reason, e.approval_status, e.review_note,
               p.alias, p.global_name, p.username, p.discord_user_id
        FROM availability_entries e
        INNER JOIN players p ON p.id = e.player_id
        WHERE e.entry_type = 'absence'
          AND e.approval_status = 'pending_admin'
          AND p.is_archived = 0
        ORDER BY e.start_at ASC
        LIMIT 25
      `).all();

      const text = rows.length === 0
        ? '**Offene Abwesenheiten**\nKeine offenen Freigaben.'
        : '**Offene Abwesenheiten**\n' + rows.map(row =>
            `**#${row.id}** • ${playerDisplay(row)} • ${formatEntryRange(row.start_at, row.end_at)} • Grund: ${row.reason ?? '-'}`
          ).join('\n');

      return interaction.reply({ content: text, ephemeral: true });
    }

    if (subcommand === 'admin-hinzufuegen') {
      const targetUser = interaction.options.getUser('spieler', true);
      const targetPlayer = upsertPlayer(targetUser);
      const payload = resolveEntryPayload({
        startdatumInput: interaction.options.getString('startdatum')?.trim() ?? null,
        enddatumInput: interaction.options.getString('enddatum')?.trim() ?? null,
        startzeitInput: interaction.options.getString('startzeit')?.trim() ?? null,
        endzeitInput: interaction.options.getString('endzeit')?.trim() ?? null,
        ganztag: interaction.options.getBoolean('ganztag') ?? false
      }, 'admin');
      if (payload.error) return interaction.reply({ content: payload.error, ephemeral: true });

      const reason = interaction.options.getString('grund')?.trim() ?? null;
      const now = new Date().toISOString();
      const result = db.prepare(`
        INSERT INTO availability_entries (
          player_id, entry_type, start_at, end_at, reason,
          approval_status, reviewed_by_discord_user_id, reviewed_at,
          created_by_discord_user_id, updated_by_discord_user_id, created_at, updated_at
        ) VALUES (?, 'absence', ?, ?, ?, 'approved', ?, ?, ?, ?, ?, ?)
      `).run(targetPlayer.id, payload.startAt, payload.endAt, reason, interaction.user.id, now, interaction.user.id, interaction.user.id, now, now);

      await notifyUser(interaction.client, targetUser.id,
        `📅 Für dich wurde von **${actorLabel}** eine Abwesenheit eingetragen.\nZeitraum: **${formatEntryRange(payload.startAt, payload.endAt)}**\nGrund: **${reason ?? '-'}**`
      );
      await logAdminAction(interaction.client, {
        actorDiscordUserId: interaction.user.id,
        actorLabel,
        targetDiscordUserId: targetUser.id,
        targetLabel: playerDisplay(targetPlayer),
        entityType: 'abwesenheit',
        entityId: Number(result.lastInsertRowid),
        actionType: 'erstellt',
        details: formatEntryRange(payload.startAt, payload.endAt)
      });

      return interaction.reply({
        content: `Abwesenheit für **${playerDisplay(targetPlayer)}** gespeichert.\nID: **${result.lastInsertRowid}**`,
        ephemeral: true
      });
    }

    const id = interaction.options.getInteger('id', true);
    const entry = db.prepare(`
      SELECT e.*, p.discord_user_id, p.alias, p.global_name, p.username
      FROM availability_entries e
      INNER JOIN players p ON p.id = e.player_id
      WHERE e.id = ? AND e.entry_type = 'absence'
    `).get(id);

    if (!entry) return interaction.reply({ content: 'Keine Abwesenheit mit dieser ID gefunden.', ephemeral: true });

    if (subcommand === 'admin-bearbeiten') {
      const payload = resolveEntryPayload({
        startdatumInput: interaction.options.getString('startdatum')?.trim() ?? extractDatePart(entry.start_at),
        enddatumInput: interaction.options.getString('enddatum')?.trim() ?? extractDatePart(entry.end_at),
        startzeitInput: interaction.options.getString('startzeit')?.trim() ?? extractTimePart(entry.start_at),
        endzeitInput: interaction.options.getString('endzeit')?.trim() ?? extractTimePart(entry.end_at),
        ganztag: interaction.options.getBoolean('ganztag') ?? (extractTimePart(entry.start_at) === '00:00' && extractTimePart(entry.end_at) === '23:59')
      }, 'admin');
      if (payload.error) return interaction.reply({ content: payload.error, ephemeral: true });

      const reasonInput = interaction.options.getString('grund');
      const reason = reasonInput === null ? entry.reason : (reasonInput.trim() === '-' ? null : reasonInput.trim());

      db.prepare(`
        UPDATE availability_entries
        SET start_at = ?, end_at = ?, reason = ?, approval_status = 'approved',
            reviewed_by_discord_user_id = ?, reviewed_at = ?, review_note = NULL,
            updated_by_discord_user_id = ?, updated_at = ?
        WHERE id = ?
      `).run(payload.startAt, payload.endAt, reason, interaction.user.id, new Date().toISOString(), interaction.user.id, new Date().toISOString(), id);

      await notifyUser(interaction.client, entry.discord_user_id,
        `🛠️ Deine Abwesenheit **#${id}** wurde von **${actorLabel}** angepasst.\nZeitraum: **${formatEntryRange(payload.startAt, payload.endAt)}**\nGrund: **${reason ?? '-'}**`
      );
      await logAdminAction(interaction.client, {
        actorDiscordUserId: interaction.user.id,
        actorLabel,
        targetDiscordUserId: entry.discord_user_id,
        targetLabel: playerDisplay(entry),
        entityType: 'abwesenheit',
        entityId: id,
        actionType: 'bearbeitet',
        details: formatEntryRange(payload.startAt, payload.endAt)
      });

      return interaction.reply({ content: `Abwesenheit **#${id}** wurde aktualisiert.`, ephemeral: true });
    }

    if (subcommand === 'admin-loeschen') {
      db.prepare(`DELETE FROM availability_entries WHERE id = ?`).run(id);
      await notifyUser(interaction.client, entry.discord_user_id,
        `🗑️ Deine Abwesenheit **#${id}** wurde von **${actorLabel}** gelöscht.`
      );
      await logAdminAction(interaction.client, {
        actorDiscordUserId: interaction.user.id,
        actorLabel,
        targetDiscordUserId: entry.discord_user_id,
        targetLabel: playerDisplay(entry),
        entityType: 'abwesenheit',
        entityId: id,
        actionType: 'gelöscht',
        details: formatEntryRange(entry.start_at, entry.end_at)
      });

      return interaction.reply({ content: `Abwesenheit **#${id}** wurde gelöscht.`, ephemeral: true });
    }

    if (subcommand === 'admin-genehmigen' || subcommand === 'admin-ablehnen') {
      const approved = subcommand === 'admin-genehmigen';
      const reviewNote = interaction.options.getString('notiz')?.trim() ?? null;
      db.prepare(`
        UPDATE availability_entries
        SET approval_status = ?, reviewed_by_discord_user_id = ?, reviewed_at = ?, review_note = ?,
            updated_by_discord_user_id = ?, updated_at = ?
        WHERE id = ?
      `).run(approved ? 'approved' : 'rejected', interaction.user.id, new Date().toISOString(), reviewNote, interaction.user.id, new Date().toISOString(), id);

      await notifyUser(interaction.client, entry.discord_user_id,
        `${approved ? '✅' : '❌'} Deine Abwesenheit **#${id}** wurde von **${actorLabel}** ${approved ? 'genehmigt' : 'abgelehnt'}.` +
        `${reviewNote ? `\nHinweis: **${reviewNote}**` : ''}`
      );
      await logAdminAction(interaction.client, {
        actorDiscordUserId: interaction.user.id,
        actorLabel,
        targetDiscordUserId: entry.discord_user_id,
        targetLabel: playerDisplay(entry),
        entityType: 'abwesenheit',
        entityId: id,
        actionType: approved ? 'genehmigt' : 'abgelehnt',
        details: reviewNote ?? formatEntryRange(entry.start_at, entry.end_at)
      });

      return interaction.reply({
        content: `Abwesenheit **#${id}** wurde ${approved ? 'genehmigt' : 'abgelehnt'}.`,
        ephemeral: true
      });
    }
  }
};

module.exports = command;
