'use strict';

/**
 * Model-intake scanner (B5 — llmfit's HF scraper idea, adapted to this stack).
 *
 * Turns raw HuggingFace model metadata into prioritized intake-queue records so
 * candidate models stop being discovered ad hoc (Backlog D). Reuses the
 * existing fit math (modelFitEstimator / parameterDetection) — NO duplicated
 * VRAM/quant logic — and is pure + DI-tested: the network fetch is injected, so
 * this module needs no HTTP. The thin CLI (`scripts/hf-intake.js`) wires the
 * real HF fetch + cache.
 *
 * Output record (Backlog D shape): model, source, params, activeParams, moe,
 * quants, ggufSources, vramFitByHost, suggestedHost, expectedLane, priority,
 * intakeDate, profileStatus, benchmarkStatus, decision.
 */

const { parseParameterCount } = require('../parameterDetection');
const { parseActiveParams, selectBestQuantForVram } = require('../modelFitEstimator');

// AgentX Ollama fleet VRAM (MiB), smallest → largest. Slugs match the router.
const FLEET_VRAM = { tertiary: 12288, secondary: 16303, primary: 49152 };
const HOST_ORDER = ['tertiary', 'secondary', 'primary']; // prefer the smallest host that fits

const PRIORITY_RANK = { high: 3, medium: 2, low: 1 };

/** Heuristic lane suggestion from the model id + size. */
function suggestLane(modelId) {
  const s = String(modelId || '').toLowerCase();
  const p = parseParameterCount(modelId) ?? parseActiveParams(modelId);
  if (/coder|code/.test(s)) return p != null && p >= 27 ? 'deep' : 'daily';
  if (/embed/.test(s)) return 'utility';
  if (p == null) return 'generalist';
  if (p <= 5) return 'utility';
  if (p <= 12) return 'lightweight';
  if (p <= 32) return 'generalist';
  return 'deep';
}

/** Best-fitting quant per host (reuses modelFitEstimator quant-walk). */
function fitByHost(effParams, hostsVram) {
  const out = {};
  for (const [host, vram] of Object.entries(hostsVram)) {
    const r = selectBestQuantForVram({ paramBillions: effParams, hostVramMiB: vram, numCtx: 8192 });
    out[host] = r.fits ? { quant: r.quantization, numCtx: r.num_ctx, vramMiB: r.estVramMiB } : null;
  }
  return out;
}

/** Smallest host (by VRAM) the model fits fully-resident, or null. */
function suggestHost(fit, hostsVram) {
  const order = Object.keys(hostsVram).sort((a, b) => hostsVram[a] - hostsVram[b]);
  for (const host of (order.length ? order : HOST_ORDER)) {
    if (fit[host]) return host;
  }
  return null;
}

function computePriority(hfModel, suggestedHost) {
  if (!suggestedHost) return 'low'; // does not fit the fleet at all
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
  const hostsVram = opts.hostsVram || FLEET_VRAM;
  const id = hfModel.id || hfModel.modelId || hfModel.model || null;
  const params = parseParameterCount(id) ?? parseParameterCount(hfModel.params) ?? null;
  const activeParams = parseActiveParams(id);
  const effParams = activeParams ?? params;
  const fit = effParams != null ? fitByHost(effParams, hostsVram) : {};
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
    expectedLane: suggestLane(id),
    priority: computePriority(hfModel, suggestedHost),
    intakeDate: opts.date || null,
    profileStatus: 'pending',
    benchmarkStatus: 'pending',
    decision: 'pending'
  };
}

/** Build + priority-sort intake records from a list of HF models. */
function scanIntake({ models = [], hostsVram, date } = {}) {
  return models
    .map((m) => buildIntakeRecord(m, { hostsVram, date }))
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
async function gatherCandidates({ families = [], limit = 15, fetchFamily, hostsVram, date, onWarn } = {}) {
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
  return scanIntake({ models: deduped, hostsVram, date });
}

/** Render intake records as a markdown table (Backlog D queue view). */
function formatIntakeTable(records) {
  const header = '| Priority | Model | Lane | Host | Params | MoE | Fit (host quant) | Decision |\n'
    + '|---|---|---|---|---|---|---|---|';
  const rows = records.map((r) => {
    const fit = r.suggestedHost && r.vramFitByHost[r.suggestedHost]
      ? `${r.suggestedHost} ${r.vramFitByHost[r.suggestedHost].quant} ~${r.vramFitByHost[r.suggestedHost].vramMiB}MiB`
      : '—';
    return `| ${r.priority} | \`${r.model}\` | ${r.expectedLane} | ${r.suggestedHost || '—'} | ${r.params ?? '?'}${r.moe ? ` (a${r.activeParams})` : ''} | ${r.moe ? 'yes' : 'no'} | ${fit} | ${r.decision} |`;
  });
  return [header, ...rows].join('\n');
}

module.exports = {
  FLEET_VRAM,
  suggestLane,
  fitByHost,
  suggestHost,
  computePriority,
  buildIntakeRecord,
  scanIntake,
  gatherCandidates,
  formatIntakeTable
};
