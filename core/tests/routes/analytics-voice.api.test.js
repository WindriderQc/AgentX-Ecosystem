'use strict';

const express = require('express');
const request = require('supertest');

jest.mock('../../config/logger', () => ({ error: jest.fn(), warn: jest.fn() }));
jest.mock('../../src/services/voiceObservabilityService', () => ({
  SLOS: { firstAudioMs: { target: 18000, unit: 'ms' } },
  getSummary: jest.fn(),
  ingestTrace: jest.fn()
}));

const voiceObservability = require('../../src/services/voiceObservabilityService');
const router = require('../../routes/analytics-voice');

function app() {
  const instance = express();
  instance.use(express.json());
  instance.use('/api/analytics/voice', router);
  return instance;
}

describe('voice observability API', () => {
  beforeEach(() => jest.clearAllMocks());

  test('returns the compact summary in one standard envelope', async () => {
    voiceObservability.getSummary.mockResolvedValue({
      source: 'voiceturntraces', status: 'idle', sampleSize: 0
    });

    const response = await request(app()).get('/api/analytics/voice/summary?window=24h');

    expect(response.status).toBe(200);
    expect(response.body.data).toEqual(expect.objectContaining({
      source: 'voiceturntraces', status: 'idle', sampleSize: 0
    }));
    expect(voiceObservability.getSummary).toHaveBeenCalledWith({ window: '24h', surface: undefined });
  });

  test('accepts a bounded trace and returns only its status evidence', async () => {
    voiceObservability.ingestTrace.mockResolvedValue({
      trace: { traceId: 'trace-1', status: 'success', sloViolations: [] },
      alert: { state: 'insufficient-or-transient', samples: 1, failing: 0 }
    });

    const response = await request(app()).post('/api/analytics/voice/trace').send({
      traceId: 'trace-1', surface: 'surface-panel', transcript: 'must not echo'
    });

    expect(response.status).toBe(201);
    expect(response.body.data).toEqual(expect.objectContaining({ traceId: 'trace-1', status: 'success' }));
    expect(JSON.stringify(response.body)).not.toContain('must not echo');
  });

  test('preserves validation status and code', async () => {
    voiceObservability.ingestTrace.mockRejectedValue(Object.assign(new Error('traceId is required'), {
      status: 400,
      code: 'VOICE_TRACE_ID_REQUIRED'
    }));

    const response = await request(app()).post('/api/analytics/voice/trace').send({});
    expect(response.status).toBe(400);
    expect(response.body.code).toBe('VOICE_TRACE_ID_REQUIRED');
  });
});
