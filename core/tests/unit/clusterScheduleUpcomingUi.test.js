const fs = require('fs');
const path = require('path');
const vm = require('vm');
const upcoming = require('../../public/js/cluster-schedule-upcoming.js');
const headline = require('../../public/js/cluster-schedule-headline.js');

const root = path.resolve(__dirname, '../..');
const read = relative => fs.readFileSync(path.join(root, relative), 'utf8');

function slot(start, durationMs = 60_000) {
  return {
    start: new Date(start).toISOString(),
    end: new Date(start + durationMs).toISOString()
  };
}

function frequentEntry({
  id = 'gmail-triage',
  name = 'Gmail triage',
  start = Date.parse('2026-08-28T00:00:00.000Z'),
  count = 20,
  intervalMs = 5 * 60_000
} = {}) {
  return {
    id,
    name,
    source: 'agentx-system',
    taskType: 'sync',
    scheduleType: 'cron',
    host: null,
    slots: Array.from({ length: count }, (_, index) => slot(start + index * intervalMs))
  };
}

function loadClusterScheduleContext() {
  const elements = new Map();
  const document = {
    addEventListener: jest.fn(),
    querySelectorAll: jest.fn(() => []),
    querySelector: jest.fn(() => null),
    getElementById: jest.fn(id => {
      if (!elements.has(id)) {
        elements.set(id, {
          innerHTML: '',
          style: {},
          classList: { add: jest.fn(), remove: jest.fn(), toggle: jest.fn(), contains: jest.fn() }
        });
      }
      return elements.get(id);
    })
  };
  const window = {
    ClusterScheduleDate: {
      browserTimeZone: () => 'UTC',
      localDateKey: () => '2026-08-28',
      isToday: () => true,
      formatCalendarDate: value => value,
      describeCalendarDate: value => ({ label: value }),
      addCalendarDays: value => value
    },
    ClusterScheduleUpcoming: upcoming,
    ClusterScheduleHeadline: headline,
    AgentXUtils: { escapeHtml: value => String(value) },
    addEventListener: jest.fn(),
    innerWidth: 1280,
    innerHeight: 720
  };
  const context = vm.createContext({
    window,
    document,
    console,
    fetch: jest.fn(),
    setInterval: jest.fn(),
    clearInterval: jest.fn()
  });
  vm.runInContext(read('public/js/cluster-schedule.js'), context);
  vm.runInContext(read('public/js/cluster-schedule-services.js'), context);
  return { context, elements };
}

describe('Cluster Schedule upcoming-task projection', () => {
  test('collapses a frequent job to its next fire and remaining occurrence count', () => {
    const now = Date.parse('2026-08-28T00:02:00.000Z');
    const frequent = frequentEntry();
    const separate = {
      id: 'benchmark-daily',
      name: 'Daily benchmark',
      source: 'agentx',
      taskType: 'benchmark',
      scheduleType: 'cron',
      slots: [slot(Date.parse('2026-08-28T00:03:00.000Z'))]
    };

    const result = upcoming.buildUpcomingTasks([frequent, separate], {
      now,
      todaySelected: true,
      formatTime: value => value
    });

    expect(result.map(item => item.name)).toEqual(['Daily benchmark', 'Gmail triage']);
    const gmail = result.find(item => item.id.startsWith('gmail-triage-'));
    expect(result.filter(item => item.name === 'Gmail triage')).toHaveLength(1);
    expect(gmail).toMatchObject({
      nextRun: '2026-08-28T00:05:00.000Z',
      intervalMs: 5 * 60_000,
      collapsedOccurrences: true,
      occurrenceCount: 19,
      occurrenceLabel: '19 remaining today',
      displayMode: 'countdown'
    });
  });

  test('keeps distinct frequent jobs separate even when their display names match', () => {
    const result = upcoming.buildUpcomingTasks([
      frequentEntry({ id: 'gmail-personal' }),
      frequentEntry({ id: 'gmail-work' })
    ], {
      now: Date.parse('2026-08-27T23:59:00.000Z'),
      todaySelected: true
    });

    expect(result).toHaveLength(2);
    expect(result.map(item => item.id)).toEqual(expect.arrayContaining([
      expect.stringContaining('gmail-personal-'),
      expect.stringContaining('gmail-work-')
    ]));
  });

  test('does not collapse ordinary low-frequency occurrences', () => {
    const result = upcoming.buildUpcomingTasks([{
      id: 'twice-daily',
      name: 'Twice daily review',
      scheduleType: 'cron',
      taskType: 'maintenance',
      slots: [
        slot(Date.parse('2026-08-28T09:00:00.000Z')),
        slot(Date.parse('2026-08-28T17:00:00.000Z'))
      ]
    }], {
      now: Date.parse('2026-08-28T08:00:00.000Z'),
      todaySelected: true
    });

    expect(result).toHaveLength(2);
    expect(result.every(item => item.collapsedOccurrences === false)).toBe(true);
  });

  test('preserves selected future-day clock display while collapsing recurrence rows', () => {
    const futureStart = Date.parse('2026-08-29T10:00:00.000Z');
    const result = upcoming.buildUpcomingTasks([
      frequentEntry({ start: futureStart, count: 13 })
    ], {
      now: Date.parse('2026-08-28T12:00:00.000Z'),
      todaySelected: false,
      formatTime: value => `clock:${value}`
    });

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      nextRun: '2026-08-29T10:00:00.000Z',
      displayMode: 'time',
      displayText: 'clock:2026-08-29T10:00:00.000Z',
      occurrenceCount: 13,
      occurrenceLabel: '13 on selected day'
    });
  });

  test('derives cadence from chronological starts even if slots arrive unsorted', () => {
    const base = Date.parse('2026-08-28T10:00:00.000Z');
    const entry = frequentEntry({ count: 0 });
    entry.slots = [slot(base + 10 * 60_000), slot(base), slot(base + 5 * 60_000)];
    expect(upcoming.deriveIntervalMs(entry, entry.slots[0])).toBe(5 * 60_000);
  });
});

describe('Cluster Schedule evidence presentation', () => {
  test('treats an all-null utilization grid as unobserved rather than zero percent', () => {
    const { context } = loadClusterScheduleContext();
    const container = { innerHTML: '' };
    const render = vm.runInContext('renderUtilHeatmap', context);
    const observed = render(container, {
      hosts: ['gpu-a'],
      days: ['2026-08-28'],
      grid: { 'gpu-a': [new Array(24).fill(null)] }
    });

    expect(observed).toBe(false);
    expect(container.innerHTML).toContain('No utilization evidence observed yet');
    expect(container.innerHTML).toContain('not treated as zero-utilization measurements');
  });

  test('distinguishes observed zero utilization from hours without evidence', () => {
    const { context } = loadClusterScheduleContext();
    const container = { innerHTML: '' };
    const values = new Array(24).fill(null);
    values[4] = 0;
    const render = vm.runInContext('renderUtilHeatmap', context);
    const observed = render(container, {
      hosts: ['gpu-a'],
      days: ['2026-08-28'],
      grid: { 'gpu-a': [values] }
    });

    expect(observed).toBe(true);
    expect(container.innerHTML).toContain('04:00 — 0% utilization');
    expect(container.innerHTML).toContain('00:00 — utilization evidence not observed');
  });

  test('uses an evidence-empty state for actual-vs-planned and retains measured zero', () => {
    const { context } = loadClusterScheduleContext();
    const render = vm.runInContext('renderActualVsPlanned', context);
    const emptyContainer = { innerHTML: '' };
    render(emptyContainer, { planned: [], actualByHost: { 'gpu-a': [] } });
    expect(emptyContainer.innerHTML).toContain('No planned-run or utilization evidence observed');

    const measuredContainer = { innerHTML: '' };
    render(measuredContainer, {
      planned: [],
      actualByHost: {
        'gpu-a': [{ hour: 4, utilizationPct: 0, totalCalls: 1 }]
      }
    });
    expect(measuredContainer.innerHTML).toContain('gpu-a');
    expect(measuredContainer.innerHTML).toContain('04:00 actual 0% (1 call)');
  });

  test('shows only declared assignments as host evidence in the legend', () => {
    const { context, elements } = loadClusterScheduleContext();
    const render = vm.runInContext('renderLegend', context);
    render([
      { name: 'Bound job', host: 'gpu-a', source: 'agentx' },
      { name: 'Shared job', host: null, source: 'agentx-system' },
      { name: 'Undeclared job', host: 'unassigned', source: 'agentx-system' }
    ]);
    const html = elements.get('legend').innerHTML;

    expect(html).toContain('Declared host assignments');
    expect(html).toContain('gpu-a');
    expect(html).toContain('Not declared for 2 scheduled jobs; this is not a hardware count.');
    expect(html).not.toContain('>Host not declared<');
  });

  test('loads the upcoming projection before the dashboard controller', () => {
    const app = read('src/app.js');
    const routeBlock = app.slice(
      app.indexOf("app.get('/cluster-schedule'"),
      app.indexOf("app.get('/memory-review'")
    );

    expect(routeBlock.indexOf('/js/cluster-schedule-upcoming.js'))
      .toBeLessThan(routeBlock.indexOf('/js/cluster-schedule.js'));
  });
});
