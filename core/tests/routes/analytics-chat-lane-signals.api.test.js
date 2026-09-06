'use strict';

/**
 * Signal Evidence Contract on the chat-lane analytics routes.
 *
 * Reproduces the live review defects: RAG adoption rendered as a bare 100%
 * on a single conversation, a "+0.0 pts" RAG-vs-non-RAG delta with no
 * feedback in either cohort, and a "Best ★" cost badge on a single unpriced
 * local model.
 */

const express = require('express');
const request = require('supertest');

jest.mock('../../models/Conversation', () => ({
  countDocuments: jest.fn(),
  aggregate: jest.fn(),
}));
jest.mock('../../models/Feedback', () => ({}));
jest.mock('../../routes/analytics-prompt', () => require('express').Router());
jest.mock('../../routes/analytics-effectiveness', () => require('express').Router());
jest.mock('../../routes/analytics-inference', () => require('express').Router());

const Conversation = require('../../models/Conversation');
const router = require('../../routes/analytics');
const { validateSignal, SIGNAL_STATES, COMPARISON_STATES } = require('../../../shared/signalEvidence');

function app() {
  const instance = express();
  instance.use('/api/analytics', router);
  return instance;
}

const emptyFeedback = () => [];
const feedback = (total, positive) => [{ _id: null, total, positive }];

describe('rag-stats under the Signal Evidence Contract', () => {
  let server;
  beforeAll((done) => { server = app().listen(0, '127.0.0.1', done); });
  afterAll((done) => { server.close(done); });
  beforeEach(() => jest.clearAllMocks());

  test('no conversation in the window: usage and delta are not observed, never 0%', async () => {
    Conversation.countDocuments.mockResolvedValue(0);
    Conversation.aggregate.mockResolvedValue(emptyFeedback());

    const res = await request(server).get('/api/analytics/rag-stats');
    expect(res.status).toBe(200);
    const { data } = res.body;
    expect(data.ragUsageRate).toBeNull();
    expect(data.feedback.rag.positiveRate).toBeNull();
    expect(data.feedback.noRag.positiveRate).toBeNull();

    for (const signal of Object.values(data.signals)) expect(validateSignal(signal)).toEqual({ ok: true, errors: [] });
    expect(data.signals.ragUsageRate).toMatchObject({ state: SIGNAL_STATES.MISSING, value: null, reason: 'no_conversations' });
    expect(data.signals.ragUsageRate.sample).toMatchObject({ n: 0, denominator: 0 });
    expect(data.signals.ragFeedbackDelta).toMatchObject({ state: SIGNAL_STATES.MISSING, value: null, reason: 'needs_both_cohorts' });
    expect(data.signals.ragFeedbackDelta.contributors).toEqual([
      expect.objectContaining({ id: 'analytics.rag.positive_rate', state: SIGNAL_STATES.MISSING }),
      expect.objectContaining({ id: 'analytics.rag.no_rag_positive_rate', state: SIGNAL_STATES.MISSING }),
    ]);
  });

  test('a single RAG conversation is a low-sample 100%, with its n and minimum', async () => {
    // countDocuments is called for total, requested, then ragUsed.
    Conversation.countDocuments
      .mockResolvedValueOnce(1)
      .mockResolvedValueOnce(1)
      .mockResolvedValueOnce(1);
    Conversation.aggregate.mockResolvedValue(emptyFeedback());

    const res = await request(server).get('/api/analytics/rag-stats');
    const { data } = res.body;
    expect(data.ragUsageRate).toBe(1);
    expect(data.signals.ragUsageRate).toMatchObject({
      state: SIGNAL_STATES.INSUFFICIENT_SAMPLE,
      value: 100,
      unit: 'percent',
      sample: { n: 1, numerator: 1, denominator: 1, minimum: 5 },
      source: 'conversations',
    });
    expect(data.signals.ragUsageRate.freshness.state).toBe('fresh');
    expect(data.signals.ragUsageRate.freshness.observedAt).toBe(data.to);
    // No feedback anywhere: the delta stays not observed instead of +0.0.
    expect(data.signals.ragFeedbackDelta.state).toBe(SIGNAL_STATES.MISSING);
  });

  test('the delta is a number only once both cohorts carry feedback', async () => {
    Conversation.countDocuments
      .mockResolvedValueOnce(20)
      .mockResolvedValueOnce(12)
      .mockResolvedValueOnce(12);
    Conversation.aggregate
      .mockResolvedValueOnce(feedback(10, 8))   // RAG cohort
      .mockResolvedValueOnce(feedback(10, 6));  // non-RAG cohort

    const res = await request(server).get('/api/analytics/rag-stats');
    const { data } = res.body;
    expect(data.signals.ragUsageRate).toMatchObject({ state: SIGNAL_STATES.OBSERVED, value: 60 });
    expect(data.signals.ragPositiveRate).toMatchObject({ state: SIGNAL_STATES.OBSERVED, value: 80, sample: { n: 10 } });
    expect(data.signals.noRagPositiveRate).toMatchObject({ state: SIGNAL_STATES.OBSERVED, value: 60, sample: { n: 10 } });
    expect(data.signals.ragFeedbackDelta).toMatchObject({ state: SIGNAL_STATES.OBSERVED, value: 20, unit: 'points', sample: { n: 10 } });
  });

  test('a delta over a thin cohort is flagged, not presented as a clean number', async () => {
    Conversation.countDocuments
      .mockResolvedValueOnce(20)
      .mockResolvedValueOnce(12)
      .mockResolvedValueOnce(12);
    Conversation.aggregate
      .mockResolvedValueOnce(feedback(1, 1))
      .mockResolvedValueOnce(feedback(10, 6));

    const res = await request(server).get('/api/analytics/rag-stats');
    expect(res.body.data.signals.ragFeedbackDelta).toMatchObject({ state: SIGNAL_STATES.INSUFFICIENT_SAMPLE, value: 40, sample: { n: 1, minimum: 5 } });
  });

  test('signals never carry an absolute location', async () => {
    Conversation.countDocuments.mockResolvedValue(3);
    Conversation.aggregate.mockResolvedValue(emptyFeedback());
    const res = await request(server).get('/api/analytics/rag-stats');
    expect(JSON.stringify(res.body.data.signals)).not.toMatch(/https?:\/\//);
  });
});

describe('costs ranking under the Signal Evidence Contract', () => {
  let server;
  beforeAll((done) => { server = app().listen(0, '127.0.0.1', done); });
  afterAll((done) => { server.close(done); });
  beforeEach(() => jest.clearAllMocks());

  const row = (key, { cost = 0, tokens = 1000, messages = 4 } = {}) => ({
    key,
    messageCount: messages,
    conversationCount: 2,
    tokens: { prompt: tokens / 2, completion: tokens / 2, total: tokens },
    cost: {
      total: cost,
      prompt: cost / 2,
      completion: cost / 2,
      avgPerMessage: messages ? cost / messages : 0,
      avgPerConversation: cost / 2,
      per1kTokens: tokens > 0 ? cost / (tokens / 1000) : 0,
    },
  });

  test('a single unpriced local model gets no Best badge', async () => {
    Conversation.aggregate.mockResolvedValue([row('qwen3.8:27b-mtp-q8_0', { cost: 0, tokens: 14026, messages: 9 })]);

    const res = await request(server).get('/api/analytics/costs?groupBy=model');
    expect(res.status).toBe(200);
    const { data } = res.body;
    expect(data.breakdown[0]).toMatchObject({ key: 'qwen3.8:27b-mtp-q8_0', messageCount: 9, priced: false });
    const ranking = data.signals.costEfficiencyRanking;
    expect(validateSignal(ranking).ok).toBe(true);
    expect(ranking).toMatchObject({ state: SIGNAL_STATES.NOT_APPLICABLE, value: null });
    expect(ranking.comparison).toMatchObject({ state: COMPARISON_STATES.NOT_COMPARABLE, best: null, comparable: 0, of: 1 });
    expect(ranking.comparison.ranked[0]).toMatchObject({ key: 'qwen3.8:27b-mtp-q8_0', comparable: false, rank: null, reason: 'no_price' });
  });

  test('one priced model has nothing to be compared against', async () => {
    Conversation.aggregate.mockResolvedValue([
      row('gpt-4o', { cost: 0.5, tokens: 10000 }),
      row('qwen3:8b', { cost: 0, tokens: 90000 }),
    ]);

    const res = await request(server).get('/api/analytics/costs?groupBy=model');
    const ranking = res.body.data.signals.costEfficiencyRanking;
    expect(ranking.state).toBe(SIGNAL_STATES.INSUFFICIENT_SAMPLE);
    expect(ranking.comparison).toMatchObject({ state: COMPARISON_STATES.NO_COMPARATOR, best: null, comparable: 1, of: 2 });
  });

  test('two priced models produce a ranked best; a tie produces none', async () => {
    Conversation.aggregate.mockResolvedValue([
      row('gpt-4o', { cost: 0.5, tokens: 10000 }),
      row('claude-haiku', { cost: 0.1, tokens: 10000 }),
      row('qwen3:8b', { cost: 0, tokens: 90000 }),
    ]);
    let res = await request(server).get('/api/analytics/costs?groupBy=model');
    let ranking = res.body.data.signals.costEfficiencyRanking;
    expect(ranking).toMatchObject({ state: SIGNAL_STATES.OBSERVED, value: 0.01 });
    expect(ranking.comparison).toMatchObject({ state: COMPARISON_STATES.RANKED, best: 'claude-haiku', comparable: 2, of: 3 });
    expect(ranking.comparison.ranked.map((r) => [r.key, r.rank])).toEqual([['gpt-4o', 2], ['claude-haiku', 1], ['qwen3:8b', null]]);

    Conversation.aggregate.mockResolvedValue([
      row('gpt-4o', { cost: 0.1, tokens: 10000 }),
      row('claude-haiku', { cost: 0.1, tokens: 10000 }),
    ]);
    res = await request(server).get('/api/analytics/costs?groupBy=model');
    ranking = res.body.data.signals.costEfficiencyRanking;
    expect(ranking.comparison).toMatchObject({ state: COMPARISON_STATES.TIED, best: null });
  });

  test('prompt-version rows are keyed stably for the ranking', async () => {
    Conversation.aggregate.mockResolvedValue([
      row({ name: 'assistant', version: 3 }, { cost: 0.2, tokens: 10000 }),
      row({ name: 'assistant', version: 2 }, { cost: 0.4, tokens: 10000 }),
    ]);
    const res = await request(server).get('/api/analytics/costs?groupBy=promptVersion');
    expect(res.body.data.signals.costEfficiencyRanking.comparison.best).toBe('assistant@3');
  });
});
