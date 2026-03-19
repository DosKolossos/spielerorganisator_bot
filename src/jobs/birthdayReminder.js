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

function todayInBerlinParts() {
  const parts = new Intl.DateTimeFormat('de-DE', {
    timeZone: 'Europe/Berlin',
    day: '2-digit',
    month: '2-digit'
  }).formatToParts(new Date());

  const day = Number(parts.find(p => p.type === 'day')?.value);
  const month = Number(parts.find(p => p.type === 'month')?.value);

  return { day, month };
}

async function runBirthdayReminder(client, options = {}) {
  const { force = false } = options;
  const runKey = getRunKey();

  if (!force) {
    const acquired = tryAcquireJobRun('birthday_reminder', runKey);
    if (!acquired) {
      console.log(`[BirthdayReminder] Bereits ausgeführt für ${runKey}`);
      return { skipped: true, reason: 'already_ran_today' };
    }
  } else {
    console.log(`[BirthdayReminder] Force-Run aktiv für ${runKey}`);
  }

  const reminderUserId = process.env.BIRTHDAY_REMINDER_USER_ID;
  if (!reminderUserId) {
    console.warn('[BirthdayReminder] BIRTHDAY_REMINDER_USER_ID fehlt.');
    return { skipped: true, reason: 'missing_target_user' };
  }

  const { day, month } = todayInBerlinParts();

  const birthdaysToday = db.prepare(`
    SELECT *
    FROM birthdays
    WHERE birthday_month = ?
      AND birthday_day = ?
    ORDER BY lower(name) ASC
  `).all(month, day);

  if (birthdaysToday.length === 0) {
    console.log('[BirthdayReminder] Heute keine Geburtstage.');
    return { skipped: false, sent: false, count: 0 };
  }

  const user = await client.users.fetch(reminderUserId);

  const lines = birthdaysToday.map(row =>
    `- **${row.name}**${row.note ? ` — ${row.note}` : ''}`
  );

  await user.send(
    `🎂 **Geburtstags-Reminder**\n` +
    `Heute haben Geburtstag:\n` +
    `${lines.join('\n')}`
  );

  console.log(`[BirthdayReminder] ${birthdaysToday.length} Geburtstag(e) an ${reminderUserId} gesendet.`);
  return { skipped: false, sent: true, count: birthdaysToday.length };
}

module.exports = { runBirthdayReminder };