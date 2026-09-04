'use strict';

/**
 * Fixed prefill/decode profiler matrix (task 0365).
 *
 * Runs a grid of FIXED absolute workloads — prefill (prompt) token sizes ×
 * decode (generation) lengths — against a model on one host, and records
 * prefill tok/s, decode tok/s, prompt-eval duration and latency for every cell.
 *
 * Why "fixed": the existing full-profile throughputCurve scales its prompt to
 * a percentage of each model's own max context, so its numbers are not
 * comparable across models. This matrix uses the same absolute token sizes
 * for every model, which makes prefill and decode throughput directly
 * comparable across models and hosts.
 *
 * Design constraints:
 *  - One num_ctx for the whole matrix (largest fitting cell, rounded up),
 *    so Ollama never reloads the model between cells and cells stay
 *    comparable within a run.
 *  - Cells that cannot fit inside the model's safe context are recorded as
 *    skipped with an explicit reason — never silently dropped.
 *  - No physical-ceiling plausibility gate here: raw readings are recorded
 *    as measured. (The 0355-era Nemotron false positive showed the ceiling
 *    guard mis-models MoE architectures; gating belongs to callers that
 *    have verified architecture metadata.)
 */

const { generate, listRunning } = require('../../clients/ollamaClient');
const { generateFillPrompt } = require('../contextProbePayload');
const logger = require('../../../config/logger');

const DEFAULT_REPEATS = 3;

// Fixed absolute defaults — identical for every model/host so results are
// directly comparable. Env-overridable as comma-separated token counts.
const DEFAULT_PREFILL_TOKENS = [512, 2048, 8192, 16384];
const DEFAULT_DECODE_TOKENS = [64, 256, 1024];
// KV/template headroom added on top of prefill+decode when sizing num_ctx
// and when deciding whether a cell fits.
const CELL_CTX_MARGIN = 256;
// A decode sample shorter than this fraction of the requested num_predict is
// not a valid sustained-decode measurement (model stopped early).
const MIN_COMPLETION_RATIO = 0.5;
const MIN_PROMPT_COVERAGE_RATIO = 0.8;

function normalizeModelName(value) {
  return String(value || '').trim().replace(/:latest$/i, '').toLowerCase();
}

function _parseTokenList(raw, fallback) {
  if (!raw) return [...fallback];
  const values = String(raw)
    .split(',')
    .map((part) => parseInt(part.trim(), 10))
    .filter((n) => Number.isFinite(n) && n > 0);
  if (!values.length) return [...fallback];
  return [...new Set(values)].sort((a, b) => a - b);
}

function getMatrixConfig(options = {}) {
  const prefillTokens = Array.isArray(options.prefillTokens) && options.prefillTokens.length
    ? [...new Set(options.prefillTokens.filter((n) => Number.isFinite(n) && n > 0))].sort((a, b) => a - b)
    : _parseTokenList(process.env.PROFILER_MATRIX_PREFILL_TOKENS, DEFAULT_PREFILL_TOKENS);
  const decodeTokens = Array.isArray(options.decodeTokens) && options.decodeTokens.length
    ? [...new Set(options.decodeTokens.filter((n) => Number.isFinite(n) && n > 0))].sort((a, b) => a - b)
    : _parseTokenList(process.env.PROFILER_MATRIX_DECODE_TOKENS, DEFAULT_DECODE_TOKENS);
  return { prefillTokens, decodeTokens };
}

function _roundUpCtx(tokens) {
  return Math.ceil(tokens / 1024) * 1024;
}

/**
 * Pick the single num_ctx used for every cell: the smallest 1024-multiple
 * that fits the largest cell, capped at the model's safe context.
 */
function planMatrix(prefillTokens, decodeTokens, safeNumCtx) {
  const safeCtx = Number.isFinite(Number(safeNumCtx)) && Number(safeNumCtx) > 0
    ? Math.floor(Number(safeNumCtx))
    : null;

  const cells = [];
  for (const prefill of prefillTokens) {
    for (const decode of decodeTokens) {
      const required = prefill + decode + CELL_CTX_MARGIN;
      const fits = safeCtx == null || required <= safeCtx;
      cells.push({ prefillTokens: prefill, decodeTokens: decode, requiredCtx: required, fits });
    }
  }

  const fitting = cells.filter((c) => c.fits);
  const maxRequired = fitting.length
    ? Math.max(...fitting.map((c) => c.requiredCtx))
    : null;
  let numCtx = maxRequired ? _roundUpCtx(maxRequired) : null;
  if (numCtx != null && safeCtx != null && numCtx > safeCtx) {
    numCtx = safeCtx;
  }

  return { cells, numCtx };
}

async function _runCell(hostUrl, modelName, cellPlan, numCtx, timeoutMs, signal = null) {
  const { prefillTokens, decodeTokens } = cellPlan;
  // Ask for far more integers than fit in num_predict so decode always runs
  // to the requested length instead of stopping early at a natural end.
  const { prompt } = generateFillPrompt(prefillTokens, { decodeIntegers: decodeTokens * 4 });
  const start = Date.now();

  try {
    const data = await generate(hostUrl, {
      model: modelName,
      prompt,
      stream: false,
      options: {
        num_ctx: numCtx,
        num_predict: decodeTokens,
        temperature: 0,
        seed: 7
      }
    }, { timeoutMs, signal });

    // Ollama can clamp or reuse a different resident context without failing
    // the generation. A Full matrix is capacity evidence only when /api/ps
    // independently attests the exact shared num_ctx after every cell.
    const running = await listRunning(hostUrl, { timeoutMs: Math.min(timeoutMs, 30_000), signal });
    const resident = (running?.models || []).find(entry =>
      normalizeModelName(entry?.name || entry?.model) === normalizeModelName(modelName));
    const runtimeContextLength = Number(resident?.context_length ?? resident?.contextLength);
    if (!resident || !Number.isInteger(runtimeContextLength) || runtimeContextLength !== Number(numCtx)) {
      const error = new Error(`Ollama runtime context attestation failed: requested ${numCtx}, observed ${Number.isFinite(runtimeContextLength) ? runtimeContextLength : 'unknown'}`);
      error.code = 'MATRIX_RUNTIME_CONTEXT_MISMATCH';
      throw error;
    }

    const latencyMs = Date.now() - start;
    const promptEvalCount = data.prompt_eval_count || 0;
    const promptEvalDuration = data.prompt_eval_duration || 0; // ns
    const evalCount = data.eval_count || 0;
    const evalDuration = data.eval_duration || 0; // ns

    const prefillTokensPerSec = promptEvalDuration > 0
      ? Number((promptEvalCount / (promptEvalDuration / 1e9)).toFixed(2))
      : null;
    const decodeTokensPerSec = evalDuration > 0
      ? Number((evalCount / (evalDuration / 1e9)).toFixed(2))
      : null;
    const promptEvalDurationMs = promptEvalDuration > 0
      ? Number((promptEvalDuration / 1e6).toFixed(1))
      : null;
    const evalDurationMs = evalDuration > 0
      ? Number((evalDuration / 1e6).toFixed(1))
      : null;

    const minimumPromptTokens = Math.max(1, Math.floor(prefillTokens * MIN_PROMPT_COVERAGE_RATIO));
    const promptCoveragePct = Number(((promptEvalCount / prefillTokens) * 100).toFixed(1));
    const shortPrompt = promptEvalCount < minimumPromptTokens;
    const shortCompletion = evalCount < Math.max(1, Math.floor(decodeTokens * MIN_COMPLETION_RATIO));
    const invalidDurations = !(Number(promptEvalDuration) > 0) || !(Number(evalDuration) > 0);
    const invalidThroughput = !(Number.isFinite(prefillTokensPerSec) && prefillTokensPerSec > 0)
      || !(Number.isFinite(decodeTokensPerSec) && decodeTokensPerSec > 0);

    return {
      prefillTokens,
      decodeTokens,
      status: shortPrompt
        ? 'prompt_underfill'
        : shortCompletion
          ? 'short_completion'
          : invalidDurations || invalidThroughput
            ? 'invalid_timing'
            : 'pass',
      requestedPromptTokens: prefillTokens,
      promptTokens: promptEvalCount,
      promptCoveragePct,
      minimumPromptCoveragePct: MIN_PROMPT_COVERAGE_RATIO * 100,
      completionTokens: evalCount,
      prefillTokensPerSec,
      decodeTokensPerSec,
      promptEvalDurationMs,
      evalDurationMs,
      runtimeContextLength,
      latencyMs,
      error: shortPrompt
        ? `Prompt evaluation ${promptEvalCount}/${prefillTokens} tokens — prefill sample invalid`
        : shortCompletion
          ? `Completion ${evalCount}/${decodeTokens} tokens — decode sample invalid`
          : invalidDurations
            ? 'Ollama returned a non-positive prompt/decode duration; throughput sample invalid'
            : invalidThroughput
              ? 'Ollama returned non-finite or non-positive prefill/decode throughput'
              : null
    };
  } catch (err) {
    if (signal?.aborted) throw (signal.reason instanceof Error ? signal.reason : err);
    return {
      prefillTokens,
      decodeTokens,
      status: 'error',
      requestedPromptTokens: prefillTokens,
      promptTokens: null,
      promptCoveragePct: null,
      minimumPromptCoveragePct: MIN_PROMPT_COVERAGE_RATIO * 100,
      completionTokens: null,
      prefillTokensPerSec: null,
      decodeTokensPerSec: null,
      promptEvalDurationMs: null,
      evalDurationMs: null,
      runtimeContextLength: null,
      latencyMs: Date.now() - start,
      error: err.message
    };
  }
}

function _quantile(values, q) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const position = (sorted.length - 1) * q;
  const lower = Math.floor(position);
  const fraction = position - lower;
  return sorted[lower + 1] === undefined
    ? sorted[lower]
    : sorted[lower] + fraction * (sorted[lower + 1] - sorted[lower]);
}

function _studentTCritical95(sampleCount) {
  const byDf = [null, 12.706, 4.303, 3.182, 2.776, 2.571, 2.447, 2.365, 2.306, 2.262,
    2.228, 2.201, 2.179, 2.16, 2.145, 2.131, 2.12, 2.11, 2.101, 2.093, 2.086,
    2.08, 2.074, 2.069, 2.064, 2.06, 2.056, 2.052, 2.048, 2.045, 2.042];
  const df = Math.max(1, Math.floor(sampleCount) - 1);
  return byDf[Math.min(df, 30)] || 1.96;
}

function summarizeMetric(values) {
  const finite = values.map(Number).filter(value => Number.isFinite(value) && value > 0);
  if (!finite.length) return {
    sampleCount: 0, mean: null, p50: null, p95: null, standardDeviation: null,
    coefficientOfVariation: null, confidenceInterval95: null
  };
  const round = (value, places = 2) => Number(value.toFixed(places));
  const mean = finite.reduce((sum, value) => sum + value, 0) / finite.length;
  if (finite.length < 2) return {
    sampleCount: finite.length,
    mean: round(mean),
    p50: round(mean),
    p95: round(mean),
    standardDeviation: null,
    coefficientOfVariation: null,
    confidenceInterval95: null
  };
  const variance = finite.reduce((sum, value) => sum + ((value - mean) ** 2), 0) / (finite.length - 1);
  const standardDeviation = Math.sqrt(variance);
  const margin = _studentTCritical95(finite.length) * standardDeviation / Math.sqrt(finite.length);
  return {
    sampleCount: finite.length,
    mean: round(mean),
    p50: round(_quantile(finite, 0.5)),
    p95: round(_quantile(finite, 0.95)),
    standardDeviation: round(standardDeviation),
    coefficientOfVariation: mean > 0 ? round(standardDeviation / mean, 4) : null,
    confidenceInterval95: {
      low: round(Math.max(0, mean - margin)),
      high: round(mean + margin),
      method: 'student_t'
    }
  };
}

function aggregateCellSamples(samples, plan, numCtx, minimumSamples) {
  const passing = samples.filter(sample => sample.status === 'pass');
  const representative = passing[Math.floor(passing.length / 2)] || samples[0] || {};
  const prefillStatistics = summarizeMetric(passing.map(sample => sample.prefillTokensPerSec));
  const decodeStatistics = summarizeMetric(passing.map(sample => sample.decodeTokensPerSec));
  const complete = samples.length === minimumSamples
    && passing.length === minimumSamples
    && prefillStatistics.sampleCount === minimumSamples
    && decodeStatistics.sampleCount === minimumSamples;
  return {
    ...representative,
    prefillTokens: plan.prefillTokens,
    decodeTokens: plan.decodeTokens,
    status: complete ? 'pass' : (samples.find(sample => sample.status !== 'pass')?.status || 'error'),
    prefillTokensPerSec: prefillStatistics.p50,
    decodeTokensPerSec: decodeStatistics.p50,
    promptEvalDurationMs: summarizeMetric(passing.map(sample => sample.promptEvalDurationMs)).p50,
    evalDurationMs: summarizeMetric(passing.map(sample => sample.evalDurationMs)).p50,
    latencyMs: summarizeMetric(passing.map(sample => sample.latencyMs)).p50,
    runtimeContextLength: complete && passing.every(sample => Number(sample.runtimeContextLength) === Number(numCtx))
      ? Number(numCtx)
      : null,
    sampleCount: samples.length,
    passingSampleCount: passing.length,
    minimumSamples,
    samples,
    prefillStatistics,
    decodeStatistics,
    error: complete ? null : (samples.find(sample => sample.status !== 'pass')?.error || 'Matrix repetitions incomplete')
  };
}

/**
 * Run the fixed prefill/decode matrix for a model on a host.
 *
 * @param {string} hostUrl
 * @param {string} modelName
 * @param {object} options
 * @param {number} [options.safeNumCtx]    - model's verified safe context; cells beyond it are skipped
 * @param {number} [options.timeoutMs]     - per-cell timeout (default 120000)
 * @param {number[]} [options.prefillTokens]
 * @param {number[]} [options.decodeTokens]
 * @param {function} [options.onProgress]  - ({ index, total, cell }) per completed cell
 * @returns {Promise<object>} matrix result stored in exact-artifact performance evidence
 */
async function runPrefillDecodeMatrix(hostUrl, modelName, options = {}) {
  const { prefillTokens, decodeTokens } = getMatrixConfig(options);
  const timeoutMs = Number.isFinite(Number(options.timeoutMs)) && Number(options.timeoutMs) > 0
    ? Number(options.timeoutMs)
    : 120000;
  const notify = typeof options.onProgress === 'function' ? options.onProgress : () => {};
  const repeats = Math.max(1, Math.min(10, Number.parseInt(options.repeats, 10) || DEFAULT_REPEATS));

  const { cells: plannedCells, numCtx } = planMatrix(prefillTokens, decodeTokens, options.safeNumCtx);
  const cells = [];
  const total = plannedCells.length;
  let index = 0;

  for (const plan of plannedCells) {
    options.assertClaimActive?.();
    index += 1;
    if (!plan.fits || numCtx == null) {
      const skipped = {
        prefillTokens: plan.prefillTokens,
        decodeTokens: plan.decodeTokens,
        status: 'skipped',
        requestedPromptTokens: plan.prefillTokens,
        promptTokens: null,
        promptCoveragePct: null,
        minimumPromptCoveragePct: MIN_PROMPT_COVERAGE_RATIO * 100,
        completionTokens: null,
        prefillTokensPerSec: null,
        decodeTokensPerSec: null,
        promptEvalDurationMs: null,
        evalDurationMs: null,
        runtimeContextLength: null,
        latencyMs: null,
        error: `Requires ${plan.requiredCtx} ctx > safe ${options.safeNumCtx}`
      };
      cells.push(skipped);
      notify({ index, total, cell: skipped });
      continue;
    }

    const samples = [];
    for (let repeat = 1; repeat <= repeats; repeat += 1) {
      options.assertClaimActive?.();
      const sample = await _runCell(hostUrl, modelName, plan, numCtx, timeoutMs, options.signal);
      options.assertClaimActive?.();
      samples.push({ ...sample, repeat });
      if (sample.status !== 'pass') break;
    }
    const result = aggregateCellSamples(samples, plan, numCtx, repeats);
    cells.push(result);
    notify({ index, total, cell: result });

    if (result.status === 'error') {
      logger.warn('Prefill/decode matrix cell failed', {
        modelName, hostUrl,
        prefill: plan.prefillTokens, decode: plan.decodeTokens,
        error: result.error
      });
    }
  }

  const passing = cells.filter((c) => c.status === 'pass');
  return {
    measuredAt: new Date(),
    numCtx,
    repeats,
    prefillTokens,
    decodeTokens,
    cellCount: cells.length,
    passCount: passing.length,
    skippedCount: cells.filter((c) => c.status === 'skipped').length,
    cells
  };
}

module.exports = {
  runPrefillDecodeMatrix,
  getMatrixConfig,
  planMatrix,
  DEFAULT_PREFILL_TOKENS,
  DEFAULT_DECODE_TOKENS,
  CELL_CTX_MARGIN,
  MIN_PROMPT_COVERAGE_RATIO,
  DEFAULT_REPEATS,
  _internal: { _parseTokenList, _runCell, summarizeMetric, aggregateCellSamples }
};
