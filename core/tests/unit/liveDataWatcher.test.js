/**
 * Unit tests for the Live Data → Buddy demo watcher (TODO 0288).
 * Mocks global.fetch; asserts core consumes only the DATA quake feed and
 * narrates new quakes >= threshold to the buddy /emit bus.
 */
const watcher = require('../../src/services/liveDataWatcher');
const { tick, reset, quakeId } = watcher._internals;

function mockFetch(quakes) {
  global.fetch = jest.fn(async (url) => {
    const u = String(url);
    if (u.includes('/api/v1/livedata/quakes')) return { ok: true, json: async () => ({ status: 'success', data: quakes }) };
    if (u.includes('/api/platform-events')) return { ok: true, json: async () => ({ status: 'success' }) };
    throw new Error(`unexpected url ${u}`);
  });
}

const emitCalls = () => global.fetch.mock.calls.filter(c => String(c[0]).includes('/api/platform-events'));
const dataCalls = () => global.fetch.mock.calls.filter(c => String(c[0]).includes('/api/v1/livedata/quakes'));

describe('liveDataWatcher', () => {
  beforeEach(() => {
    reset();
    process.env.LIVEDATA_BUDDY_QUAKE_MAG = '5';
    delete process.env.DATAAPI_API_KEY;
  });
  afterEach(() => { watcher.stop(); jest.restoreAllMocks(); });

  test('start() is a no-op unless LIVEDATA_BUDDY_DEMO=true', () => {
    delete process.env.LIVEDATA_BUDDY_DEMO;
    expect(watcher.start()).toBe(false);
  });

  test('first poll primes (marks backlog seen) and never narrates it', async () => {
    mockFetch([{ id: 'q1', mag: 6.2, place: 'Backlog A', time: 1 }]);
    await tick();
    expect(dataCalls().length).toBe(1);   // consumed the data feed
    expect(emitCalls().length).toBe(0);   // but narrated nothing on the prime pass
  });

  test('narrates a NEW quake >= threshold to the buddy bus', async () => {
    mockFetch([{ id: 'q1', mag: 6.2, place: 'Backlog A', time: 1 }]);
    await tick(); // prime

    mockFetch([
      { id: 'q1', mag: 6.2, place: 'Backlog A', time: 1 },
      { id: 'q2', mag: 6.5, place: 'Aleutians', time: 2 }
    ]);
    await tick();

    const emits = emitCalls();
    expect(emits.length).toBe(1);
    const body = JSON.parse(emits[0][1].body);
    expect(body.type).toBe('livedata.quake');
    expect(body.class).toBe('observation');
    expect(body.summary).toContain('M6.5');
    expect(body.summary).toContain('Aleutians');
  });

  test('ignores new quakes below the magnitude threshold', async () => {
    mockFetch([]);
    await tick(); // prime (empty)
    mockFetch([{ id: 'small', mag: 3.1, place: 'Nowhere', time: 9 }]);
    await tick();
    expect(emitCalls().length).toBe(0);
  });

  test('only consumes the data feed URL — no external source', async () => {
    mockFetch([{ id: 'q1', mag: 7.0, place: 'X', time: 1 }]);
    await tick();
    await tick();
    // every fetch is either the data feed or the loopback buddy bus — never an external API
    global.fetch.mock.calls.forEach(c => {
      const u = String(c[0]);
      expect(u.includes('/api/v1/livedata/quakes') || u.includes('/api/platform-events')).toBe(true);
    });
  });

  test('quakeId falls back through id → net+code → composite', () => {
    expect(quakeId({ id: 'abc' })).toBe('abc');
    expect(quakeId({ net: 'us', code: '123' })).toBe('us123');
    expect(quakeId({ time: 't', place: 'p', mag: '5' })).toBe('t|p|5');
  });
});
