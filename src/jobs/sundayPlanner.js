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

function playerDisplay(row) {
  return row.alias || row.global_name || row.username || row.discord_user_id;
}

async function runSundayPlanner(client, options = {}) {
  const { force = false } = options;
  const runKey = getRunKey();

  if (!force) {
    const acquired = tryAcquireJobRun('sunday_planner', runKey);
    if (!acquired) {
      console.log(`[Planner] Bereits ausgeführt für ${runKey}`);
      return { skipped: true, reason: 'already_ran_today' };
    }
  } else {
    console.log(`[Planner] Force-Run aktiv für ${runKey}`);
  }

  const upcomingEntries = db.prepare(`
    SELECT
      e.id,
      e.entry_type,
      e.start_at,
      e.end_at,
      e.reason,
      p.discord_user_id,
      p.username,
      p.global_name,
      p.alias
    FROM availability_entries e
    INNER JOIN players p ON p.id = e.player_id
    WHERE e.end_at >= datetime('now')
      AND e.start_at <= datetime('now', '+7 days')
    ORDER BY e.start_at ASC
  `).all();

  const rules = db.prepare(`
    SELECT
      r.id,
      r.weekday_mask,
      r.rule_type,
      r.time_value,
      r.note,
      p.discord_user_id,
      p.username,
      p.global_name,
      p.alias
    FROM availability_rules r
    INNER JOIN players p ON p.id = r.player_id
    WHERE r.active = 1
    ORDER BY p.id ASC, r.id ASC
  `).all();

  console.log(`[Planner] upcomingEntries=${upcomingEntries.length}, rules=${rules.length}`);
  console.log(`[Planner] ADMIN_CHANNEL_ID=${process.env.ADMIN_CHANNEL_ID}`);

  const lines = [];
  lines.push('📋 **Wochenplanung – Rohübersicht**');
  lines.push(`Erstellt am: **${new Date().toLocaleString('de-DE', { timeZone: 'Europe/Berlin' })}**`);
  lines.push('');

  if (upcomingEntries.length === 0) {
    lines.push('**Fehlzeiten (nächste 7 Tage)**');
    lines.push('- Keine eingetragenen Abwesenheiten oder Urlaube.');
  } else {
    lines.push('**Fehlzeiten (nächste 7 Tage)**');
    for (const entry of upcomingEntries) {
      const typeLabel = entry.entry_type === 'vacation' ? 'Urlaub' : 'Abwesenheit';
      lines.push(
        `- ${playerDisplay(entry)} • [${typeLabel}] ${entry.start_at} → ${entry.end_at} • Grund: ${entry.reason ?? '-'}`
      );
    }
  }

  lines.push('');

  if (rules.length === 0) {
    lines.push('**Wiederkehrende Regeln**');
    lines.push('- Keine aktiven Regeln gespeichert.');
  } else {
    lines.push('**Wiederkehrende Regeln**');
    for (const rule of rules) {
      let detail = rule.rule_type;
      if (rule.rule_type === 'nicht_verfuegbar') {
        detail = 'nicht verfügbar';
      } else if (rule.rule_type === 'erst_ab') {
        detail = `erst ab ${rule.time_value}`;
      } else if (rule.rule_type === 'bis') {
        detail = `verfügbar bis ${rule.time_value}`;
      }

      lines.push(
        `- ${playerDisplay(rule)} • ${weekdayMaskToLabel(rule.weekday_mask)} • ${detail} • Notiz: ${rule.note ?? '-'}`
      );
    }
  }

  lines.push('');
  lines.push('➡️ Nächster Schritt: Termine im Adminkanal anlegen und vervollständigen.');

  try {
    const adminChannel = await client.channels.fetch(process.env.ADMIN_CHANNEL_ID);

    if (!adminChannel || !adminChannel.isTextBased()) {
      console.error('[Planner] Adminkanal nicht gefunden oder nicht textbasiert.');
      return { skipped: false, sent: false, reason: 'invalid_admin_channel' };
    }

    const chunks = [];
    let current = '';

    for (const line of lines) {
      const next = current ? `${current}\n${line}` : line;
      if (next.length > 1900) {
        chunks.push(current);
        current = line;
      } else {
        current = next;
      }
    }

    if (current) chunks.push(current);

    for (const chunk of chunks) {
      await adminChannel.send(chunk);
    }

    console.log('[Planner] Wochenübersicht in Adminkanal gesendet.');
    return { skipped: false, sent: true, chunks: chunks.length };
  } catch (error) {
    console.error('[Planner] Fehler beim Senden der Wochenübersicht.', error);
    throw error;
  }
}

module.exports = {
  runSundayPlanner
};