'use strict';

/**
 * Fixed prefill/decode profiler matrix (task 0365).
 *
 * Runs a grid of FIXED absolute workloads — prefill (prompt) token sizes ×
 * decode (generation) lengths — against a model on one host, and records
 * prefill tok/s, decode tok/s, TTFT and latency for every cell.
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

const { generate } = require('../../clients/ollamaClient');
const { generateFillPrompt } = require('../contextProbePayload');
const logger = require('../../../config/logger');

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

async function _runCell(hostUrl, modelName, cellPlan, numCtx, timeoutMs) {
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
        temperature: 0.1
      }
    }, { timeoutMs });

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
    const ttftMs = promptEvalDuration > 0
      ? Number((promptEvalDuration / 1e6).toFixed(1))
      : null;

    const shortCompletion = evalCount < Math.max(1, Math.floor(decodeTokens * MIN_COMPLETION_RATIO));

    return {
      prefillTokens,
      decodeTokens,
      status: shortCompletion ? 'short_completion' : 'pass',
      promptTokens: promptEvalCount,
      completionTokens: evalCount,
      prefillTokensPerSec,
      decodeTokensPerSec,
      ttftMs,
      latencyMs,
      error: shortCompletion
        ? `Completion ${evalCount}/${decodeTokens} tokens — decode sample invalid`
        : null
    };
  } catch (err) {
    return {
      prefillTokens,
      decodeTokens,
      status: 'error',
      promptTokens: null,
      completionTokens: null,
      prefillTokensPerSec: null,
      decodeTokensPerSec: null,
      ttftMs: null,
      latencyMs: Date.now() - start,
      error: err.message
    };
  }
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

  const { cells: plannedCells, numCtx } = planMatrix(prefillTokens, decodeTokens, options.safeNumCtx);
  const cells = [];
  const total = plannedCells.length;
  let index = 0;

  for (const plan of plannedCells) {
    index += 1;
    if (!plan.fits || numCtx == null) {
      const skipped = {
        prefillTokens: plan.prefillTokens,
        decodeTokens: plan.decodeTokens,
        status: 'skipped',
        promptTokens: null,
        completionTokens: null,
        prefillTokensPerSec: null,
        decodeTokensPerSec: null,
        ttftMs: null,
        latencyMs: null,
        error: `Requires ${plan.requiredCtx} ctx > safe ${options.safeNumCtx}`
      };
      cells.push(skipped);
      notify({ index, total, cell: skipped });
      continue;
    }

    const result = await _runCell(hostUrl, modelName, plan, numCtx, timeoutMs);
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
  _internal: { _parseTokenList, _runCell }
};
