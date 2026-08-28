'use strict';

/**
 * Model-intake scanner (B5 — llmfit's HF scraper idea, adapted to this stack).
 *
 * Turns raw HuggingFace model metadata into prioritized intake-queue records so
 * candidate models stop being discovered ad hoc. Reuses the
 * existing fit math (modelFitEstimator / parameterDetection) — NO duplicated
 * VRAM/quant logic — and is pure + DI-tested: the network fetch is injected, so
 * this module needs no HTTP. Callers provide intake data explicitly; network
 * discovery and caching remain outside this product service.
 *
 * Output candidate-intake record: model, source, params, activeParams, moe,
 * quants, ggufSources, vramFitByHost, suggestedHost, expectedLane, priority,
 * intakeDate, profileStatus, benchmarkStatus, decision.
 */

const { parseParameterCount } = require('../parameterDetection');
const { parseActiveParams, selectBestQuantForVram } = require('../modelFitEstimator');

const PRIORITY_RANK = { high: 3, medium: 2, low: 1 };

/** Best-fitting quant per host (reuses modelFitEstimator quant-walk). */
function fitByHost(effParams, hostsVram, numCtx) {
  if (!Number.isFinite(Number(numCtx)) || Number(numCtx) <= 0) return {};
  const out = {};
  for (const [host, vram] of Object.entries(hostsVram)) {
    const r = selectBestQuantForVram({ paramBillions: effParams, hostVramMiB: vram, numCtx: Number(numCtx) });
    out[host] = r.fits ? { quant: r.quantization, numCtx: r.num_ctx, vramMiB: r.estVramMiB } : null;
  }
  return out;
}

/** Smallest host (by VRAM) the model fits fully-resident, or null. */
function suggestHost(fit, hostsVram) {
  const order = Object.keys(hostsVram).sort((a, b) => hostsVram[a] - hostsVram[b]);
  for (const host of order) {
    if (fit[host]) return host;
  }
  return null;
}

function computePriority(hfModel, suggestedHost, fitKnown = true) {
  if (fitKnown && !suggestedHost) return 'low';
  const downloads = Number(hfModel.downloads) || 0;
  const likes = Number(hfModel.likes) || 0;
  if (downloads >= 100000 || likes >= 1000) return 'high';
  if (downloads >= 10000 || likes >= 100) return 'medium';
  return 'low';
}

/**
 * Build one intake record from raw HF model metadata.
 * @param {object} hfModel - { id|modelId|model, downloads?, likes?, quants?, ggufSources?, params? }
 * @param {object} [opts] - { hostsVram?, date? }
 */
function buildIntakeRecord(hfModel = {}, opts = {}) {
  const hostsVram = opts.hostsVram || {};
  const id = hfModel.id || hfModel.modelId || hfModel.model || null;
  const params = parseParameterCount(id) ?? parseParameterCount(hfModel.params) ?? null;
  const activeParams = parseActiveParams(id);
  const effParams = activeParams ?? params;
  const numCtx = Number.isFinite(Number(opts.numCtx)) && Number(opts.numCtx) > 0
    ? Number(opts.numCtx)
    : null;
  const fit = effParams != null ? fitByHost(effParams, hostsVram, numCtx) : {};
  const suggestedHost = suggestHost(fit, hostsVram);

  return {
    model: id,
    source: hfModel.source || (id ? `huggingface:${id}` : null),
    params,
    activeParams,
    moe: activeParams != null,
    quants: hfModel.quants || [],
    ggufSources: hfModel.ggufSources || [],
    vramFitByHost: fit,
    suggestedHost,
    expectedLane: hfModel.expectedLane || null,
    priority: computePriority(hfModel, suggestedHost, Object.keys(hostsVram).length > 0 && numCtx != null),
    intakeDate: opts.date || null,
    profileStatus: 'pending',
    benchmarkStatus: 'pending',
    decision: 'pending'
  };
}

/** Build + priority-sort intake records from a list of HF models. */
function scanIntake({ models = [], hostsVram, numCtx, date } = {}) {
  return models
    .map((m) => buildIntakeRecord(m, { hostsVram, numCtx, date }))
    .sort((a, b) => (PRIORITY_RANK[b.priority] || 0) - (PRIORITY_RANK[a.priority] || 0));
}

/**
 * Gather + scan candidates across families using an INJECTED per-family fetch
 * (so this stays network-agnostic and testable). Fetch failures for one family
 * are logged via `onWarn` and skipped — a partial queue still beats none.
 * @param {object} args
 * @param {string[]} args.families
 * @param {number} [args.limit=15]
 * @param {function} args.fetchFamily - async (family, limit) => [{id,downloads,likes}]
 * @param {object} [args.hostsVram]
 * @param {string} [args.date]
 * @param {function} [args.onWarn]
 * @returns {Promise<Array>} prioritized intake records (deduped by model id)
 */
async function gatherCandidates({ families = [], limit = 15, fetchFamily, hostsVram, numCtx, date, onWarn } = {}) {
  if (typeof fetchFamily !== 'function') throw new Error('fetchFamily dependency is required');
  const warn = typeof onWarn === 'function' ? onWarn : () => {};
  const collected = [];
  for (const family of families) {
    try {
      const models = await fetchFamily(family, limit);
      collected.push(...(Array.isArray(models) ? models : []));
    } catch (err) {
      warn(`fetch failed for "${family}": ${err.message}`);
    }
  }
  const seen = new Set();
  const deduped = collected.filter((m) => m && m.id && !seen.has(m.id) && seen.add(m.id));
  return scanIntake({ models: deduped, hostsVram, numCtx, date });
}

/** Render candidate-intake records as a markdown queue view. */
function formatIntakeTable(records) {
  const header = '| Priority | Model | Lane | Host | Params | MoE | Fit (host quant) | Decision |\n'
    + '|---|---|---|---|---|---|---|---|';
  const rows = records.map((r) => {
    const fit = r.suggestedHost && r.vramFitByHost[r.suggestedHost]
      ? `${r.suggestedHost} ${r.vramFitByHost[r.suggestedHost].quant} ~${r.vramFitByHost[r.suggestedHost].vramMiB}MiB`
      : '—';
    return `| ${r.priority} | \`${r.model}\` | ${r.expectedLane || '—'} | ${r.suggestedHost || '—'} | ${r.params ?? '?'}${r.moe ? ` (a${r.activeParams})` : ''} | ${r.moe ? 'yes' : 'no'} | ${fit} | ${r.decision} |`;
  });
  return [header, ...rows].join('\n');
}

module.exports = {
  fitByHost,
  suggestHost,
  computePriority,
  buildIntakeRecord,
  scanIntake,
  gatherCandidates,
  formatIntakeTable
};
