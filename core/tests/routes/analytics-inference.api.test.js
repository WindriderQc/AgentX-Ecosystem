'use strict';

const express = require('express');
const request = require('supertest');

jest.mock('../../models/InferenceLog', () => ({ aggregate: jest.fn() }));
jest.mock('../../src/services/costCalculator', () => ({
  resolvePricing: jest.fn()
}));

const InferenceLog = require('../../models/InferenceLog');
const { resolvePricing } = require('../../src/services/costCalculator');
const router = require('../../routes/analytics-inference');

function app() {
  const instance = express();
  instance.use(express.json());
  instance.use('/api/analytics/inference', router);
  return instance;
}

const facet = (over = {}) => [{
  totals: [{ calls: 100, errors: 5, tokensIn: 1000, tokensOut: 500, durationMs: 50000, fallbacks: 2 }],
  byModel: [],
  byCaller: [],
  byRuntime: [],
  byHost: [],
  byDay: [],
  byDayCaller: [],
  topErrors: [],
  ...over
}];

describe('inference analytics summary', () => {
  beforeEach(() => jest.clearAllMocks());

  test('returns a single-level envelope the client can read directly', async () => {
    InferenceLog.aggregate.mockResolvedValue(facet());
    const res = await request(app()).get('/api/analytics/inference/summary?window=7d');

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    // Guards the double-wrap defect this work fixed elsewhere: data must hold
    // the payload, never another {status, data} envelope.
    expect(res.body.data.data).toBeUndefined();
    expect(res.body.data.totals.calls).toBe(100);
    expect(res.body.data.totals.errorRate).toBe(5);
    expect(res.body.data.source).toBe('inferencelogs');
  });

  test('falls back to a 7d window for an unknown window key', async () => {
    InferenceLog.aggregate.mockResolvedValue(facet());
    const res = await request(app()).get('/api/analytics/inference/summary?window=nonsense');
    expect(res.body.data.window.key).toBe('7d');
  });

  test('reports local models with a null cost rather than a fabricated $0', async () => {
    InferenceLog.aggregate.mockResolvedValue(facet({
      byModel: [{
        _id: 'ax/gemma4:e4b', calls: 10, errors: 0, tokensIn: 100,
        tokensOut: 200, durationMs: 2000, fallbacks: 0, hosts: ['http://192.0.2.199:11434']
      }]
    }));

    const res = await request(app()).get('/api/analytics/inference/summary');
    const model = res.body.data.byModel[0];

    expect(model.isCloud).toBe(false);
    expect(model.estimatedCostUsd).toBeNull();
    // An Ollama namespace must never be mistaken for a cloud provider.
    expect(resolvePricing).not.toHaveBeenCalled();
    expect(res.body.data.local.calls).toBe(10);
    expect(res.body.data.cloud.calls).toBe(0);
  });

  test('prices cloud models from resolved rates', async () => {
    resolvePricing.mockResolvedValue({ promptTokenCost: 1, completionTokenCost: 3 });
    InferenceLog.aggregate.mockResolvedValue(facet({
      byModel: [{
        _id: 'openrouter/z-ai/glm-5.2', calls: 5, errors: 0,
        tokensIn: 1_000_000, tokensOut: 1_000_000, durationMs: 5000, fallbacks: 0, hosts: []
      }]
    }));

    const res = await request(app()).get('/api/analytics/inference/summary');
    const model = res.body.data.byModel[0];

    expect(model.isCloud).toBe(true);
    expect(resolvePricing).toHaveBeenCalledWith('openrouter', 'z-ai/glm-5.2');
    expect(model.estimatedCostUsd).toBeCloseTo(4, 5);
    expect(res.body.data.cloud.estimatedCostUsd).toBeCloseTo(4, 4);
  });

  test('marks a cloud model unpriced instead of counting it as free', async () => {
    resolvePricing.mockResolvedValue({ promptTokenCost: 0, completionTokenCost: 0 });
    InferenceLog.aggregate.mockResolvedValue(facet({
      byModel: [{
        _id: 'openrouter/some-new-model', calls: 3, errors: 0,
        tokensIn: 10, tokensOut: 10, durationMs: 100, fallbacks: 0, hosts: []
      }]
    }));

    const res = await request(app()).get('/api/analytics/inference/summary');
    expect(res.body.data.byModel[0].estimatedCostUsd).toBeNull();
    expect(res.body.data.cloud.estimatedCostUsd).toBeNull();
    expect(res.body.data.cloud.unpricedModels).toEqual(['openrouter/some-new-model']);
  });

  test('classifies an OpenRouter-served model as cloud by its host', async () => {
    // z-ai/glm-5.2 carries the MODEL vendor as its prefix, not the biller.
    // A prefix-only test filed real OpenRouter spend as local and showed $0.
    resolvePricing.mockResolvedValue({ promptTokenCost: 2, completionTokenCost: 2 });
    InferenceLog.aggregate.mockResolvedValue(facet({
      byModel: [{
        _id: 'z-ai/glm-5.2', calls: 5, errors: 0, tokensIn: 500_000,
        tokensOut: 500_000, durationMs: 70000, fallbacks: 0,
        hosts: ['https://openrouter.ai/api/v1']
      }]
    }));

    const res = await request(app()).get('/api/analytics/inference/summary');
    const model = res.body.data.byModel[0];

    expect(model.isCloud).toBe(true);
    expect(model.estimatedCostUsd).toBeCloseTo(2, 5);
    expect(res.body.data.cloud.calls).toBe(5);
    expect(res.body.data.local.calls).toBe(0);
  });

  test('keeps a LAN-hosted namespaced model local', async () => {
    InferenceLog.aggregate.mockResolvedValue(facet({
      byModel: [{
        _id: 'qllama/bge-m3:f16', calls: 7, errors: 0, tokensIn: 10,
        tokensOut: 0, durationMs: 500, fallbacks: 0,
        hosts: ['http://192.0.2.12:11434']
      }]
    }));

    const res = await request(app()).get('/api/analytics/inference/summary');
    expect(res.body.data.byModel[0].isCloud).toBe(false);
    expect(res.body.data.local.calls).toBe(7);
  });

  test('computes generation throughput from time actually spent', async () => {
    InferenceLog.aggregate.mockResolvedValue(facet({
      byModel: [{
        _id: 'qwen3-coder:30b', calls: 2, errors: 0, tokensIn: 0,
        tokensOut: 600, durationMs: 20000, fallbacks: 0, hosts: []
      }]
    }));

    const res = await request(app()).get('/api/analytics/inference/summary');
    expect(res.body.data.byModel[0].tokensOutPerSecond).toBe(30);
    expect(res.body.data.byModel[0].avgLatencyMs).toBe(10000);
  });

  test('survives an empty collection without dividing by zero', async () => {
    InferenceLog.aggregate.mockResolvedValue([{
      totals: [], byModel: [], byCaller: [], byRuntime: [],
      byHost: [], byDay: [], byDayCaller: [], topErrors: []
    }]);

    const res = await request(app()).get('/api/analytics/inference/summary');
    expect(res.status).toBe(200);
    expect(res.body.data.totals.calls).toBe(0);
    expect(res.body.data.totals.errorRate).toBe(0);
    expect(res.body.data.totals.tokensOutPerSecond).toBe(0);
  });
});
