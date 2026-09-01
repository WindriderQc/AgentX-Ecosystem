'use strict';

const express = require('express');
const request = require('supertest');

jest.mock('../../src/services/llmEffectivenessService', () => ({
  readEffectivenessSnapshot: jest.fn(),
  upsertOutcome: jest.fn(),
}));

const service = require('../../src/services/llmEffectivenessService');
const router = require('../../routes/analytics-effectiveness');

function app() {
  const instance = express();
  instance.use(express.json());
  instance.use('/api/analytics', router);
  return instance;
}

describe('analytics effectiveness API', () => {
  beforeEach(() => jest.clearAllMocks());

  test('returns the source-separated effectiveness snapshot', async () => {
    service.readEffectivenessSnapshot.mockResolvedValue({ ok: true, summary: { productiveOutcomes: 3 } });
    const response = await request(app()).get('/api/analytics/effectiveness?window=7d&runtime=external');
    expect(response.status).toBe(200);
    expect(response.body.summary.productiveOutcomes).toBe(3);
    expect(service.readEffectivenessSnapshot).toHaveBeenCalledWith({
      window: '7d', from: undefined, to: undefined, runtime: 'external', consumerContract: undefined,
    });
  });

  test('passes an exact half-open interval to the effectiveness authority', async () => {
    service.readEffectivenessSnapshot.mockResolvedValue({
      ok: true,
      window: {
        key: 'exact',
        from: '2026-08-30T04:00:00.000Z',
        to: '2026-08-31T04:00:00.000Z',
        endExclusive: true,
      },
    });
    const response = await request(app()).get(
      '/api/analytics/effectiveness?from=2026-08-30T00%3A00%3A00-04%3A00&to=2026-08-31T00%3A00%3A00-04%3A00&runtime=external&consumerContract=openclaw-pipeline-runtime-v1'
    );
    expect(response.status).toBe(200);
    expect(service.readEffectivenessSnapshot).toHaveBeenCalledWith({
      window: undefined,
      from: '2026-08-30T00:00:00-04:00',
      to: '2026-08-31T00:00:00-04:00',
      runtime: 'external',
      consumerContract: 'openclaw-pipeline-runtime-v1',
    });
  });

  test('returns bounded validation failures as 400', async () => {
    const error = new Error('from and to must be supplied together');
    error.status = 400;
    error.code = 'INVALID_EFFECTIVENESS_WINDOW';
    service.readEffectivenessSnapshot.mockRejectedValue(error);
    const response = await request(app()).get(
      '/api/analytics/effectiveness?from=2026-08-30T00%3A00%3A00-04%3A00'
    );
    expect(response.status).toBe(400);
    expect(response.body.code).toBe('INVALID_EFFECTIVENESS_WINDOW');
    expect(service.readEffectivenessSnapshot).toHaveBeenCalledTimes(1);
  });

  test('rejects an unknown runtime before querying storage', async () => {
    const response = await request(app()).get('/api/analytics/effectiveness?runtime=everything');
    expect(response.status).toBe(400);
    expect(service.readEffectivenessSnapshot).not.toHaveBeenCalled();
  });

  test('upserts idempotent outcome reports', async () => {
    service.upsertOutcome.mockResolvedValue({ outcomeId: 'deploy:1', runtime: 'agentx' });
    const payload = { outcomeId: 'deploy:1', runtime: 'agentx', verdict: 'success' };
    const response = await request(app()).post('/api/analytics/effectiveness/outcomes').send(payload);
    expect(response.status).toBe(201);
    expect(response.body.outcome.outcomeId).toBe('deploy:1');
    expect(service.upsertOutcome).toHaveBeenCalledWith(payload);
  });
});
