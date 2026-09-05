'use strict';

const express = require('express');
const request = require('supertest');

jest.mock('../../../src/services/benchmark/sweepCoordinator', () => ({ buildSweepPlan: jest.fn() }));
jest.mock('../../../src/services/benchmark/sweepRunner', () => ({ runSweep: jest.fn() }));
jest.mock('../../../src/services/benchmark/stalenessCrawler', () => ({
  analyzeStaleness: jest.fn(),
  formatStalenessLedgerEntry: jest.fn(() => 'staleness ledger')
}));
jest.mock('../../../src/services/benchmark/intakeScanner', () => ({
  gatherCandidates: jest.fn(),
  formatIntakeTable: jest.fn(() => 'intake table')
}));
jest.mock('../../../src/clients/hfClient', () => ({ fetchFamily: jest.fn() }));
jest.mock('../../../models/ModelContextProfile', () => ({ find: jest.fn() }));
jest.mock('../../../models/ModelProfile', () => ({ find: jest.fn() }));
jest.mock('../../../models/ModelPerformanceProfile', () => ({ find: jest.fn() }));
jest.mock('../../../models/BenchmarkBatch', () => ({ getActive: jest.fn() }));
jest.mock('../../../src/services/benchmark/execution', () => ({ startBatch: jest.fn() }));
jest.mock('../../../src/services/benchmark/preflight', () => ({ runPreflight: jest.fn() }));
jest.mock('../../../src/services/profiler/activeProfileState', () => ({
  findActiveProfilingForHost: jest.fn(),
  activeProfileQueues: new Map()
}));
jest.mock('../../../routes/profiler/pipeline', () => ({ startProfileHostQueue: jest.fn() }));
jest.mock('../../../src/services/benchmark/judgeReadiness', () => ({
  resolveReadyJudgeTarget: jest.fn(),
  judgeUnavailablePayload: jest.fn((readiness, action) => ({
    status: 'error',
    code: 'JUDGE_NOT_READY',
    error: `${action} unavailable: ${readiness.error}`
  }))
}));
jest.mock('../../../config/logger', () => ({
  warn: jest.fn(),
  error: jest.fn()
}));

const { runSweep } = require('../../../src/services/benchmark/sweepRunner');
const { analyzeStaleness } = require('../../../src/services/benchmark/stalenessCrawler');
const { gatherCandidates } = require('../../../src/services/benchmark/intakeScanner');
const ModelContextProfile = require('../../../models/ModelContextProfile');
const ModelProfile = require('../../../models/ModelProfile');
const ModelPerformanceProfile = require('../../../models/ModelPerformanceProfile');
const { startProfileHostQueue } = require('../../../routes/profiler/pipeline');
const { resolveReadyJudgeTarget } = require('../../../src/services/benchmark/judgeReadiness');
const sweepsRouter = require('../../../routes/benchmark/sweeps');

function queryResult(value) {
  const query = {
    select: jest.fn(() => query),
    lean: jest.fn(async () => value)
  };
  return query;
}

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/benchmark', sweepsRouter);
  return app;
}

describe('sweeps HTTP contract', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    resolveReadyJudgeTarget.mockResolvedValue({
      ready: true,
      code: 'ready',
      target: { host: 'http://judge:11434', model: 'judge:7b', source: 'fixture' },
      readiness: { ready: true }
    });
  });

  it('wires the profile executor into /run, making deferred needs_profile mode unreachable', async () => {
    startProfileHostQueue.mockResolvedValue({ queueId: 'queue-1' });
    runSweep.mockImplementation(async (input, deps) => {
      expect(input.execute).toBe(true);
      expect(input.judge_config).toEqual({ host: 'http://judge:11434', model: 'judge:7b' });
      expect(typeof deps.startProfileQueue).toBe('function');
      await expect(deps.startProfileQueue({ hostId: 'host-a' })).resolves.toEqual({ queueId: 'queue-1' });
      return { phase: 'profiling', executed: true, queueId: 'queue-1' };
    });

    const response = await request(buildApp())
      .post('/api/benchmark/sweeps/run')
      .send({ hostId: 'host-a', candidates: ['owner/model:q4_K_M'], execute: true })
      .expect(200);

    expect(response.body.data).toMatchObject({ phase: 'profiling', executed: true, queueId: 'queue-1' });
    expect(resolveReadyJudgeTarget).toHaveBeenCalledWith({ host: undefined, model: undefined });
    expect(startProfileHostQueue).toHaveBeenCalledWith({ hostId: 'host-a' });
  });

  it('keeps /intake metadata-only by omitting host-fit inputs', async () => {
    gatherCandidates.mockResolvedValue([{
      model: 'owner/model',
      vramFitByHost: {},
      suggestedHost: null,
      expectedLane: null,
      priority: 'high'
    }]);

    const response = await request(buildApp())
      .get('/api/benchmark/sweeps/intake')
      .query({ families: 'qwen,gemma', limit: 10 })
      .expect(200);

    const args = gatherCandidates.mock.calls[0][0];
    expect(args).not.toHaveProperty('hostsVram');
    expect(args).not.toHaveProperty('numCtx');
    expect(response.body.data.records[0]).toMatchObject({
      vramFitByHost: {},
      suggestedHost: null,
      expectedLane: null
    });
  });

  it('maps a missing candidate model identity to a 400 recommendation error', async () => {
    const response = await request(buildApp())
      .post('/api/benchmark/sweeps/recommend')
      .send({ lane: 'daily', candidates: [{ composite: 90, latencyMs: 1000, failures: 0 }] })
      .expect(400);

    expect(response.body).toMatchObject({ status: 'error' });
    expect(response.body.error).toMatch(/candidates\[0\]\.model is required/);
  });

  it('maps malformed ledger options to a 400 recommendation error', async () => {
    const response = await request(buildApp())
      .post('/api/benchmark/sweeps/recommend')
      .send({
        lane: 'lightweight',
        incumbent: 'incumbent',
        candidates: [
          { model: 'challenger', quality: 9, composite: 90, tokensPerSec: 60, latencyMs: 1000, failures: 0 },
          { model: 'incumbent', quality: 8, composite: 80, tokensPerSec: 50, latencyMs: 1000, failures: 0 }
        ],
        ledger: { evidenceRefs: { length: 1 } }
      })
      .expect(400);

    expect(response.body).toMatchObject({ status: 'error' });
    expect(response.body.error).toMatch(/ledger\.evidenceRefs must be an array of strings/);
  });

  it('downgrades caller-owned promotion metrics to an unqualified observation', async () => {
    const response = await request(buildApp())
      .post('/api/benchmark/sweeps/recommend')
      .send({
        lane: 'lightweight',
        incumbent: 'incumbent',
        candidates: [
          { model: 'challenger', quality: 9, composite: 95, tokensPerSec: 80, latencyMs: 900, failures: 0 },
          { model: 'incumbent', quality: 7, composite: 75, tokensPerSec: 40, latencyMs: 1000, failures: 0 }
        ]
      })
      .expect(200);

    expect(response.body.data).toMatchObject({
      winner: 'challenger',
      winnerMeaning: 'top_lane_score_observation',
      qualifiedWinner: null,
      recommendation: 'inconclusive',
      trustVerdict: {
        contract: 'agentx.benchmark-consumer-trust/v1',
        qualified: false,
        highConfidenceAllowed: false,
        claim: 'top_exploratory_observation',
        qualifiedWinner: null
      }
    });
    expect(response.body.data.reasons).toEqual(expect.arrayContaining([
      expect.stringMatching(/trust receipt and ratification are required/i)
    ]));
    expect(response.body.data.summary).toContain('top observation challenger');
    expect(response.body.data.summary).not.toContain('incumbent -> challenger');
    expect(response.body.data.ledgerDraft).toContain('inconclusive (no change)');
    expect(response.body.data.ledgerDraft).toContain('top observation `challenger`');
    expect(response.body.data.ledgerDraft).not.toContain('winner `challenger`');
    expect(response.body.data.ledgerDraft).not.toContain('→ challenger');
  });

  it('parses URL-encoded routedModelsByHost only when the staleness caller supplies it', async () => {
    ModelContextProfile.find.mockReturnValue(queryResult([]));
    ModelProfile.find.mockReturnValue(queryResult([]));
    ModelPerformanceProfile.find.mockReturnValue(queryResult([]));
    analyzeStaleness.mockReturnValue({ hosts: {}, totals: { staleModels: 0, byReason: {} }, suggestedProfileQueues: [] });
    const routedModelsByHost = { 'host-a': ['owner/model:q4_K_M'] };

    await request(buildApp())
      .get('/api/benchmark/sweeps/staleness')
      .query({ hostId: 'host-a', routedModelsByHost: JSON.stringify(routedModelsByHost) })
      .expect(200);

    expect(analyzeStaleness).toHaveBeenCalledWith(expect.objectContaining({
      hostFilter: 'host-a',
      routedModelsByHost
    }));
  });
});
