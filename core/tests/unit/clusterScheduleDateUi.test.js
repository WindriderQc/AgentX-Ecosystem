const fs = require('fs');
const path = require('path');
const scheduleDate = require('../../public/js/cluster-schedule-date.js');

const root = path.resolve(__dirname, '../..');
const read = (relative) => fs.readFileSync(path.join(root, relative), 'utf8');

describe('Cluster Schedule browser-local calendar', () => {
  const lateThursdayToronto = new Date('2026-08-28T03:18:00.000Z');

  test('does not roll Today to Friday while it is still Thursday in Toronto', () => {
    expect(scheduleDate.localDateKey(lateThursdayToronto, 'America/Toronto')).toBe('2026-08-27');
    expect(scheduleDate.localDateKey(lateThursdayToronto, 'UTC')).toBe('2026-08-28');

    expect(scheduleDate.describeCalendarDate('2026-08-27', {
      now: lateThursdayToronto,
      timeZone: 'America/Toronto',
      locale: 'en-US'
    })).toEqual({
      dateKey: '2026-08-27',
      isToday: true,
      label: 'Thu, Aug 27 (Today)',
      timeZone: 'America/Toronto'
    });
  });

  test('keeps the same instant on Friday for an operator whose browser is in UTC', () => {
    expect(scheduleDate.describeCalendarDate('2026-08-28', {
      now: lateThursdayToronto,
      timeZone: 'UTC',
      locale: 'en-US'
    })).toMatchObject({
      isToday: true,
      label: 'Fri, Aug 28 (Today)'
    });

    expect(scheduleDate.isToday('2026-08-27', lateThursdayToronto, 'UTC')).toBe(false);
  });

  test('moves date-only navigation by calendar days across DST and year boundaries', () => {
    expect(scheduleDate.addCalendarDays('2026-03-07', 1)).toBe('2026-03-08');
    expect(scheduleDate.addCalendarDays('2026-03-08', 1)).toBe('2026-03-09');
    expect(scheduleDate.addCalendarDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(scheduleDate.addCalendarDays('2027-01-01', -1)).toBe('2026-12-31');
  });

  test('formats date-only heatmap labels without applying an instant offset', () => {
    expect(scheduleDate.formatCalendarDate('2026-08-27', {
      locale: 'en-US',
      format: { month: 'short', day: 'numeric' }
    })).toBe('Aug 27');
  });

  test('rejects malformed or impossible date-only keys instead of guessing', () => {
    expect(() => scheduleDate.addCalendarDays('2026-02-30', 1)).toThrow('real calendar date');
    expect(() => scheduleDate.formatCalendarDate('08/27/2026')).toThrow('YYYY-MM-DD');
  });

  test('loads the calendar helper before the dashboard and removes UTC-derived UI day keys', () => {
    const app = read('src/app.js');
    const controller = read('public/js/cluster-schedule.js');
    const view = read('views/pages/cluster-schedule.ejs');
    const routeBlock = app.slice(
      app.indexOf("app.get('/cluster-schedule'"),
      app.indexOf("app.get('/memory-review'")
    );

    expect(routeBlock.indexOf('/js/cluster-schedule-date.js'))
      .toBeLessThan(routeBlock.indexOf('/js/cluster-schedule.js'));
    expect(controller).toContain('SCHEDULE_DATE.localDateKey');
    expect(controller).toContain('SCHEDULE_DATE.addCalendarDays');
    expect(controller).toContain('SCHEDULE_DATE.formatCalendarDate');
    expect(controller).not.toContain("new Date().toISOString().slice(0, 10)");
    expect(controller).not.toContain("days[di] + 'T12:00:00Z'");
    expect(view).toContain('id="dateZoneLabel"');
  });
});
