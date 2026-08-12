/**
 * Unit tests for the RAG Buddy surface event emitters (task 0267).
 *
 * Verifies:
 *  - each flow emits the canonical type with the spec-mapped `intent` and
 *    `surfaceScope:'rag'`;
 *  - emission is fire-and-forget: a synchronous throw from the underlying bus
 *    client never propagates (so ingest/search/delete cannot break);
 *  - ingest_progress is throttled per-job, with the terminal tick always sent;
 *  - the real ingestJobManager call sites emit the mapped intent/scope and
 *    survive a throwing bus.
 */

// Mock the (task-0277-owned) emit client so we can assert call shape and
// simulate a throwing/again-throwing bus.
jest.mock('../../src/clients/buddyEventClient', () => ({
  emitBuddyEvent: jest.fn(),
}));

const { emitBuddyEvent } = require('../../src/clients/buddyEventClient');
const buddyRagEvents = require('../../src/services/buddyRagEvents');

/** Pull the opts (5th arg) of the most recent emitBuddyEvent call. */
function lastCall() {
  const calls = emitBuddyEvent.mock.calls;
  return calls[calls.length - 1];
}

beforeEach(() => {
  emitBuddyEvent.mockReset();
  emitBuddyEvent.mockImplementation(() => {}); // default: succeeds
  // Reset throttle state between tests by clearing all known buckets.
  buddyRagEvents.clearProgress('job-a');
  buddyRagEvents.clearProgress('job-b');
  buddyRagEvents.clearProgress('default');
});

describe('buddyRagEvents — intent + surfaceScope mapping', () => {
  const cases = [
    ['corpusNotReady', 'corpus_not_ready', 'warning'],
    ['indexReady', 'index_ready', 'suggesting'],
    ['ingestStart', 'ingest_start', 'watching'],
    ['ingestDone', 'ingest_done', 'suggesting'],
    ['ingestFailed', 'ingest_failed', 'warning'],
    ['searchEmpty', 'search_empty', 'suggesting'],
    ['searchFailed', 'search_failed', 'warning'],
  ];

  it.each(cases)('%s emits type=%s with the mapped intent + surfaceScope:rag', (fn, type, intent) => {
    buddyRagEvents[fn]('summary text');

    expect(emitBuddyEvent).toHaveBeenCalledTimes(1);
    const [emittedType, eventClass, summary, significance, opts] = lastCall();
    expect(emittedType).toBe(type);
    expect(eventClass).toBe('data');
    expect(summary).toBe('summary text');
    expect(opts).toEqual({ intent, surfaceScope: 'rag' });
    // warnings ride at high significance, everything else normal
    expect(significance).toBe(intent === 'warning' ? 'high' : 'normal');
  });

  // Acceptance criterion 3 (explicit, called out in the task).
  it('maps corpus_not_ready -> warning and index_ready -> suggesting', () => {
    buddyRagEvents.corpusNotReady();
    expect(lastCall()[4]).toEqual({ intent: 'warning', surfaceScope: 'rag' });

    emitBuddyEvent.mockClear();
    buddyRagEvents.indexReady();
    expect(lastCall()[4]).toEqual({ intent: 'suggesting', surfaceScope: 'rag' });
  });

  it('exposes the full canonical intent map', () => {
    expect(buddyRagEvents.INTENT_BY_TYPE).toEqual({
      corpus_not_ready: 'warning',
      index_ready: 'suggesting',
      ingest_start: 'watching',
      ingest_progress: 'watching',
      ingest_done: 'suggesting',
      ingest_failed: 'warning',
      search_empty: 'suggesting',
      search_failed: 'warning',
    });
  });

  it('refuses to emit an unmapped type (no guessed intent)', () => {
    buddyRagEvents.emit('totally_unknown_type', 'x');
    expect(emitBuddyEvent).not.toHaveBeenCalled();
  });
});

describe('buddyRagEvents — fire-and-forget safety (never blocks)', () => {
  it('does not throw when the bus client throws synchronously', () => {
    emitBuddyEvent.mockImplementation(() => {
      throw new Error('bus exploded');
    });

    // Every public emitter must swallow the throw.
    expect(() => buddyRagEvents.corpusNotReady()).not.toThrow();
    expect(() => buddyRagEvents.indexReady()).not.toThrow();
    expect(() => buddyRagEvents.ingestStart()).not.toThrow();
    expect(() => buddyRagEvents.ingestDone()).not.toThrow();
    expect(() => buddyRagEvents.ingestFailed()).not.toThrow();
    expect(() => buddyRagEvents.searchEmpty()).not.toThrow();
    expect(() => buddyRagEvents.searchFailed()).not.toThrow();
    expect(() => buddyRagEvents.ingestProgress('job-a', { processed: 1, total: 10 })).not.toThrow();
  });

  it('keeps swallowing when the bus throws again (repeated failures)', () => {
    emitBuddyEvent.mockImplementation(() => {
      throw new Error('bus still down');
    });
    expect(() => buddyRagEvents.ingestStart()).not.toThrow();
    expect(() => buddyRagEvents.ingestFailed()).not.toThrow();
    // The flow saw two emit attempts; both were absorbed.
    expect(emitBuddyEvent).toHaveBeenCalledTimes(2);
  });
});

describe('buddyRagEvents — ingest_progress throttling', () => {
  it('throttles rapid progress emits within the window but always emits terminal', () => {
    const realNow = Date.now;
    let t = 1_000_000;
    Date.now = () => t;
    try {
      // First emit always goes through.
      buddyRagEvents.ingestProgress('job-b', { processed: 1, total: 100 });
      expect(emitBuddyEvent).toHaveBeenCalledTimes(1);

      // Immediately again -> throttled (within window).
      buddyRagEvents.ingestProgress('job-b', { processed: 2, total: 100 });
      expect(emitBuddyEvent).toHaveBeenCalledTimes(1);

      // Advance past the throttle window -> emits.
      t += buddyRagEvents.PROGRESS_THROTTLE_MS + 1;
      buddyRagEvents.ingestProgress('job-b', { processed: 50, total: 100 });
      expect(emitBuddyEvent).toHaveBeenCalledTimes(2);

      // Terminal tick bypasses the throttle even within the window.
      buddyRagEvents.ingestProgress('job-b', { processed: 100, total: 100 });
      expect(emitBuddyEvent).toHaveBeenCalledTimes(3);
      expect(lastCall()[0]).toBe('ingest_progress');
      expect(lastCall()[4]).toEqual({ intent: 'watching', surfaceScope: 'rag' });
    } finally {
      Date.now = realNow;
    }
  });
});

describe('ingestJobManager call sites — emit mapped events and survive a throwing bus', () => {
  let jobManager;

  beforeEach(() => {
    jest.resetModules();
    jest.doMock('../../src/clients/buddyEventClient', () => ({ emitBuddyEvent }));
    emitBuddyEvent.mockReset();
    emitBuddyEvent.mockImplementation(() => {});
    // eslint-disable-next-line global-require
    jobManager = require('../../src/services/ingestJobManager');
    jobManager._reset();
  });

  function typesEmitted() {
    return emitBuddyEvent.mock.calls.map((c) => c[0]);
  }
  function optsFor(type) {
    const call = emitBuddyEvent.mock.calls.find((c) => c[0] === type);
    return call && call[4];
  }

  it('createJob -> ingest_start (watching/rag), completeJob -> ingest_done (suggesting/rag)', () => {
    const { jobId } = jobManager.createJob({ limit: 1 });
    jobManager.completeJob(jobId, { processed: 3, errors: 0 });

    expect(typesEmitted()).toEqual(expect.arrayContaining(['ingest_start', 'ingest_done']));
    expect(optsFor('ingest_start')).toEqual({ intent: 'watching', surfaceScope: 'rag' });
    expect(optsFor('ingest_done')).toEqual({ intent: 'suggesting', surfaceScope: 'rag' });
  });

  it('failJob -> ingest_failed (warning/rag)', () => {
    const { jobId } = jobManager.createJob();
    jobManager.failJob(jobId, 'embedding service down');

    expect(optsFor('ingest_failed')).toEqual({ intent: 'warning', surfaceScope: 'rag' });
  });

  it('a throwing bus does not break the job lifecycle (non-blocking contract)', () => {
    emitBuddyEvent.mockImplementation(() => {
      throw new Error('bus down');
    });

    let result;
    expect(() => {
      result = jobManager.createJob({ limit: 1 });
      jobManager.updateProgress(result.jobId, { processed: 1, total: 1, errors: 0 });
      jobManager.completeJob(result.jobId, { processed: 1, errors: 0 });
    }).not.toThrow();

    // The job still transitioned correctly despite the bus throwing.
    const job = jobManager.getJob(result.jobId);
    expect(job.status).toBe('completed');
    expect(jobManager.isRunning()).toBe(false);
  });
});
