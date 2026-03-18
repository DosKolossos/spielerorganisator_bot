function todayInBerlin() {
  return new Intl.DateTimeFormat('sv-SE', {
    timeZone: 'Europe/Berlin',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).format(new Date());
}

function isValidIsoDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;

  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));

  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
  );
}

function parseDateInput(value) {
  if (!value) return null;
  const trimmed = value.trim();

  if (isValidIsoDate(trimmed)) return trimmed;

  if (/^\d{2}\.\d{2}\.\d{4}$/.test(trimmed)) {
    const [day, month, year] = trimmed.split('.');
    const iso = `${year}-${month}-${day}`;
    return isValidIsoDate(iso) ? iso : null;
  }

  return null;
}

function isValidTime(value) {
  if (!/^\d{2}:\d{2}$/.test(value)) return false;
  const [hours, minutes] = value.split(':').map(Number);
  return hours >= 0 && hours <= 23 && minutes >= 0 && minutes <= 59;
}

function formatDateDE(dateStr) {
  const [year, month, day] = dateStr.split('-');
  return `${day}.${month}.${year}`;
}

function extractDatePart(dateTime) {
  return dateTime.slice(0, 10);
}

function extractTimePart(dateTime) {
  return dateTime.slice(11, 16);
}

function formatDateTimeDE(dateTime) {
  const [dateStr, timeStr] = dateTime.split(' ');
  return `${formatDateDE(dateStr)}, ${timeStr}`;
}

function formatEntryRange(startAt, endAt) {
  const startDate = extractDatePart(startAt);
  const endDate = extractDatePart(endAt);
  const startTime = extractTimePart(startAt);
  const endTime = extractTimePart(endAt);

  const isAllDay = startTime === '00:00' && endTime === '23:59';

  if (isAllDay && startDate === endDate) return `${formatDateDE(startDate)} (ganztägig)`;
  if (isAllDay) return `${formatDateDE(startDate)} → ${formatDateDE(endDate)} (ganztägig)`;
  return `${formatDateTimeDE(startAt)} → ${formatDateTimeDE(endAt)}`;
}

function startOfWeekMonday(dateStr) {
  const [year, month, day] = dateStr.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  const weekday = date.getUTCDay();
  const diffToMonday = weekday === 0 ? 6 : weekday - 1;
  date.setUTCDate(date.getUTCDate() - diffToMonday);

  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, '0');
  const d = String(date.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function endOfWeekSunday(dateStr) {
  const monday = startOfWeekMonday(dateStr);
  const [year, month, day] = monday.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  date.setUTCDate(date.getUTCDate() + 6);
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, '0');
  const d = String(date.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function isInCurrentWeek(dateStr, today = todayInBerlin()) {
  return dateStr >= startOfWeekMonday(today) && dateStr <= endOfWeekSunday(today);
}

module.exports = {
  todayInBerlin,
  isValidIsoDate,
  parseDateInput,
  isValidTime,
  formatDateDE,
  formatDateTimeDE,
  formatEntryRange,
  extractDatePart,
  extractTimePart,
  startOfWeekMonday,
  endOfWeekSunday,
  isInCurrentWeek
};
