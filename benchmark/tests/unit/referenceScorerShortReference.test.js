'use strict';

jest.mock('../../config/logger', () => ({
  info: jest.fn(),
  error: jest.fn(),
  warn: jest.fn(),
  debug: jest.fn()
}));
jest.mock('../../src/helpers/httpAgent', () => ({
  getFetchOptions: jest.fn((url, opts) => opts)
}));

// Route the judge-call mock by prompt content so the contradiction check
// answers NO and the similarity check answers EXCELLENT.
jest.mock('../../src/services/benchmark/http', () => ({ benchmarkFetch: jest.fn() }));
const { benchmarkFetch: mockFetch } = require('../../src/services/benchmark/http');

const { score, extractKeyPoints } = require('../../src/services/referenceScorer');

beforeEach(() => {
  mockFetch.mockImplementation(async (url, opts) => {
    const body = JSON.parse(opts.body);
    const isContradictionCheck = body.prompt.includes('CONTRADICT');
    return {
      ok: true,
      json: async () => ({ response: isContradictionCheck ? 'NO' : 'EXCELLENT' })
    };
  });
});

describe('reference scoring with short references', () => {
  it('extractKeyPoints returns no points for a very short reference', () => {
    expect(extractKeyPoints('42')).toEqual([]);
    expect(extractKeyPoints('Paris.')).toEqual([]);
  });

  it('does not cap the score at 7/10 when the reference has no extractable key points', async () => {
    const result = await score('The answer is 42.', {
      name: 'short-ref',
      reference_answer: '42',
      scoring_type: 'math'
    }, { model: 'judge:latest', host: 'http://judge:11434' });

    // similarity EXCELLENT = 10; with zero key points the similarity rating
    // carries full weight instead of 10*0.7 + 0*0.3 = 7.
    expect(result.quality_score).toBe(10);
    expect(result.breakdown.key_points_total).toBe(0);
    expect(result.breakdown.coverage_percent).toBeNull();
    expect(result.explanation).toMatch(/reference too short/i);
  });

  it('still applies the 70/30 similarity+coverage split when key points exist', async () => {
    const reference = 'The mitochondria is the powerhouse of the cell. It produces ATP through respiration.';
    const result = await score('Something unrelated entirely.', {
      name: 'long-ref',
      reference_answer: reference,
      scoring_type: 'knowledge'
    }, { model: 'judge:latest', host: 'http://judge:11434' });

    // Key-point checks answer EXCELLENT (not YES), so no points match:
    // coverage 0% → 10*0.7 + 0*0.3 = 7.
    expect(result.breakdown.key_points_total).toBeGreaterThan(0);
    expect(result.quality_score).toBe(7);
  });
});
