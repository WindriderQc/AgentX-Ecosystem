'use strict';

/**
 * Retrieval search telemetry: every /search writes one bounded event
 * (no query text, no passages), and the summary reports evidence under the
 * Signal Evidence Contract instead of bare zeros.
 */

jest.mock('mongoose', () => ({
  connection: { readyState: 1 },
  Schema: class { constructor() {} index() {} },
  model: jest.fn(() => ({ create: jest.fn().mockResolvedValue({}), aggregate: jest.fn(), findOne: jest.fn() }))
}));
jest.mock('../../models/SearchEvent', () => ({
  create: jest.fn().mockResolvedValue({}),
  aggregate: jest.fn(),
  findOne: jest.fn()
}));
jest.mock('../../src/services/ragStore', () => ({
  getRagStore: jest.fn()
}));
jest.mock('../../src/services/buddyRagEvents', () => ({
  searchEmpty: jest.fn(), searchFailed: jest.fn(), ingestStart: jest.fn(), ingestDone: jest.fn(), ingestFailed: jest.fn()
}));

const express = require('express');
const request = require('supertest');
const SearchEvent = require('../../models/SearchEvent');
const { getRagStore } = require('../../src/services/ragStore');
const { validateSignal } = require('../../../shared/signalEvidence');

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/rag', require('../../routes/rag'));
  app.use('/api/rag', require('../../routes/telemetry.routes'));
  return app;
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

describe('POST /api/rag/search telemetry', () => {
  beforeEach(() => jest.clearAllMocks());

  it('records a bounded success event without the query text or passages', async () => {
    const secretQuery = 'PUBLIC_EXPOSURE_GUARD private question';
    getRagStore.mockReturnValue({
      searchSimilarChunks: jest.fn().mockResolvedValue([
        { text: 'secret passage one', score: 0.81, metadata: { source: 'nestor' } },
        { text: 'secret passage two', score: 0.42 }
      ])
    });

    const res = await request(buildApp()).post('/api/rag/search').send({ query: secretQuery, topK: 5, hybrid: true, filters: { source: 'x' } });
    await flush();

    expect(res.status).toBe(200);
    expect(SearchEvent.create).toHaveBeenCalledTimes(1);
    const event = SearchEvent.create.mock.calls[0][0];
    expect(event).toMatchObject({
      surface: 'api', status: 'success', queryLength: secretQuery.length, topK: 5,
      filterCount: 1, hybrid: true, rerank: false, resultCount: 2, topScore: 0.81
    });
    expect(typeof event.eventId).toBe('string');
    expect(event.durationMs).toBeGreaterThanOrEqual(0);
    const serialized = JSON.stringify(event);
    expect(serialized).not.toContain('PUBLIC_EXPOSURE_GUARD');
    expect(serialized).not.toContain('secret passage');
  });

  it('records an empty event when nothing matched and a failed event when the store throws', async () => {
    getRagStore.mockReturnValue({ searchSimilarChunks: jest.fn().mockResolvedValue([]) });
    await request(buildApp()).post('/api/rag/search').send({ query: 'nothing here' });
    await flush();
    expect(SearchEvent.create.mock.calls[0][0]).toMatchObject({ status: 'empty', resultCount: 0 });

    getRagStore.mockReturnValue({ searchSimilarChunks: jest.fn().mockRejectedValue(new Error('qdrant unavailable')) });
    const res = await request(buildApp()).post('/api/rag/search').send({ query: 'boom' });
    await flush();
    expect(res.status).toBeGreaterThanOrEqual(500);
    expect(SearchEvent.create.mock.calls[1][0]).toMatchObject({ status: 'failed' });
    expect(JSON.stringify(SearchEvent.create.mock.calls[1][0])).not.toContain('boom');
  });

  it('never fails a search because telemetry failed', async () => {
    SearchEvent.create.mockRejectedValueOnce(new Error('mongo down'));
    getRagStore.mockReturnValue({ searchSimilarChunks: jest.fn().mockResolvedValue([{ text: 'a', score: 0.9 }]) });
    const res = await request(buildApp()).post('/api/rag/search').send({ query: 'still works' });
    await flush();
    expect(res.status).toBe(200);
    expect(res.body.data.count).toBe(1);
  });
});

describe('GET /api/rag/telemetry/search/summary', () => {
  beforeEach(() => jest.clearAllMocks());

  const findOne = (doc) => ({ sort: () => ({ select: () => ({ lean: async () => doc }) }) });

  it('reports not-observed evidence when nothing was ever searched', async () => {
    SearchEvent.aggregate.mockResolvedValue([]);
    SearchEvent.findOne.mockReturnValue(findOne(null));

    const res = await request(buildApp()).get('/api/rag/telemetry/search/summary?window=7d');
    expect(res.status).toBe(200);
    const { totals, signals, lastSearchAt } = res.body.data;
    expect(totals.searches).toBe(0);
    expect(lastSearchAt).toBeNull();
    for (const signal of Object.values(signals)) expect(validateSignal(signal)).toEqual({ ok: true, errors: [] });
    expect(signals.searches).toMatchObject({ state: 'observed', value: 0, kind: 'count' });
    expect(signals.emptyRate).toMatchObject({ state: 'missing', value: null, reason: 'no_searches' });
    expect(signals.avgDurationMs).toMatchObject({ state: 'missing', value: null });
    expect(signals.lastSearch).toMatchObject({ state: 'missing', reason: 'never_searched' });
    expect(signals.lastSearch.freshness.state).toBe('unknown');
  });

  it('flags a thin sample and computes rates on a real denominator', async () => {
    SearchEvent.aggregate.mockResolvedValue([{ searches: 3, empty: 2, failed: 0, durationMs: 210, timed: 3, resultCount: 5, answered: 1, hybrid: 1, rerank: 0 }]);
    const recent = new Date(Date.now() - 60_000);
    SearchEvent.findOne.mockReturnValue(findOne({ createdAt: recent }));

    const res = await request(buildApp()).get('/api/rag/telemetry/search/summary?window=24h');
    const { signals } = res.body.data;
    expect(signals.emptyRate).toMatchObject({ state: 'insufficient_sample', sample: { n: 3, minimum: 5 } });
    expect(signals.emptyRate.value).toBeCloseTo(66.67, 1);
    expect(signals.avgDurationMs).toMatchObject({ state: 'observed', value: 70 });
    expect(signals.avgResultsPerAnsweredSearch).toMatchObject({ state: 'observed', value: 5 });
    expect(signals.lastSearch).toMatchObject({ state: 'observed' });
    expect(signals.lastSearch.freshness).toMatchObject({ state: 'fresh', observedAt: recent.toISOString() });
    expect(JSON.stringify(signals)).not.toMatch(/https?:\/\//);
  });
});
