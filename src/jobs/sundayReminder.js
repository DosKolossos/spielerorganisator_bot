
const { postOrRefreshWeeklyAvailabilityCards } = require('../services/weeklyAvailabilityService');
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

  const result = await postOrRefreshWeeklyAvailabilityCards(client);

  try {
    const adminChannel = await client.channels.fetch(process.env.ADMIN_CHANNEL_ID);
    if (adminChannel && adminChannel.isTextBased()) {
      await adminChannel.send(
        `📨 **Wochenkarten aktualisiert**\n` +
        `Woche ab: **${result.weekStartDate ?? '-'}**\n` +
        `Erstellt: **${result.created ?? 0}**\n` +
        `Aktualisiert: **${result.updated ?? 0}**\n` +
        `Fehlgeschlagen: **${result.failed ?? 0}**`
      );
    }
  } catch (error) {
    console.error('[Reminder] Konnte keine Zusammenfassung in den Adminkanal senden.', error);
  }

  console.log('[Reminder] Wochenkarten-Verteilung abgeschlossen.');
  return result;
}

module.exports = { runSundayReminder };
