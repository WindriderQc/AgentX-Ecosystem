const DEFAULT_PLANNING_TIME_ZONE = 'America/Toronto';

function dateOnlyKey(value) {
  if (!value) return '';
  if (typeof value === 'string') {
    const match = value.match(/^(\d{4}-\d{2}-\d{2})/);
    if (match) return match[1];
  }
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? '' : date.toISOString().slice(0, 10);
}

function zonedDateOnly(now = new Date(), timeZone = process.env.PLANNING_TIME_ZONE || DEFAULT_PLANNING_TIME_ZONE) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).formatToParts(now);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function isDateOnlyOverdue(value, now = new Date(), timeZone) {
  const target = dateOnlyKey(value);
  return Boolean(target && target < zonedDateOnly(now, timeZone));
}

module.exports = {
  DEFAULT_PLANNING_TIME_ZONE,
  dateOnlyKey,
  zonedDateOnly,
  isDateOnlyOverdue
};
