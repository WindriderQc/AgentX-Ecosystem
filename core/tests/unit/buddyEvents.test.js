const {
  emit,
  classifyIntent,
  bus,
  getEventsAfter,
  _resetReplayForTests,
} = require('../../src/services/buddyEvents');

describe('buddyEvents intent + surfaceScope (0265)', () => {
  beforeEach(() => _resetReplayForTests());
  test('classifyIntent maps lifecycle event types', () => {
    expect(classifyIntent('alert_critical')).toBe('blocked');
    expect(classifyIntent('host_offline')).toBe('blocked');
    expect(classifyIntent('preflight_blocked')).toBe('blocked');
    expect(classifyIntent('corpus_not_ready')).toBe('blocked');
    expect(classifyIntent('error')).toBe('warning');
    expect(classifyIntent('ingest_failed')).toBe('warning');
    expect(classifyIntent('judge_start')).toBe('watching');
    expect(classifyIntent('ingest_progress')).toBe('watching');
    expect(classifyIntent('idle')).toBe('idle');
    expect(classifyIntent('whatever_unknown')).toBe('suggesting');
  });

  test('emit derives intent + defaults surfaceScope=any (back-compat 4-arg)', (done) => {
    bus.once('buddy-event', (e) => {
      try {
        expect(e.type).toBe('error');
        expect(e.intent).toBe('warning');
        expect(e.surfaceScope).toBe('any');
        expect(e.significance).toBe('normal');
        expect(e.id).toMatch(/^evt_/);
        done();
      } catch (err) { done(err); }
    });
    emit('error', 'chat', 'boom');
  });

  test('replays events after a stable cursor and reports an expired cursor', () => {
    const first = emit('first', 'platform', 'one');
    const second = emit('second', 'platform', 'two');
    const third = emit('third', 'platform', 'three');
    expect(getEventsAfter(first.id)).toEqual(expect.objectContaining({
      cursorFound: true,
      events: [second, third],
      newestCursor: third.id,
    }));
    expect(getEventsAfter('evt_missing')).toEqual(expect.objectContaining({
      cursorFound: false,
      events: [],
    }));
  });

  test('emit honors explicit intent + surfaceScope opts', (done) => {
    bus.once('buddy-event', (e) => {
      try {
        expect(e.intent).toBe('watching');
        expect(e.surfaceScope).toBe('benchmark');
        done();
      } catch (err) { done(err); }
    });
    emit('judge_start', 'benchmark', 'judging', 'low', { intent: 'watching', surfaceScope: 'benchmark' });
  });

  test('emit rejects invalid intent/scope and falls back', (done) => {
    bus.once('buddy-event', (e) => {
      try {
        expect(e.intent).toBe('warning'); // invalid opt ignored -> derived from 'error'
        expect(e.surfaceScope).toBe('any'); // invalid scope ignored
        done();
      } catch (err) { done(err); }
    });
    emit('error', 'chat', 'x', 'normal', { intent: 'bogus', surfaceScope: 'mars' });
  });
});
