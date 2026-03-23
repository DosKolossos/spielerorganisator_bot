const db = require('../db/database');
const { publishWeeklyAvailabilityPrompt } = require('../services/weeklyAvailabilityService');

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

  const result = await publishWeeklyAvailabilityPrompt(client);

  try {
    const adminChannel = await client.channels.fetch(process.env.ADMIN_CHANNEL_ID);
    if (adminChannel && adminChannel.isTextBased()) {
      await adminChannel.send(
        `📨 **Wochen-Check-in aktualisiert**\n` +
        `Gesendet: **${result.sent ? 'ja' : 'nein'}**\n` +
        `Modus: **${result.mode ?? '-'}**\n` +
        `Woche ab: **${result.weekStartDate ?? '-'}**\n` +
        `Grund: **${result.reason ?? '-'}**`
      );
    }
  } catch (error) {
    console.error('[Reminder] Konnte keine Zusammenfassung in den Adminkanal senden.', error);
  }

  return result;
}

module.exports = { runSundayReminder };
