const ROSTER_STATUS_VALUES = ['main', 'sub', 'coach', 'admin', 'inactive'];
const POSITION_VALUES = ['Top', 'Jgl', 'Mid', 'ADC', 'Supp', 'Fill'];

const ROSTER_STATUS_CHOICES = [
  { name: 'Main-Line-up', value: 'main' },
  { name: 'Sub', value: 'sub' },
  { name: 'Coach', value: 'coach' },
  { name: 'Admin', value: 'admin' },
  { name: 'Inaktiv', value: 'inactive' }
];

const POSITION_CHOICES = POSITION_VALUES.map(value => ({ name: value, value }));

function normalizeRosterStatus(value) {
  const normalized = String(value || '').trim().toLowerCase();
  if (ROSTER_STATUS_VALUES.includes(normalized)) return normalized;
  return 'sub';
}

function normalizePosition(value) {
  const normalized = String(value || '').trim().toLowerCase();
  if (!normalized || normalized === '-' || normalized === '__clear__') return null;
  return POSITION_VALUES.find(position => position.toLowerCase() === normalized) || null;
}

function rosterStatusLabel(value) {
  switch (normalizeRosterStatus(value)) {
    case 'main':
      return 'Main-Line-up';
    case 'coach':
      return 'Coach';
    case 'admin':
      return 'Admin';
    case 'inactive':
      return 'Inaktiv';
    case 'sub':
    default:
      return 'Sub';
  }
}

function rosterGroupLabel(value) {
  switch (normalizeRosterStatus(value)) {
    case 'main':
      return 'Main-Line-up';
    case 'coach':
    case 'admin':
      return 'Coaches/Admins';
    case 'inactive':
      return 'Inaktiv';
    case 'sub':
    default:
      return 'Subs';
  }
}

function rosterSortRank(value) {
  switch (normalizeRosterStatus(value)) {
    case 'main':
      return 0;
    case 'sub':
      return 1;
    case 'coach':
      return 2;
    case 'admin':
      return 3;
    case 'inactive':
      return 4;
    default:
      return 9;
  }
}

function positionMatchesRole(row, roleLabel) {
  const role = String(roleLabel || '').trim();
  if (!role || role.startsWith('Sub')) return true;
  const primary = normalizePosition(row.primary_position || row.preferred_position);
  const secondary = normalizePosition(row.secondary_position);
  return primary === role || secondary === role || primary === 'Fill' || secondary === 'Fill';
}

function displayName(row) {
  return row?.display_name || row?.alias || row?.global_name || row?.username || row?.discord_user_id || 'Unbekannt';
}

function formatRosterGroups(rows, options = {}) {
  const { emptyText = '-', bulletPrefix = '', includeInactive = true } = options;
  const groups = [
    { key: 'main', label: 'Main-Line-up', rows: [] },
    { key: 'sub', label: 'Subs', rows: [] },
    { key: 'staff', label: 'Coaches/Admins', rows: [] },
    { key: 'inactive', label: 'Inaktiv', rows: [] }
  ];

  const groupByKey = new Map(groups.map(group => [group.key, group]));

  for (const row of rows || []) {
    const status = normalizeRosterStatus(row.roster_status);
    if (status === 'inactive' && !includeInactive) continue;

    const key = status === 'coach' || status === 'admin' ? 'staff' : status;
    const group = groupByKey.get(key) || groupByKey.get('sub');
    group.rows.push(row);
  }

  const lines = [];
  for (const group of groups) {
    if (!group.rows.length) continue;

    const names = group.rows
      .slice()
      .sort((a, b) => displayName(a).localeCompare(displayName(b), 'de'))
      .map(displayName)
      .join(', ');

    lines.push(`${bulletPrefix}**${group.label}:** ${names}`);
  }

  return lines.length ? lines.join('\n') : emptyText;
}

function opggRegion(value) {
  return String(value || 'euw').trim().toLowerCase() || 'euw';
}

module.exports = {
  ROSTER_STATUS_VALUES,
  ROSTER_STATUS_CHOICES,
  POSITION_VALUES,
  POSITION_CHOICES,
  normalizeRosterStatus,
  normalizePosition,
  rosterStatusLabel,
  rosterGroupLabel,
  rosterSortRank,
  positionMatchesRole,
  displayName,
  formatRosterGroups,
  opggRegion
};
