'use strict';

jest.mock('../../config/logger', () => ({ warn: jest.fn(), error: jest.fn(), info: jest.fn() }));

const {
  normalizeTrace,
  summarizeTraces,
  reconcileSustainedAlert,
  SLOS
} = require('../../src/services/voiceObservabilityService');

function trace(overrides = {}) {
  return {
    traceId: `trace-${Math.random()}`,
    observedAt: new Date('2026-08-01T00:00:00Z'),
    status: 'success',
    surface: 'surface-panel',
    lane: 'front_door',
    model: 'ollama/ax/gemma4:26b-a4b-it-qat',
    host: 'http://192.0.2.199:11434',
    fallbackUsed: false,
    stt: { provider: 'voix', model: 'small' },
    tts: { provider: 'voix', model: 'kokoro' },
    timings: {
      sttMs: 900,
      firstTokenMs: 2200,
      firstPhraseMs: 2600,
      firstAudioMs: 3100,
      brainMs: 5000,
      ttsRtf: 0.3,
      interSentenceGapMs: 30,
      totalTurnMs: 9000
    },
    sloViolations: [],
    ...overrides
  };
}

function queryReturning(rows) {
  return {
    sort: jest.fn().mockReturnThis(),
    limit: jest.fn().mockReturnThis(),
    lean: jest.fn(async () => rows)
  };
}

describe('voiceObservabilityService', () => {
  test('normalizes only bounded metadata and never retains message content', () => {
    const normalized = normalizeTrace({
      traceId: 'abc',
      status: 'success',
      surface: 'surface-panel',
      transcript: 'private transcript',
      reply: 'private reply',
      rawAudio: 'not allowed',
      fallback: { reason: 'EXTERNAL_RUNTIME_DOWN' },
      timings: { firstSentenceMs: 1234, totalTurnMs: 9999999 }
    });

    expect(normalized).not.toHaveProperty('transcript');
    expect(normalized).not.toHaveProperty('reply');
    expect(normalized).not.toHaveProperty('rawAudio');
    expect(normalized.timings.firstPhraseMs).toBe(1234);
    expect(normalized.timings.totalTurnMs).toBe(600000);
    expect(normalized.fallbackUsed).toBe(true);
    expect(normalized.sloViolations).toEqual(expect.arrayContaining(['totalTurnMs', 'fallback']));
  });

  test('rejects an invalid status instead of filing it as success', () => {
    expect(() => normalizeTrace({ traceId: 'bad-status', status: 'unknown' }))
      .toThrow('status must be success, error, or cancelled');
  });

  test('keeps a measured zero distinct from an unavailable metric', () => {
    const summary = summarizeTraces([
      trace({ timings: { interSentenceGapMs: 0 } })
    ], { key: '24h' });

    expect(summary.status).toBe('healthy');
    expect(summary.metrics.interSentenceGapMs).toEqual(expect.objectContaining({
      sampleSize: 1,
      p50: 0,
      p95: 0,
      status: 'healthy'
    }));
    expect(summary.metrics.firstAudioMs).toEqual(expect.objectContaining({
      sampleSize: 0,
      p50: null,
      p95: null,
      status: 'unavailable'
    }));
  });

  test('reports idle rather than fabricated zeros when there are no traces', () => {
    const summary = summarizeTraces([], { key: '24h' });
    expect(summary.status).toBe('idle');
    expect(summary.sampleSize).toBe(0);
    expect(summary.rates.errors.ratePct).toBeNull();
    expect(summary.metrics.firstAudioMs.status).toBe('unavailable');
  });

  test('segments route evidence and marks a p95 SLO breach degraded', () => {
    const summary = summarizeTraces([
      trace(),
      trace({ timings: { ...trace().timings, firstAudioMs: SLOS.firstAudioMs.target + 1 } })
    ], { key: '24h' });

    expect(summary.status).toBe('degraded');
    expect(summary.metrics.firstAudioMs.status).toBe('degraded');
    expect(summary.segments).toEqual([
      expect.objectContaining({
        surface: 'surface-panel',
        lane: 'front_door',
        samples: 2,
        successRatePct: 100
      })
    ]);
  });

  test('opens one alert only after three of five recent turns are unhealthy', async () => {
    const recent = [
      trace({ status: 'error', sloViolations: ['error'] }),
      trace({ sloViolations: ['firstAudioMs'] }),
      trace({ fallbackUsed: true, sloViolations: ['fallback'] }),
      trace(),
      trace()
    ];
    const TraceModel = { find: jest.fn(() => queryReturning(recent)) };
    const AlertModel = {
      findOneAndUpdate: jest.fn(async () => null),
      create: jest.fn(async (row) => ({ _id: 'alert-1', ...row })),
      updateMany: jest.fn()
    };

    const result = await reconcileSustainedAlert('surface-panel', { TraceModel, AlertModel });

    expect(result).toEqual(expect.objectContaining({ state: 'active', deduplicated: false }));
    expect(AlertModel.create).toHaveBeenCalledTimes(1);
    expect(AlertModel.create.mock.calls[0][0]).toEqual(expect.objectContaining({
      ruleId: 'voice-turn-slo-sustained',
      severity: 'warning'
    }));
  });

  test('three healthy turns resolve the active incident', async () => {
    const TraceModel = { find: jest.fn(() => queryReturning([trace(), trace(), trace()])) };
    const AlertModel = {
      updateMany: jest.fn(async () => ({ modifiedCount: 1 })),
      findOneAndUpdate: jest.fn(),
      create: jest.fn()
    };

    const result = await reconcileSustainedAlert('surface-panel', { TraceModel, AlertModel });

    expect(result).toEqual({ state: 'healthy', resolved: 1 });
    expect(AlertModel.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ status: { $in: ['active', 'acknowledged'] } }),
      expect.objectContaining({ $set: expect.objectContaining({ status: 'resolved' }) })
    );
    expect(AlertModel.create).not.toHaveBeenCalled();
  });

  test('normal user cancellations do not create a reliability incident', async () => {
    const cancelled = Array.from({ length: 5 }, () => trace({ status: 'cancelled' }));
    const TraceModel = { find: jest.fn(() => queryReturning(cancelled)) };
    const AlertModel = {
      updateMany: jest.fn(async () => ({ modifiedCount: 0 })),
      findOneAndUpdate: jest.fn(),
      create: jest.fn()
    };

    const result = await reconcileSustainedAlert('surface-panel', { TraceModel, AlertModel });

    expect(result.state).toBe('healthy');
    expect(AlertModel.create).not.toHaveBeenCalled();
  });
});
