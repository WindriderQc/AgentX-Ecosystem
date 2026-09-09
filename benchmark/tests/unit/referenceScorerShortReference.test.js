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

const { score, quickCompare, extractKeyPoints, checkOverallSimilarity } = require('../../src/services/referenceScorer');

beforeEach(() => {
  mockFetch.mockClear();
  mockFetch.mockImplementation(async (url, opts) => {
    const body = JSON.parse(opts.body);
    const isBinaryCheck = body.callerDetail !== 'benchmark-ref-overall';
    return {
      ok: true,
      json: async () => ({ response: isBinaryCheck ? 'NO' : 'EXCELLENT' })
    };
  });
});

describe('reference scoring with short references', () => {
  it('does not issue a quality score when the runtime reports modified judge input', async () => {
    mockFetch.mockResolvedValue({ ok: true, json: async () => ({
      response: 'EXCELLENT',
      agentx_contract: { contextBudget: { transformations: { truncation: { applied: true } } } }
    }) });
    const result = await quickCompare('4', '4', { model: 'judge', host: 'http://judge:11434' });
    expect(result.quality_score).toBeNull();
    expect(result.judge_reliable).toBe(false);
    expect(result.needs_review).toBe(true);
  });
  it('evaluates decisive evidence beyond the old response and reference cutoffs', async () => {
    const response = 'Context. '.repeat(1500) + 'ANSWER_TAIL';
    const reference = 'Reference detail. '.repeat(700) + 'REFERENCE_TAIL';
    mockFetch.mockImplementation(async (_url, opts) => {
      const body = JSON.parse(opts.body);
      const fullAnswer = body.prompt.includes('ANSWER_TAIL');
      const fullReference = body.prompt.includes('REFERENCE_TAIL');
      return { ok: true, json: async () => ({ response:
        body.callerDetail === 'benchmark-ref-overall'
          ? (fullAnswer && fullReference ? 'EXCELLENT' : 'POOR')
          : body.callerDetail === 'benchmark-ref-contradictions' ? 'NO' : 'YES'
      }) };
    });
    const result = await score(response, { reference_answer: reference }, {
      model: 'judge:latest', host: 'http://judge:11434'
    });
    expect(result.quality_score).toBe(10);
    expect(result.response_truncated_for_judge).toBe(false);
    expect(result.judge_window_chars).toBe(response.length);
    expect(mockFetch.mock.calls.every(([, opts]) => JSON.parse(opts.body).prompt.includes('ANSWER_TAIL'))).toBe(true);
  });

  it('uses the same explicit excerpt for every scoring step and reports it', async () => {
    const config = { model: 'judge:latest', host: 'http://judge:11434', response_char_budget: 4500 };
    const result = await score('r'.repeat(4400) + 'INCLUDED' + 'r'.repeat(1000) + 'EXCLUDED', {
      reference_answer: 'The response contains the necessary information.'
    }, config);
    expect(result).toMatchObject({ response_truncated_for_judge: true, judge_window_chars: 4500 });
    for (const [, opts] of mockFetch.mock.calls) {
      const prompt = JSON.parse(opts.body).prompt;
      expect(prompt).toContain('INCLUDED');
      expect(prompt).not.toContain('EXCLUDED');
    }
  });

  it.each(['http-failure', 'invalid-verdict'])('does not invent a midpoint score for %s', async failure => {
    mockFetch.mockImplementation(async () => failure === 'http-failure'
      ? { ok: false, status: 403 }
      : { ok: true, json: async () => ({ response: 'undecidable' }) });
    const config = { model: 'judge:latest', host: 'http://judge:11434' };
    expect(await score('42', { reference_answer: '42', scoring_type: 'math' }, config))
      .toMatchObject({ quality_score: null, judge_reliable: false, needs_review: true });
    expect(await quickCompare('42', '42', config))
      .toMatchObject({ quality_score: null, judge_reliable: false, needs_review: true });
  });

  it('propagates caller cancellation during response-body parsing instead of returning a fallback score', async () => {
    const controller = new AbortController();
    let markBodyStarted;
    const bodyStarted = new Promise((resolve) => { markBodyStarted = resolve; });
    mockFetch.mockImplementation(async (url, opts) => ({
      ok: true,
      json: () => new Promise((resolve, reject) => {
        markBodyStarted();
        const onAbort = () => {
          const error = new Error('aborted');
          error.name = 'AbortError';
          reject(error);
        };
        opts.signal.addEventListener('abort', onAbort, { once: true });
        if (opts.signal.aborted) onAbort();
      })
    }));

    const pending = checkOverallSimilarity('answer', 'reference', {
      model: 'judge:latest',
      host: 'http://judge:11434',
      cancelSignal: controller.signal
    });
    await bodyStarted;
    controller.abort();

    await expect(pending).rejects.toMatchObject({ code: 'BENCHMARK_BATCH_STOPPED' });
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

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

    // Key-point checks answer NO, so no points match:
    // coverage 0% → 10*0.7 + 0*0.3 = 7.
    expect(result.breakdown.key_points_total).toBeGreaterThan(0);
    expect(result.quality_score).toBe(7);
  });
});
