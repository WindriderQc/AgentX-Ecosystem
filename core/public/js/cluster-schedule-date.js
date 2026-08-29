(function (root, factory) {
  var api = factory();

  if (typeof module === 'object' && module.exports) {
    module.exports = api;
    return;
  }

  root.ClusterScheduleDate = api;
})(typeof window !== 'undefined' ? window : globalThis, function () {
  'use strict';

  var DATE_KEY_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

  function asDate(value) {
    var date = value instanceof Date ? new Date(value.getTime()) : new Date(value);
    if (Number.isNaN(date.getTime())) throw new Error('A valid instant is required.');
    return date;
  }

  function datePartsInZone(value, timeZone) {
    var date = asDate(value);
    if (timeZone) {
      try {
        var parts = new Intl.DateTimeFormat('en-CA', {
          timeZone: timeZone,
          year: 'numeric',
          month: '2-digit',
          day: '2-digit'
        }).formatToParts(date);
        var values = {};
        parts.forEach(function (part) { values[part.type] = part.value; });
        return {
          year: Number(values.year),
          month: Number(values.month),
          day: Number(values.day)
        };
      } catch (_error) {
        // An unavailable/invalid zone falls back to the browser calendar below.
      }
    }

    return {
      year: date.getFullYear(),
      month: date.getMonth() + 1,
      day: date.getDate()
    };
  }

  function pad2(value) {
    return String(value).padStart(2, '0');
  }

  function localDateKey(value, timeZone) {
    var parts = datePartsInZone(value == null ? new Date() : value, timeZone);
    return String(parts.year).padStart(4, '0') + '-' + pad2(parts.month) + '-' + pad2(parts.day);
  }

  function parseDateKey(dateKey) {
    var match = String(dateKey || '').match(DATE_KEY_PATTERN);
    if (!match) throw new Error('Date key must use YYYY-MM-DD.');
    var year = Number(match[1]);
    var month = Number(match[2]);
    var day = Number(match[3]);
    var check = new Date(Date.UTC(year, month - 1, day, 12));
    if (check.getUTCFullYear() !== year || check.getUTCMonth() !== month - 1 || check.getUTCDate() !== day) {
      throw new Error('Date key is not a real calendar date.');
    }
    return { year: year, month: month, day: day };
  }

  function addCalendarDays(dateKey, delta) {
    var parts = parseDateKey(dateKey);
    var amount = Number(delta);
    if (!Number.isInteger(amount)) throw new Error('Calendar-day shift must be an integer.');
    var shifted = new Date(Date.UTC(parts.year, parts.month - 1, parts.day + amount, 12));
    return [
      String(shifted.getUTCFullYear()).padStart(4, '0'),
      pad2(shifted.getUTCMonth() + 1),
      pad2(shifted.getUTCDate())
    ].join('-');
  }

  function formatCalendarDate(dateKey, options) {
    var parts = parseDateKey(dateKey);
    options = options || {};
    var locale = options.locale || 'en-US';
    var format = options.format
      ? Object.assign({}, options.format)
      : { weekday: 'short', month: 'short', day: 'numeric' };

    // A date key is a calendar label, not an instant. Formatting an artificial
    // UTC-noon value in UTC prevents the label from shifting in either direction.
    format.timeZone = 'UTC';
    return new Intl.DateTimeFormat(locale, format)
      .format(new Date(Date.UTC(parts.year, parts.month - 1, parts.day, 12)));
  }

  function isToday(dateKey, now, timeZone) {
    return String(dateKey || '') === localDateKey(now == null ? new Date() : now, timeZone);
  }

  function describeCalendarDate(dateKey, options) {
    options = options || {};
    var today = isToday(dateKey, options.now, options.timeZone);
    var baseLabel = formatCalendarDate(dateKey, {
      locale: options.locale,
      format: options.format
    });
    return {
      dateKey: dateKey,
      isToday: today,
      label: today ? baseLabel + ' (Today)' : baseLabel,
      timeZone: options.timeZone || null
    };
  }

  function browserTimeZone() {
    try {
      return Intl.DateTimeFormat().resolvedOptions().timeZone || null;
    } catch (_error) {
      return null;
    }
  }

  return {
    localDateKey: localDateKey,
    addCalendarDays: addCalendarDays,
    formatCalendarDate: formatCalendarDate,
    isToday: isToday,
    describeCalendarDate: describeCalendarDate,
    browserTimeZone: browserTimeZone
  };
});
