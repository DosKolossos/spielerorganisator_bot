const db = require('../db/database');

function getRunKey(date = new Date()) {
  return date.toISOString().slice(0, 10);
}

function tryAcquireJobRun(jobName, runKey) {
  const now = new Date().toISOString();
  const result = db.prepare(`
    INSERT OR IGNORE INTO job_runs (job_name, run_key, created_at)
    VALUES (?, ?, ?)
  `).run(jobName, `${jobName}:${runKey}`, now);

  return result.changes > 0;
}

async function runSundayReminder(client, options = {}) {
  const { force = false } = options;
  const runKey = getRunKey();

  if (!force) {
    const acquired = tryAcquireJobRun('sunday_reminder', runKey);
    if (!acquired) {
      console.log(`[Reminder] Bereits ausgeführt für ${runKey}`);
      return { skipped: true, reason: 'already_ran_today' };
    }
  } else {
    console.log(`[Reminder] Force-Run aktiv für ${runKey}`);
  }

  const players = db.prepare(`
    SELECT discord_user_id, username, global_name, alias
    FROM players
    WHERE is_archived = 0
    ORDER BY id ASC
  `).all();

  let sent = 0;
  let failed = 0;

  for (const player of players) {
    try {
      const user = await client.users.fetch(player.discord_user_id);
      await user.send(
        `⏰ **Erinnerung für heute**\n` +
        `Bitte pflege bis **19:59 Uhr** deine:\n` +
        `- Abwesenheiten\n` +
        `- wiederkehrenden Regeln\n\n` +
        `Der Wochenlauf startet um **20:00 Uhr**.`
      );
      sent++;
    } catch (error) {
      failed++;
      console.warn(`[Reminder] Konnte DM an ${player.alias || player.global_name || player.username || player.discord_user_id} nicht senden.`);
    }
  }

  try {
    const adminChannel = await client.channels.fetch(process.env.ADMIN_CHANNEL_ID);
    if (adminChannel && adminChannel.isTextBased()) {
      await adminChannel.send(
        `📨 **Sonntags-Erinnerung versendet**\n` +
        `Erfolgreich: **${sent}**\n` +
        `Fehlgeschlagen: **${failed}**`
      );
    }
  } catch (error) {
    console.error('[Reminder] Konnte keine Zusammenfassung in den Adminkanal senden.', error);
  }

  console.log(`[Reminder] Fertig. Erfolgreich: ${sent}, Fehlgeschlagen: ${failed}`);
  return { skipped: false, sent, failed };
}

module.exports = { runSundayReminder };
