const db = require('../db/database');

function focusSlug(team) {
  const value = `${team?.slug || ''} ${team?.name || ''} ${team?.short_name || ''}`.toLowerCase();
  return value.includes('shiny') ? 'shiny' : 'main';
}

function eventSchedule(event) {
  return event.scheduled_start_at
    || event.start_at
    || event.window_start_at
    || (event.option_date ? `${event.option_date}T12:00:00+02:00` : null);
}

async function sendToArchive(event) {
  if (!process.env.ARCHIVE_API_URL || !process.env.ARCHIVE_BRIDGE_TOKEN) return { skipped: true };
  const team = db.prepare('SELECT * FROM teams WHERE id = ?').get(event.team_id);
  const response = await fetch(`${process.env.ARCHIVE_API_URL.replace(/\/$/, '')}/api/integration/upcoming`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${process.env.ARCHIVE_BRIDGE_TOKEN}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      focusTeamSlug: focusSlug(team),
      organizerEventId: String(event.id),
      opponentName: event.opponent_name,
      opggUrl: event.opgg_url,
      scheduledAt: eventSchedule(event),
      eventStatus: event.status
    })
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok && response.status !== 202) throw new Error(data.error || `Archiv antwortet mit ${response.status}`);
  return data;
}

async function syncUpcomingOpponents() {
  if (!process.env.ARCHIVE_API_URL || !process.env.ARCHIVE_BRIDGE_TOKEN) return { configured: false, checked: 0 };
  const events = db.prepare(`
    SELECT id, team_id, opponent_name, opgg_url, status,
           option_date, window_start_at, scheduled_start_at, start_at
    FROM team_calendar_events
    WHERE trim(COALESCE(opponent_name, '')) <> ''
      AND trim(COALESCE(opgg_url, '')) <> ''
      AND status NOT IN ('cancelled', 'deleted')
      AND COALESCE(option_date, substr(window_start_at, 1, 10), substr(scheduled_start_at, 1, 10), date('now')) >= date('now', '-1 day')
    ORDER BY id DESC
    LIMIT 50
  `).all();
  const summary = { configured: true, checked: events.length, ready: 0, pending: 0, errors: 0 };
  for (const event of events) {
    try {
      const result = await sendToArchive(event);
      result.status === 'needs_team_resolution' ? summary.pending++ : summary.ready++;
    } catch (error) {
      summary.errors++;
      console.error(`[Gegner-Archiv] Event ${event.id} konnte nicht synchronisiert werden:`, error.message);
    }
  }
  return summary;
}

module.exports = { syncUpcomingOpponents };
