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

const { score, quickCompare, extractKeyPoints, checkOverallSimilarity, checkKeyPoint, checkContradictions } = require('../../src/services/referenceScorer');

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
  it('retains overall and contradiction evidence while reading their final verdicts', async () => {
    mockFetch.mockResolvedValueOnce({ ok: true, json: async () => ({ response: 'Excellent structure, but required behavior is missing. RATING: PARTIAL' }) });
    expect(await checkOverallSimilarity('answer', 'reference', { model: 'judge', host: 'http://judge:11434' }))
      .toEqual({ similarity: 'partial', score: 5, evidence: 'Excellent structure, but required behavior is missing.' });
    mockFetch.mockResolvedValueOnce({ ok: true, json: async () => ({ response: 'The equivalent algorithm preserves the required behavior.\nVERDICT: NO' }) });
    expect(await checkContradictions('answer', 'reference', { model: 'judge', host: 'http://judge:11434' }))
      .toEqual({ hasContradictions: false, details: 'The equivalent algorithm preserves the required behavior.' });
  });
  it('uses the final criterion verdict after its evidence, rather than a YES or NO mentioned in the explanation', async () => {
    mockFetch.mockResolvedValue({ ok: true, json: async () => ({ response: 'No explicit branch is needed: the initializer remains zero.\nVERDICT: YES' }) });
    const result = await checkKeyPoint('function sum(ns) { let total = 0; for (const n of ns) total += n; return total; }',
      'Handles empty array', { model: 'judge', host: 'http://judge:11434' }, 'Sum an array');
    expect(result).toEqual({ found: true, confidence: 'present', evidence: 'No explicit branch is needed: the initializer remains zero.' });
    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.options.num_predict).toBe(160);
    expect(body.prompt).toContain('independently of other task requirements');
  });
  it('does not infer a criterion verdict from an incomplete explanation', async () => {
    mockFetch.mockResolvedValue({ ok: true, json: async () => ({ response: 'YES may apply, but further analysis is needed.' }) });
    expect(await checkKeyPoint('answer', 'criterion', { model: 'judge', host: 'http://judge:11434' }))
      .toMatchObject({ found: null, confidence: 'error' });
  });
  it('does not count the same sentence or its punctuation variant twice', () => {
    expect(extractKeyPoints('A function returns the sum.')).toEqual(['A function returns the sum']);
    expect(extractKeyPoints('- A function returns the sum.\n- An empty array returns zero.'))
      .toEqual(['A function returns the sum', 'An empty array returns zero']);
    expect(extractKeyPoints('A function returns the sum. A function returns the sum!'))
      .toEqual(['A function returns the sum']);
  });

  it('evaluates the existing task criteria and persists each verdict for equivalent code', async () => {
    mockFetch.mockImplementation(async (_url, opts) => {
      const body = JSON.parse(opts.body);
      return { ok: true, json: async () => ({ response: body.callerDetail === 'benchmark-ref-overall'
        ? 'EXCELLENT' : body.callerDetail === 'benchmark-ref-contradictions' ? 'NO' : 'YES' }) };
    });
    const criteria = ['Valid function with array parameter', 'Correctly sums elements', 'Handles empty array'];
    const result = await score('function sum(xs) { return xs.reduce((a, b) => a + b, 0); }', {
      prompt: 'Write a function that sums an array.',
      reference_answer: 'A function initializes an accumulator and iterates through the array.',
      judge_criteria: criteria
    }, { model: 'judge', host: 'http://judge:11434' });
    expect(result.quality_score).toBe(10);
    expect(result.breakdown).toMatchObject({ key_points_source: 'judge_criteria', key_points_total: 3,
      key_points_detail: criteria.map(point => ({ point, found: true })) });
    const calls = mockFetch.mock.calls.map(([, opts]) => JSON.parse(opts.body))
      .filter(body => body.callerDetail === 'benchmark-ref-keypoint');
    expect(calls).toHaveLength(3);
    expect(calls.every(body => body.prompt.includes('TASK: Write a function that sums an array.'))).toBe(true);
  });
  it('honors the explicit verdict budget for all reference checks', async () => {
    await score('The answer is correct.', { reference_answer: 'The answer is correct.' }, {
      model: 'judge', host: 'http://judge:11434', num_predict: 1024
    });
    expect(new Set(mockFetch.mock.calls.map(([, opts]) => JSON.parse(opts.body).callerDetail))).toEqual(
      new Set(['benchmark-ref-keypoint', 'benchmark-ref-contradictions', 'benchmark-ref-overall'])
    );
    expect(mockFetch.mock.calls.every(([, opts]) => JSON.parse(opts.body).options.num_predict === 1024)).toBe(true);
  });
  it.each(['benchmark-ref-keypoint', 'benchmark-ref-contradictions', 'benchmark-ref-overall'])(
    'does not score when %s returns a readable but truncated verdict', async truncatedCaller => {
      mockFetch.mockImplementation(async (_url, opts) => {
        const body = JSON.parse(opts.body);
        return { ok: true, json: async () => ({
          response: body.callerDetail === 'benchmark-ref-overall' ? 'EXCELLENT'
            : body.callerDetail === 'benchmark-ref-contradictions' ? 'NO' : 'YES',
          done_reason: body.callerDetail === truncatedCaller ? 'length' : 'stop'
        }) };
      });
      expect(await score('Correct answer.', { reference_answer: 'The answer is entirely correct.' }, {
        model: 'judge', host: 'http://judge:11434'
      })).toMatchObject({ quality_score: null, judge_reliable: false, needs_review: true });
    }
  );
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
    const result = await score('42', { reference_answer: '42', scoring_type: 'math' }, config);
    expect(result).toMatchObject({ quality_score: null, judge_reliable: false, needs_review: true });
    expect(result.explanation).toContain('Contradictions not evaluated');
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
