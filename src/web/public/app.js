const teamsRoot = document.querySelector('#teams');
const teamTemplate = document.querySelector('#team-template');
const eventTemplate = document.querySelector('#event-template');
const liveDot = document.querySelector('#live-dot');
const liveLabel = document.querySelector('#live-label');
const lastUpdate = document.querySelector('#last-update');

const dateFormatter = new Intl.DateTimeFormat('de-DE', {
  weekday: 'short', day: '2-digit', month: '2-digit', year: 'numeric'
});
const timeFormatter = new Intl.DateTimeFormat('de-DE', {
  hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Berlin'
});

const typeLabels = {
  scrim: 'Scrim',
  primeleague: 'Prime League',
  training: 'Training',
  open: 'Offen'
};
const statusLabels = {
  pending: 'Offen',
  planned: 'Geplant',
  confirmed: 'Bestätigt',
  scheduled: 'Terminiert',
  completed: 'Beendet'
};

function parseDate(value) {
  if (!value) return null;
  const normalized = value.includes('T') ? value : value.replace(' ', 'T');
  const date = new Date(normalized);
  return Number.isNaN(date.getTime()) ? null : date;
}

function formatTime(value) {
  const date = parseDate(value);
  return date ? `${timeFormatter.format(date)} Uhr` : 'noch offen';
}

function addMeta(root, label, value) {
  if (!value) return;
  const wrapper = document.createElement('div');
  const term = document.createElement('dt');
  const detail = document.createElement('dd');
  term.textContent = label;
  detail.textContent = value;
  wrapper.append(term, detail);
  root.append(wrapper);
}

function renderLineup(root, lineup) {
  root.replaceChildren();
  if (!lineup.length) {
    root.textContent = 'Noch keine Aufstellung eingetragen.';
    root.classList.add('empty-copy');
    return;
  }
  root.classList.remove('empty-copy');
  for (const slot of lineup) {
    const item = document.createElement('div');
    const role = document.createElement('span');
    const player = document.createElement('strong');
    role.textContent = slot.role;
    player.textContent = slot.player;
    item.append(role, player);
    root.append(item);
  }
}

function renderEitherOr(root, choices) {
  root.replaceChildren();
  for (const choice of choices) {
    const item = document.createElement('p');
    const first = parseDate(choice.firstDate);
    const second = parseDate(choice.secondDate);
    item.textContent = `↔ ${choice.player}: ${first ? dateFormatter.format(first) : choice.firstDate} oder ${second ? dateFormatter.format(second) : choice.secondDate}`;
    root.append(item);
  }
}

function renderEvent(event) {
  const fragment = eventTemplate.content.cloneNode(true);
  const card = fragment.querySelector('.event-card');
  const startsAt = parseDate(event.startsAt || event.date);
  fragment.querySelector('.event-date').textContent = startsAt
    ? dateFormatter.format(startsAt)
    : event.date || 'Datum offen';
  fragment.querySelector('h3').textContent = event.title || typeLabels[event.type] || 'Termin';

  const badges = fragment.querySelector('.badges');
  const typeBadge = document.createElement('span');
  typeBadge.className = `badge type-${event.type || 'open'}`;
  typeBadge.textContent = typeLabels[event.type] || event.type || 'Termin';
  const statusBadge = document.createElement('span');
  statusBadge.className = `badge status-${event.status || 'pending'}`;
  statusBadge.textContent = statusLabels[event.status] || event.status || 'Offen';
  badges.append(typeBadge, statusBadge);

  const opponent = fragment.querySelector('.event-opponent');
  opponent.textContent = event.opponent ? `vs. ${event.opponent}` : 'Gegner noch offen';
  opponent.classList.toggle('muted', !event.opponent);

  const meta = fragment.querySelector('.event-meta');
  addMeta(meta, 'Start', formatTime(event.startsAt));
  addMeta(meta, 'Treffen', event.meetingAt ? formatTime(event.meetingAt) : null);
  addMeta(meta, 'Stream', event.streamed ? 'Ja' : null);

  renderLineup(fragment.querySelector('.lineup'), event.lineup || []);
  const availability = fragment.querySelector('.availability');
  availability.textContent = event.availability || 'Noch keine zusammengefassten Angaben.';
  renderEitherOr(fragment.querySelector('.either-or'), event.eitherOr || []);

  const opgg = fragment.querySelector('.opgg-link');
  if (event.opggUrl) {
    opgg.href = event.opggUrl;
  } else {
    opgg.remove();
  }

  if (!event.lineup?.length) card.querySelector('.lineup-section').classList.add('subtle');
  return fragment;
}

function render(snapshot) {
  teamsRoot.replaceChildren();
  if (!snapshot.teams?.length) {
    teamsRoot.innerHTML = '<div class="loading">Keine aktiven Teams gefunden.</div>';
    return;
  }

  for (const team of snapshot.teams) {
    const fragment = teamTemplate.content.cloneNode(true);
    fragment.querySelector('h2').textContent = team.name;
    fragment.querySelector('.event-count').textContent = `${team.events.length} ${team.events.length === 1 ? 'Termin' : 'Termine'}`;
    const eventsRoot = fragment.querySelector('.events');
    if (!team.events.length) {
      const empty = document.createElement('div');
      empty.className = 'empty-state';
      empty.textContent = 'Aktuell sind keine kommenden Termine eingetragen.';
      eventsRoot.append(empty);
    } else {
      for (const event of team.events) eventsRoot.append(renderEvent(event));
    }
    teamsRoot.append(fragment);
  }

  liveDot.classList.add('online');
  liveLabel.textContent = snapshot.botOnline ? 'Live mit Discord verbunden' : 'Planerdaten verbunden';
  lastUpdate.textContent = `Aktualisiert: ${timeFormatter.format(new Date(snapshot.generatedAt))}`;
}

async function loadInitialData() {
  try {
    const response = await fetch('/api/planner', { cache: 'no-store' });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    render(await response.json());
  } catch (error) {
    liveLabel.textContent = 'Daten konnten nicht geladen werden';
    lastUpdate.textContent = 'Erneuter Versuch läuft …';
    console.error(error);
  }
}

function connectLiveUpdates() {
  const stream = new EventSource('/api/live');
  stream.addEventListener('planner', message => {
    try {
      render(JSON.parse(message.data));
    } catch (error) {
      console.error('Ungültige Live-Daten:', error);
    }
  });
  stream.onerror = () => {
    liveDot.classList.remove('online');
    liveLabel.textContent = 'Live-Verbindung wird erneuert';
  };
}

loadInitialData();
connectLiveUpdates();
