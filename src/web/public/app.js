const $ = selector => document.querySelector(selector);
const calendar = $('#calendar');
const planner = $('#planner');
const login = $('#login');
const eventDialog = $('#event-dialog');
const exportDialog = $('#export-dialog');
const roles = ['Top', 'Jgl', 'Mid', 'ADC', 'Supp'];
let snapshot;
let liveStream;
let selectedWeek;

const typeLabels = { open: 'Offen', scrim: 'Scrim', primeleague: 'PRM', training: 'Training', flex: 'Flex', other: 'Sonstiges' };
const stateLabels = { open: 'Offen', preplanned: 'Vorgeplant', published: 'Veröffentlicht', excluded: 'Nicht exportieren' };
const dateLabel = value => new Intl.DateTimeFormat('de-DE', { weekday: 'short', day: '2-digit', month: '2-digit', timeZone: 'UTC' }).format(new Date(`${value}T12:00:00Z`));
const timeLabel = value => value ? `${String(value).slice(11, 16)} Uhr` : 'offen';

function eventTitle(event) {
  if (event.opponent) return `vs. ${event.opponent}`;
  if (!event.title || /^Terminoption\s*[–-]/i.test(event.title)) return typeLabels[event.type] || 'Termin';
  return event.title;
}

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

function toast(message, error = false) {
  const root = $('#toast');
  root.textContent = message;
  root.className = error ? 'show error' : 'show';
  setTimeout(() => { root.className = ''; }, 3500);
}

async function api(path, options = {}) {
  const response = await fetch(path, { cache: 'no-store', headers: { 'Content-Type': 'application/json', ...(options.headers || {}) }, ...options });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
  return data;
}

function eventCard(event) {
  const card = element('button', `event-card state-${event.plannerState}`);
  card.type = 'button';
  card.dataset.eventId = event.id;
  const top = element('span', 'event-top');
  top.append(element('strong', '', eventTitle(event)), element('span', 'state-pill', stateLabels[event.plannerState]));
  card.append(top, element('span', 'event-detail', `${timeLabel(event.startsAt)} · ${typeLabels[event.type] || event.type}`));
  if (event.result) card.append(element('span', 'result', `Ergebnis ${event.result}`));
  if (event.lineup.length) card.append(element('span', 'mini-lineup', event.lineup.map(slot => slot.player).join(' · ')));
  if (event.drafterStale) card.append(element('span', 'warning-copy', '⚠ Drafter-Link nach Gegneränderung ersetzen'));
  const openPositions = roles.filter(role => !event.opponentLineup.some(item => item.role === role && item.player));
  if (event.opponentLineup.length && openPositions.length) card.append(element('span', 'warning-copy', `⚠ ${openPositions.length} Gegnerpositionen offen`));
  return card;
}

function availabilityCell(day) {
  const cell = element('span', `availability ${day.state}`);
  cell.title = day.eitherOr ? `${day.label} · Entweder/oder mit ${dateLabel(day.eitherOr.firstDate === day.date ? day.eitherOr.secondDate : day.eitherOr.firstDate)}` : day.label;
  cell.append(element('span', 'availability-symbol', `${day.state === 'available' ? '●' : day.state === 'partial' ? '◐' : '–'}${day.eitherOr ? ' ↔' : ''}`));
  if (day.state === 'partial' && day.restriction) cell.append(element('small', 'availability-restriction', day.restriction));
  return cell;
}

function eventEntry(event) {
  const wrapper = element('div', 'event-entry');
  const lineup = element('button', 'lineup-quick', 'Aufstellung');
  lineup.type = 'button'; lineup.dataset.lineupEventId = event.id;
  wrapper.append(eventCard(event), lineup);
  return wrapper;
}

function renderTeam(team, dates) {
  const section = element('section', 'team-section');
  const heading = element('div', 'team-row team-heading-row');
  const title = element('div', 'row-label');
  title.append(element('span', 'team-kicker', 'TEAM'), element('h2', '', team.name));
  heading.append(title);
  for (const date of dates) {
    const day = element('div', `day-heading ${team.fullLineup[date] ? 'full-lineup' : ''}`);
    day.append(element('strong', '', dateLabel(date)), element('small', '', team.fullLineup[date] ? '✓ alle 5 verfügbar' : 'Verfügbarkeit prüfen'));
    heading.append(day);
  }
  section.append(heading);

  const eventsRow = element('div', 'team-row events-row');
  eventsRow.append(element('div', 'row-label muted', 'Termine'));
  for (const date of dates) {
    const day = element('div', 'day-cell');
    const items = team.events.filter(event => event.date === date && event.type !== 'open' && event.plannerState !== 'open');
    if (!items.length) day.append(element('span', 'empty-day', '—'));
    else items.forEach(event => day.append(eventEntry(event)));
    eventsRow.append(day);
  }
  section.append(eventsRow);

  const details = element('details', 'roster');
  details.open = localStorage.getItem(`roster-open-${team.id}`) === '1';
  const summary = element('summary', '', `Spieler & Subs (${team.roster.length})`);
  details.append(summary);
  details.addEventListener('toggle', () => localStorage.setItem(`roster-open-${team.id}`, details.open ? '1' : '0'));
  for (const player of team.roster) {
    if (localStorage.getItem(`player-hidden-${player.id}`) === '1') continue;
    const row = element('div', 'team-row player-row');
    const label = element('div', 'row-label player-label');
    label.append(element('strong', '', player.name), element('small', '', player.rosterStatus === 'main' ? 'Main-Line-up' : 'Sub'));
    const hide = element('button', 'hide-player', 'Ausblenden');
    hide.type = 'button';
    hide.addEventListener('click', () => { localStorage.setItem(`player-hidden-${player.id}`, '1'); render(snapshot); });
    label.append(hide);
    row.append(label);
    dates.forEach(date => row.append(availabilityCell(player.days[date])));
    details.append(row);
  }
  const reset = element('button', 'button ghost reset-hidden', 'Ausgeblendete Spieler wieder anzeigen');
  reset.type = 'button';
  reset.addEventListener('click', () => { team.roster.forEach(player => localStorage.removeItem(`player-hidden-${player.id}`)); render(snapshot); });
  details.append(reset);
  section.append(details);
  return section;
}

function renderTasks(tasks) {
  const root = $('#tasks'); root.replaceChildren();
  const openTasks = tasks.filter(task => task.level !== 'complete');
  const badge = $('#task-count'); badge.textContent = String(openTasks.length); badge.hidden = openTasks.length === 0;
  if (!openTasks.length) return root.append(element('p', 'empty-copy success-copy', '✓ Alle Aufgaben erledigt.'));
  openTasks.forEach(task => {
    const button = element('button', `task task-${task.level}`, `${task.level === 'complete' ? '✓' : task.level === 'external' ? '↗' : '!' } ${task.label} · ${dateLabel(task.date)}`);
    button.type = 'button'; button.dataset.eventId = task.eventId; root.append(button);
  });
}

function renderChanges(changes) {
  const root = $('#changes'); root.replaceChildren();
  const open = changes.filter(change => !change.acknowledgedAt);
  const badge = $('#change-count'); badge.textContent = String(open.length); badge.hidden = open.length === 0;
  if (!open.length) return root.append(element('p', 'empty-copy', 'Keine neuen Änderungen.'));
  open.slice(0, 6).forEach(change => root.append(element('div', 'change', change.summary)));
}

function renderMatchday() {
  const root = $('#matchday-items'); root.replaceChildren();
  const today = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Berlin' }).format(new Date());
  const tomorrow = new Date(`${today}T12:00:00Z`); tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
  const dates = new Set([today, tomorrow.toISOString().slice(0, 10)]);
  const scheduledStatuses = new Set(['planned', 'confirmed', 'scheduled', 'fixed', 'completed']);
  const events = snapshot.teams
    .flatMap(team => team.events.map(event => ({ ...event, team: team.shortName || team.name })))
    .filter(event => dates.has(event.date))
    .filter(event => event.type !== 'open' && !['open', 'excluded'].includes(event.plannerState))
    .filter(event => scheduledStatuses.has(event.status) || ['preplanned', 'published'].includes(event.plannerState));
  if (!events.length) return root.append(element('p', 'empty-copy', 'Heute und morgen ist nichts angesetzt.'));
  events.forEach(event => { const item = eventCard(event); item.prepend(element('span', 'team-tag', event.team)); root.append(item); });
}

function render(data) {
  snapshot = data; selectedWeek = data.week.start; $('#week-picker').value = selectedWeek;
  $('#week-label').textContent = `${dateLabel(data.week.start)} – ${dateLabel(data.week.end)}`;
  calendar.replaceChildren();
  const scroll = element('div', 'calendar-scroll');
  data.teams.forEach(team => scroll.append(renderTeam(team, data.week.dates)));
  calendar.append(scroll);
  renderTasks(data.tasks); renderChanges(data.changes); renderMatchday();
  const conflicts = $('#conflicts'); conflicts.replaceChildren(); conflicts.hidden = !data.conflicts.length;
  data.conflicts.forEach(item => conflicts.append(element('p', '', `⚠ ${item.label}`)));
  $('#live-dot').classList.add('online'); $('#live-label').textContent = data.botOnline ? 'Live mit Discord verbunden' : 'Planerdaten verbunden';
  $('#last-update').textContent = `Aktualisiert ${new Intl.DateTimeFormat('de-DE', { hour: '2-digit', minute: '2-digit' }).format(new Date(data.generatedAt))}`;
}

function findEvent(id) { return snapshot.teams.flatMap(team => team.events).find(event => event.id === Number(id)); }
function findEventTeam(id) { return snapshot.teams.find(team => team.events.some(event => event.id === Number(id))); }

function openEvent(id, options = {}) {
  const event = findEvent(id); if (!event) return;
  if (event.type === 'open' || event.plannerState === 'open') return toast('Offene Terminoptionen werden erst in Discord zu einem echten Termin gemacht.', true);
  const team = findEventTeam(id);
  $('#event-id').value = event.id; $('#event-dialog-title').textContent = `${dateLabel(event.date)} · ${eventTitle(event)}`;
  $('#event-title').value = event.title || ''; $('#event-opponent').value = event.opponent || ''; $('#event-type').value = event.type || 'open';
  $('#event-status').value = [...$('#event-status').options].some(option => option.value === event.status) ? event.status : 'pending';
  $('#event-planner-state').value = event.plannerState; $('#event-format').value = event.matchFormat; $('#event-fearless').value = event.fearless ? '1' : '0';
  $('#event-opgg').value = event.opggUrl || ''; $('#event-drafter').value = event.drafterUrl || ''; $('#event-result').value = event.result || ''; $('#event-note').value = event.note || '';
  $('#drafter-hint').textContent = event.type === 'primeleague' ? 'Bei PRM bleibt der Drafter extern und wird hier nicht benötigt.' : (event.drafterStale ? 'Der Gegner wurde geändert. Bitte einen neuen Drafter erstellen und den Link ersetzen.' : 'Drafter.lol öffnen, erstellen und den Link hier einfügen.');
  $('#open-drafter').hidden = event.type === 'primeleague';
  $('#standin-display-name').value = ''; $('#standin-game-name').value = ''; $('#standin-tag').value = ''; $('#standin-position').value = '';
  const ownLineup = $('#own-lineup'); ownLineup.replaceChildren();
  roles.forEach(role => {
    const label = element('label', '', role);
    const select = document.createElement('select'); select.dataset.role = role;
    select.append(new Option('Nicht besetzt', ''));
    for (const player of team?.roster || []) {
      select.append(new Option(`${player.name} (${player.rosterStatus === 'main' ? 'Main' : 'Sub'})`, `player:${player.id}`));
    }
    for (const standin of team?.standins || []) {
      select.append(new Option(`${standin.name} (Stand-in)`, `standin:${standin.id}`));
    }
    const assigned = event.lineup.find(item => item.role === role);
    if (assigned?.playerId && [...select.options].some(option => option.value === `player:${assigned.playerId}`)) {
      select.value = `player:${assigned.playerId}`;
    } else if (assigned?.standinId && [...select.options].some(option => option.value === `standin:${assigned.standinId}`)) {
      select.value = `standin:${assigned.standinId}`;
    } else if (assigned) {
      select.append(new Option(`${assigned.player} (${assigned.type === 'standin' ? 'Stand-in' : 'bestehend'})`, 'preserve', true, true));
    }
    label.append(select); ownLineup.append(label);
  });
  const lineup = $('#opponent-lineup'); lineup.replaceChildren();
  roles.forEach(role => { const label = element('label', '', role); const input = document.createElement('input'); input.dataset.role = role; input.value = event.opponentLineup.find(item => item.role === role)?.player || ''; label.append(input); lineup.append(label); });
  $('#new-standin').open = false; $('#form-message').textContent = ''; eventDialog.showModal();
  if (options.focusLineup) requestAnimationFrame(() => $('#own-lineup-fieldset').scrollIntoView({ behavior: 'smooth', block: 'start' }));
}

async function loadWeek(week) {
  if (liveStream) liveStream.close();
  const data = await api(`/api/planner?week=${encodeURIComponent(week || '')}`); render(data);
  liveStream = new EventSource(`/api/live?week=${encodeURIComponent(data.week.start)}`);
  liveStream.addEventListener('planner', message => render(JSON.parse(message.data)));
  liveStream.onerror = () => { $('#live-dot').classList.remove('online'); $('#live-label').textContent = 'Live-Verbindung wird erneuert'; };
}

calendar.addEventListener('click', event => {
  const lineup = event.target.closest('[data-lineup-event-id]');
  if (lineup) return openEvent(lineup.dataset.lineupEventId, { focusLineup: true });
  const card = event.target.closest('[data-event-id]'); if (card) openEvent(card.dataset.eventId);
});
$('#tasks').addEventListener('click', event => { const item = event.target.closest('[data-event-id]'); if (item) { $('#tasks-notification').open = false; openEvent(item.dataset.eventId); } });
$('#matchday-items').addEventListener('click', event => { const card = event.target.closest('[data-event-id]'); if (card) openEvent(card.dataset.eventId); });
document.querySelectorAll('[data-close]').forEach(button => button.addEventListener('click', () => eventDialog.close()));
document.querySelectorAll('[data-export-close]').forEach(button => button.addEventListener('click', () => exportDialog.close()));
document.querySelectorAll('.notification-menu').forEach(menu => menu.addEventListener('toggle', () => {
  if (!menu.open) return;
  document.querySelectorAll('.notification-menu').forEach(other => { if (other !== menu) other.open = false; });
}));

$('#event-type').addEventListener('change', () => { const prm = $('#event-type').value === 'primeleague'; $('#open-drafter').hidden = prm; $('#drafter-hint').textContent = prm ? 'Bei PRM wird kein Drafter hinterlegt.' : 'Drafter.lol öffnen, erstellen und den Link hier einfügen.'; });
$('#copy-drafter').addEventListener('click', async () => { if (!$('#event-drafter').value) return toast('Noch kein Drafter-Link vorhanden.', true); await navigator.clipboard.writeText($('#event-drafter').value); toast('Drafter-Link kopiert.'); });
$('#create-standin').addEventListener('click', async () => {
  const eventId = $('#event-id').value;
  const team = findEventTeam(eventId);
  const body = {
    teamId: team?.id,
    displayName: $('#standin-display-name').value,
    riotGameName: $('#standin-game-name').value,
    riotTag: $('#standin-tag').value,
    riotRegion: 'euw',
    preferredPosition: $('#standin-position').value
  };
  try {
    const result = await api('/api/standins', { method: 'POST', body: JSON.stringify(body) });
    for (const select of $('#own-lineup').querySelectorAll('select')) {
      select.append(new Option(`${result.standin.name} (Stand-in)`, `standin:${result.standin.id}`));
      if (result.standin.preferredPosition === select.dataset.role) select.value = `standin:${result.standin.id}`;
    }
    $('#standin-display-name').value = ''; $('#standin-game-name').value = ''; $('#standin-tag').value = ''; $('#standin-position').value = '';
    $('#new-standin').open = false;
    if (team) team.standins.push(result.standin);
    toast('Sub/Stand-in angelegt und zur Auswahl hinzugefügt.');
  } catch (error) {
    $('#form-message').textContent = error.message === 'standin_already_exists'
      ? 'Diese Riot-ID ist bereits als Stand-in gespeichert.'
      : error.message === 'invalid_standin' ? 'Bitte Anzeigename, Riot Game Name und Riot-Tag vollständig eingeben.' : error.message;
  }
});
$('#event-form').addEventListener('submit', async event => {
  event.preventDefault();
  const lineup = [...$('#own-lineup').querySelectorAll('select')].map(select => ({
    role: select.dataset.role,
    preserve: select.value === 'preserve',
    playerId: select.value.startsWith('player:') ? Number(select.value.slice(7)) : null,
    standinId: select.value.startsWith('standin:') ? Number(select.value.slice(8)) : null
  }));
  const selectedCandidates = lineup.map(item => item.playerId ? `player:${item.playerId}` : item.standinId ? `standin:${item.standinId}` : null).filter(Boolean);
  if (new Set(selectedCandidates).size !== selectedCandidates.length) {
    $('#form-message').textContent = 'Ein Spieler kann nicht auf mehreren Positionen gleichzeitig stehen.';
    return;
  }
  const opponentLineup = [...$('#opponent-lineup').querySelectorAll('input')].map(input => ({ role: input.dataset.role, player: input.value.trim() })).filter(item => item.player);
  const body = { title: $('#event-title').value, opponent: $('#event-opponent').value, type: $('#event-type').value, status: $('#event-status').value, plannerState: $('#event-planner-state').value, matchFormat: $('#event-format').value, fearless: $('#event-fearless').value === '1', opggUrl: $('#event-opgg').value, drafterUrl: $('#event-drafter').value, lineup, opponentLineup, result: $('#event-result').value, note: $('#event-note').value };
  try { await api(`/api/events/${$('#event-id').value}`, { method: 'PATCH', body: JSON.stringify(body) }); eventDialog.close(); toast('Termin gespeichert und mit Discord abgeglichen.'); await loadWeek(selectedWeek); } catch (error) { $('#form-message').textContent = error.message; }
});

$('#export').addEventListener('click', async () => {
  try {
    const preview = await api(`/api/export/preview?week=${selectedWeek}`); const root = $('#export-preview'); root.replaceChildren();
    [['Neu veröffentlichen', preview.publish], ['Aktualisieren', preview.update], ['Aus Schedule entfernen', preview.remove]].forEach(([label, items]) => { const section = element('section', 'preview-group'); section.append(element('h3', '', `${label} (${items.length})`)); section.append(element('p', 'empty-copy', items.length ? items.map(item => `${dateLabel(item.option_date)} ${item.title}`).join(' · ') : 'Keine')); root.append(section); });
    $('#confirm-export').disabled = !preview.total; exportDialog.showModal();
  } catch (error) { toast(error.message, true); }
});
$('#confirm-export').addEventListener('click', async () => { try { const result = await api('/api/export', { method: 'POST', body: JSON.stringify({ week: selectedWeek }) }); exportDialog.close(); toast(`${result.total} Schedule-Änderungen ausgeführt.`); await loadWeek(selectedWeek); } catch (error) { toast(error.message, true); } });
$('#undo-export').addEventListener('click', async () => { if (!confirm('Letzten Export dieser Woche rückgängig machen?')) return; try { const result = await api('/api/export/undo', { method: 'POST', body: JSON.stringify({ week: selectedWeek }) }); toast(`${result.restored} Termine wiederhergestellt.`); await loadWeek(selectedWeek); } catch (error) { toast(error.message === 'no_export_to_undo' ? 'Kein Export zum Rückgängigmachen gefunden.' : error.message, true); } });
$('#copy-week').addEventListener('click', async () => {
  if (!confirm('Die Terminstruktur der Vorwoche in diese leere Woche kopieren? Gegner, OPGG, Drafter und Ergebnisse werden nicht übernommen.')) return;
  try { const result = await api('/api/weeks/copy-previous', { method: 'POST', body: JSON.stringify({ week: selectedWeek }) }); toast(`${result.copied.length} Termine als vorgeplant kopiert.`); await loadWeek(selectedWeek); }
  catch (error) { toast(error.message === 'target_week_not_empty' ? 'Die Zielwoche ist nicht leer.' : error.message === 'source_week_empty' ? 'Die Vorwoche enthält keine Termine.' : error.message, true); }
});
$('#previous-week').addEventListener('click', () => loadWeek(snapshot.week.previous)); $('#next-week').addEventListener('click', () => loadWeek(snapshot.week.next)); $('#week-picker').addEventListener('change', event => loadWeek(event.target.value));

(async function start() {
  try {
    const response = await fetch('/auth/me', { cache: 'no-store' });
    if (!response.ok) { login.hidden = false; $('#live-label').textContent = response.status === 503 ? 'Einrichtung läuft' : 'Anmeldung erforderlich'; return; }
    const session = await response.json(); $('#signed-in-user').textContent = `Angemeldet als ${session.user.username}`; planner.hidden = false; await loadWeek('');
  } catch (error) { login.hidden = false; $('#login-status').textContent = 'Der Planer ist gerade nicht erreichbar.'; console.error(error); }
})();
