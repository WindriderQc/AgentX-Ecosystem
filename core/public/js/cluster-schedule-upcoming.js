/**
 * Pure projection helpers for Cluster Schedule's Upcoming Tasks panel.
 *
 * Timeline APIs return one slot for every occurrence. The panel is a job
 * summary, so frequent cron/interval entries are represented by their next
 * occurrence plus an explicit count instead of consuming the entire list.
 */
(function initClusterScheduleUpcoming(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else if (root) root.ClusterScheduleUpcoming = api;
}(typeof window !== 'undefined' ? window : globalThis, () => {
  const HOUR_MS = 60 * 60 * 1000;

  function toMillis(value) {
    const millis = new Date(value).getTime();
    return Number.isFinite(millis) ? millis : null;
  }

  function deriveIntervalMs(entry, slot) {
    if (entry?.scheduleType === 'interval' && Number(entry.intervalMs) > 0) {
      return Number(entry.intervalMs);
    }

    const starts = (entry?.slots || [])
      .map(candidate => toMillis(candidate?.start))
      .filter(Number.isFinite)
      .sort((a, b) => a - b);
    if (starts.length > 1) {
      const delta = starts[1] - starts[0];
      if (delta > 0) return delta;
    }

    const start = toMillis(slot?.start);
    const end = toMillis(slot?.end);
    return start !== null && end !== null && end > start ? end - start : null;
  }

  function isHighFrequencyRecurring(entry, intervalMs) {
    const slots = entry?.slots || [];
    const scheduleType = entry?.scheduleType || (slots.length > 1 ? 'cron' : null);
    if (scheduleType !== 'cron' && scheduleType !== 'interval') return false;
    return (Number(intervalMs) > 0 && Number(intervalMs) < HOUR_MS) || slots.length > 12;
  }

  function defaultFormatTime(value) {
    return new Date(value).toLocaleTimeString([], {
      hour: '2-digit',
      minute: '2-digit',
      hour12: false
    });
  }

  function buildUpcomingTasks(entries, options = {}) {
    const now = Number.isFinite(options.now) ? options.now : Date.now();
    const todaySelected = options.todaySelected !== false;
    const formatTime = options.formatTime || defaultFormatTime;
    const maxItems = Number.isInteger(options.maxItems) && options.maxItems > 0
      ? options.maxItems
      : 25;
    const occurrences = [];

    for (const entry of (entries || [])) {
      const slots = (entry?.slots || [])
        .map(slot => ({
          slot,
          startMs: toMillis(slot?.start),
          endMs: toMillis(slot?.end)
        }))
        .filter(candidate => candidate.startMs !== null && candidate.endMs !== null)
        .filter(candidate => !todaySelected || candidate.endMs >= now)
        .sort((a, b) => a.startMs - b.startMs);

      if (!slots.length) continue;

      const dailyCount = entry.slots?.length || slots.length;
      const intervalMs = deriveIntervalMs(entry, slots[0].slot);
      const collapseOccurrences = isHighFrequencyRecurring(entry, intervalMs);
      const visibleSlots = collapseOccurrences ? slots.slice(0, 1) : slots;

      for (const candidate of visibleSlots) {
        const { slot, startMs } = candidate;
        const occurrenceCount = collapseOccurrences ? slots.length : 1;
        occurrences.push({
          id: `${entry.id || entry.sourceId || entry.name}-${slot.start}`,
          name: entry.name,
          source: entry.source,
          taskType: entry.taskType,
          host: entry.host,
          model: entry.model,
          priority: entry.priority,
          scheduleType: entry.scheduleType || (dailyCount > 1 ? 'cron' : null),
          intervalMs,
          dailyCount,
          nextRun: slot.start,
          msFromNow: Math.max(0, startMs - now),
          displayMode: todaySelected ? 'countdown' : 'time',
          displayText: formatTime(slot.start),
          collapsedOccurrences: collapseOccurrences,
          occurrenceCount,
          occurrenceLabel: collapseOccurrences
            ? (todaySelected
              ? `${occurrenceCount} remaining today`
              : `${occurrenceCount} on selected day`)
            : ''
        });
      }
    }

    occurrences.sort((a, b) => {
      if (a.msFromNow !== b.msFromNow) return a.msFromNow - b.msFromNow;
      return toMillis(a.nextRun) - toMillis(b.nextRun);
    });

    return occurrences.slice(0, maxItems);
  }

  return Object.freeze({
    buildUpcomingTasks,
    deriveIntervalMs,
    isHighFrequencyRecurring
  });
}));
