'use strict';

/**
 * Corpus freshness: derived only from recorded ingest jobs and the declared
 * rule. A ready service never implies a fresh corpus; no recorded ingest is
 * unknown, never fresh.
 */

jest.mock('../../models/IngestJob', () => ({ findOne: jest.fn() }));
jest.mock('../../models/SearchEvent', () => ({ create: jest.fn(), aggregate: jest.fn(), findOne: jest.fn() }));

const IngestJob = require('../../models/IngestJob');
const { corpusFreshness, RAG_CORPUS_STALE_AFTER_MS } = require('../../routes/rag');
const { validateSignal } = require('../../../shared/signalEvidence');

const chain = (doc, error) => ({
  sort: () => ({ select: () => ({ lean: async () => { if (error) throw error; return doc; } }) })
});

describe('RAG corpus freshness', () => {
  beforeEach(() => jest.clearAllMocks());

  it('is fresh when the last successful ingest is within the rule', async () => {
    const at = new Date(Date.now() - 60 * 60 * 1000);
    IngestJob.findOne.mockReturnValue(chain({ createdAt: at, source: 'nas' }));
    const freshness = await corpusFreshness(42);
    expect(freshness).toMatchObject({
      state: 'fresh', lastIngestAt: at.toISOString(), lastIngestSource: 'nas',
      ttlMs: RAG_CORPUS_STALE_AFTER_MS, source: 'ingestjobs', reason: null
    });
    expect(validateSignal(freshness.signal).ok).toBe(true);
    expect(freshness.signal.freshness).toMatchObject({ state: 'fresh', observedAt: at.toISOString(), ttlMs: RAG_CORPUS_STALE_AFTER_MS });
    expect(IngestJob.findOne).toHaveBeenCalledWith({ status: 'success' });
  });

  it('is stale when the last successful ingest is older than the rule', async () => {
    const at = new Date(Date.now() - RAG_CORPUS_STALE_AFTER_MS - 60000);
    IngestJob.findOne.mockReturnValue(chain({ createdAt: at, source: 'nas' }));
    const freshness = await corpusFreshness(42);
    expect(freshness.state).toBe('stale');
    expect(freshness.signal.state).toBe('stale');
    expect(freshness.signal.freshness.state).toBe('stale');
  });

  it('is unknown, not fresh, when documents exist but no ingest was recorded', async () => {
    IngestJob.findOne.mockReturnValue(chain(null));
    const freshness = await corpusFreshness(42);
    expect(freshness).toMatchObject({ state: 'unknown', lastIngestAt: null, reason: 'ingest_history_predates_telemetry' });
    expect(freshness.signal).toMatchObject({ state: 'missing', value: null });
    expect(freshness.signal.freshness.state).toBe('unknown');
  });

  it('is unknown with no ingest at all, and unavailable when history cannot be read', async () => {
    IngestJob.findOne.mockReturnValue(chain(null));
    expect(await corpusFreshness(0)).toMatchObject({ state: 'unknown', reason: 'no_ingest_recorded' });
    IngestJob.findOne.mockReturnValue(chain(null, new Error('mongo down')));
    const unavailable = await corpusFreshness(5);
    expect(unavailable).toMatchObject({ state: 'unknown', reason: 'ingest_history_unavailable' });
    expect(unavailable.signal.state).toBe('unavailable');
    expect(JSON.stringify(unavailable)).not.toMatch(/mongo down|https?:\/\//);
  });
});
