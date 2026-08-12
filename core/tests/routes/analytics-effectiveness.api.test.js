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
    const response = await request(app()).get('/api/analytics/effectiveness?window=7d&runtime=hermes');
    expect(response.status).toBe(200);
    expect(response.body.summary.productiveOutcomes).toBe(3);
    expect(service.readEffectivenessSnapshot).toHaveBeenCalledWith({ window: '7d', runtime: 'hermes' });
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
