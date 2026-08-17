const {
  defaultPlanningTimeZone,
  dateOnlyKey,
  zonedDateOnly,
  isDateOnlyOverdue
} = require('../../src/services/planningDateService');

describe('planningDateService date-only semantics', () => {
  test('uses UTC as the reusable default and honors deployment configuration', () => {
    expect(defaultPlanningTimeZone({})).toBe('UTC');
    expect(defaultPlanningTimeZone({ PLANNING_TIME_ZONE: 'America/Toronto' })).toBe('America/Toronto');
  });

  test('preserves the calendar date from stored ISO values', () => {
    expect(dateOnlyKey('2026-07-16T00:00:00.000Z')).toBe('2026-07-16');
    expect(dateOnlyKey(new Date('2026-07-16T00:00:00.000Z'))).toBe('2026-07-16');
  });

  test('uses the Planning timezone instead of UTC for the current day', () => {
    const now = new Date('2026-07-16T02:00:00.000Z');
    expect(zonedDateOnly(now, 'America/Toronto')).toBe('2026-07-15');
  });

  test('does not mark a target overdue until its local calendar day has ended', () => {
    expect(isDateOnlyOverdue(
      '2026-07-16T00:00:00.000Z',
      new Date('2026-07-17T03:59:00.000Z'),
      'America/Toronto'
    )).toBe(false);
    expect(isDateOnlyOverdue(
      '2026-07-16T00:00:00.000Z',
      new Date('2026-07-17T04:01:00.000Z'),
      'America/Toronto'
    )).toBe(true);
  });
});
