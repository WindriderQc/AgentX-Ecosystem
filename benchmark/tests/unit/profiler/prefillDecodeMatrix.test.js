'use strict';

jest.mock('../../../src/clients/ollamaClient', () => ({
  generate: jest.fn(),
  listRunning: jest.fn()
}));

const { generate, listRunning } = require('../../../src/clients/ollamaClient');
const {
  runPrefillDecodeMatrix,
  getMatrixConfig,
  planMatrix,
  DEFAULT_PREFILL_TOKENS,
  DEFAULT_DECODE_TOKENS,
  CELL_CTX_MARGIN,
  _internal
} = require('../../../src/services/profiler/prefillDecodeMatrix');

function ollamaResponse({ promptTokens, completionTokens, prefillTps = 500, decodeTps = 100 }) {
  return {
    prompt_eval_count: promptTokens,
    prompt_eval_duration: (promptTokens / prefillTps) * 1e9,
    eval_count: completionTokens,
    eval_duration: (completionTokens / decodeTps) * 1e9
  };
}

afterEach(() => {
  jest.clearAllMocks();
  delete process.env.PROFILER_MATRIX_PREFILL_TOKENS;
  delete process.env.PROFILER_MATRIX_DECODE_TOKENS;
});

beforeEach(() => {
  listRunning.mockImplementation(async () => ({
    models: [{
      name: 'm:latest',
      context_length: generate.mock.calls.at(-1)?.[1]?.options?.num_ctx
    }]
  }));
});

describe('getMatrixConfig', () => {
  test('returns fixed defaults when nothing is configured', () => {
    const cfg = getMatrixConfig();
    expect(cfg.prefillTokens).toEqual(DEFAULT_PREFILL_TOKENS);
    expect(cfg.decodeTokens).toEqual(DEFAULT_DECODE_TOKENS);
  });

  test('parses env overrides, dedupes and sorts', () => {
    process.env.PROFILER_MATRIX_PREFILL_TOKENS = '4096, 1024,1024';
    process.env.PROFILER_MATRIX_DECODE_TOKENS = '128';
    const cfg = getMatrixConfig();
    expect(cfg.prefillTokens).toEqual([1024, 4096]);
    expect(cfg.decodeTokens).toEqual([128]);
  });

  test('falls back to defaults on garbage env', () => {
    process.env.PROFILER_MATRIX_PREFILL_TOKENS = 'not,numbers';
    expect(getMatrixConfig().prefillTokens).toEqual(DEFAULT_PREFILL_TOKENS);
  });

  test('explicit options win over env', () => {
    process.env.PROFILER_MATRIX_PREFILL_TOKENS = '999';
    const cfg = getMatrixConfig({ prefillTokens: [2048, 512], decodeTokens: [32] });
    expect(cfg.prefillTokens).toEqual([512, 2048]);
    expect(cfg.decodeTokens).toEqual([32]);
  });
});

describe('planMatrix', () => {
  test('marks cells beyond safe context as not fitting', () => {
    const { cells, numCtx } = planMatrix([512, 8192], [64], 4096);
    const small = cells.find(c => c.prefillTokens === 512);
    const big = cells.find(c => c.prefillTokens === 8192);
    expect(small.fits).toBe(true);
    expect(big.fits).toBe(false);
    // num_ctx sized from the largest FITTING cell, rounded up to 1024
    expect(numCtx).toBe(Math.ceil((512 + 64 + CELL_CTX_MARGIN) / 1024) * 1024);
  });

  test('caps num_ctx at safe context', () => {
    // required = 512+64+margin = 832 fits in 900, but rounds up to 1024 → capped
    const { numCtx } = planMatrix([512], [64], 900);
    expect(numCtx).toBe(900);
  });

  test('no safe context means everything fits', () => {
    const { cells, numCtx } = planMatrix([16384], [1024], null);
    expect(cells[0].fits).toBe(true);
    expect(numCtx).toBe(Math.ceil((16384 + 1024 + CELL_CTX_MARGIN) / 1024) * 1024);
  });

  test('returns null num_ctx when nothing fits', () => {
    const { numCtx } = planMatrix([8192], [1024], 2048);
    expect(numCtx).toBeNull();
  });
});

describe('runPrefillDecodeMatrix', () => {
  test('runs every fitting cell and computes separate prefill/decode throughput', async () => {
    const captureTelemetry = jest.fn(async ({ prefillTokens, decodeTokens, repeat }) => ({
      ok: true, prefillTokens, decodeTokens, repeat
    }));
    generate.mockImplementation((host, body) => Promise.resolve(ollamaResponse({
      promptTokens: body.options.num_ctx,
      completionTokens: body.options.num_predict,
      prefillTps: 800,
      decodeTps: 120
    })));

    const result = await runPrefillDecodeMatrix('http://host:11434', 'm', {
      prefillTokens: [512, 2048],
      decodeTokens: [64, 256],
      safeNumCtx: 8192,
      captureTelemetry
    });

    expect(result.cellCount).toBe(4);
    expect(result.passCount).toBe(4);
    expect(result.skippedCount).toBe(0);
    expect(generate).toHaveBeenCalledTimes(20);
    expect(captureTelemetry).toHaveBeenCalledTimes(20);
    expect(result.telemetrySampleCount).toBe(20);

    // Single shared num_ctx across all calls
    const ctxs = generate.mock.calls.map(([, body]) => body.options.num_ctx);
    expect(new Set(ctxs).size).toBe(1);
    expect(ctxs[0]).toBe(Math.ceil((2048 + 256 + CELL_CTX_MARGIN) / 1024) * 1024);

    const cell = result.cells[0];
    expect(cell.prefillTokensPerSec).toBeCloseTo(800, 0);
    expect(cell.decodeTokensPerSec).toBeCloseTo(120, 0);
    expect(cell.promptEvalDurationMs).toBeGreaterThan(0);
    expect(cell.runtimeContextLength).toBe(ctxs[0]);
    expect(cell.passingSampleCount).toBe(5);
    expect(cell.samples.every(sample => sample.hardwareTelemetry?.ok === true)).toBe(true);
    expect(cell.prefillStatistics.confidenceInterval95.method).toBe('student_t');
    expect(cell).not.toHaveProperty('ttftMs');
    expect(cell.status).toBe('pass');
  });

  test('skips cells that exceed safe context with an explicit reason', async () => {
    generate.mockResolvedValue(ollamaResponse({ promptTokens: 400, completionTokens: 64 }));

    const result = await runPrefillDecodeMatrix('http://host:11434', 'm', {
      prefillTokens: [512, 16384],
      decodeTokens: [64],
      safeNumCtx: 4096
    });

    const skipped = result.cells.find(c => c.prefillTokens === 16384);
    expect(skipped.status).toBe('skipped');
    expect(skipped.error).toMatch(/safe/);
    expect(result.skippedCount).toBe(1);
    expect(generate).toHaveBeenCalledTimes(1);
  });

  test('flags short completions as invalid decode samples', async () => {
    generate.mockResolvedValue(ollamaResponse({ promptTokens: 512, completionTokens: 10 }));

    const result = await runPrefillDecodeMatrix('http://host:11434', 'm', {
      prefillTokens: [512],
      decodeTokens: [256],
      safeNumCtx: 8192
    });

    expect(result.cells[0].status).toBe('short_completion');
    expect(result.passCount).toBe(0);
  });

  test.each([
    ['prompt', { prompt_eval_duration: 0 }],
    ['decode', { eval_duration: 0 }]
  ])('rejects a %s timing sample even when token counts are sufficient', async (_label, override) => {
    generate.mockResolvedValue({
      ...ollamaResponse({ promptTokens: 512, completionTokens: 64 }),
      ...override
    });

    const result = await runPrefillDecodeMatrix('http://host:11434', 'm', {
      prefillTokens: [512],
      decodeTokens: [64],
      safeNumCtx: 8192
    });

    expect(result.cells[0]).toEqual(expect.objectContaining({
      status: 'invalid_timing',
      error: expect.stringMatching(/duration|throughput/i)
    }));
    expect(result.passCount).toBe(0);
  });

  test('records per-cell errors without aborting the matrix', async () => {
    generate
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValue(ollamaResponse({ promptTokens: 1024, completionTokens: 64 }));

    const result = await runPrefillDecodeMatrix('http://host:11434', 'm', {
      prefillTokens: [512, 1024],
      decodeTokens: [64],
      safeNumCtx: 8192
    });

    expect(result.cells[0].status).toBe('error');
    expect(result.cells[0].error).toBe('boom');
    expect(result.cells[1].status).toBe('pass');
    expect(generate).toHaveBeenCalledTimes(6);
  });

  test('rejects a cell when Ollama does not attest the requested resident context', async () => {
    generate.mockResolvedValue(ollamaResponse({ promptTokens: 512, completionTokens: 64 }));
    listRunning.mockResolvedValue({ models: [{ name: 'm', context_length: 2048 }] });

    const result = await runPrefillDecodeMatrix('http://host:11434', 'm', {
      prefillTokens: [512],
      decodeTokens: [64],
      safeNumCtx: 8192
    });

    expect(result.cells[0]).toEqual(expect.objectContaining({
      status: 'error',
      runtimeContextLength: null,
      error: expect.stringMatching(/requested .* observed 2048/i)
    }));
    expect(result.passCount).toBe(0);
  });

  test('reports progress for every cell including skipped ones', async () => {
    generate.mockResolvedValue(ollamaResponse({ promptTokens: 400, completionTokens: 64 }));
    const seen = [];

    await runPrefillDecodeMatrix('http://host:11434', 'm', {
      prefillTokens: [512, 16384],
      decodeTokens: [64],
      safeNumCtx: 2048,
      onProgress: ({ index, total, cell }) => seen.push({ index, total, status: cell.status })
    });

    expect(seen).toHaveLength(2);
    expect(seen[0].total).toBe(2);
    expect(seen.map(s => s.status)).toContain('skipped');
  });

  test('decode footer requests more integers than num_predict allows', async () => {
    generate.mockResolvedValue(ollamaResponse({ promptTokens: 400, completionTokens: 256 }));

    await runPrefillDecodeMatrix('http://host:11434', 'm', {
      prefillTokens: [512],
      decodeTokens: [256],
      safeNumCtx: 8192
    });

    const [, body] = generate.mock.calls[0];
    expect(body.prompt).toMatch(new RegExp(`1 through ${256 * 4}`));
    expect(body.options.num_predict).toBe(256);
  });
});

describe('_parseTokenList', () => {
  test('handles empty and invalid entries', () => {
    expect(_internal._parseTokenList('', [1, 2])).toEqual([1, 2]);
    expect(_internal._parseTokenList('0,-5,abc', [1])).toEqual([1]);
    expect(_internal._parseTokenList('300,100,200', [])).toEqual([100, 200, 300]);
  });
});
