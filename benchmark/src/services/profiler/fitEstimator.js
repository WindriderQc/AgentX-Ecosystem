'use strict';

/**
 * Fit Estimator — pure functions for the Host Fit Report.
 *
 * Dependency-light by design: requires ONLY parameterDetection (itself a
 * self-contained, zero-dependency module). No Mongo, no HTTP, no logger. This
 * keeps the fit math unit-testable in isolation and lets it run anywhere.
 *
 * Concept (profiler vs https://github.com/AlexsJones/llmfit): llmfit estimates
 * fit from specs using generic per-backend bandwidth constants. Here, the
 * throughput model is CALIBRATED from a host's own measured profiles, so the
 * estimate self-corrects to the real hardware instead of trusting a constant.
 *
 * MoE-aware: for mixture-of-experts models (e.g. "...:35b-a3b", "...:26b-a4b")
 * VRAM is governed by TOTAL params (Ollama keeps all experts resident) but
 * decode THROUGHPUT is governed by the ACTIVE expert params — so we estimate
 * speed from the active count, not the total. (llmfit does the analogous thing.)
 */

const {
  parseParameterCount,
  parseQuantization,
  bytesPerParam,
  estimateTotalVram
} = require('../parameterDetection');

const MIB = 1024 * 1024;

// Quantization quality ladder, best → most compressed (llmfit's dynamic-quant idea).
const QUANT_LADDER = ['Q8_0', 'Q6_K', 'Q5_K_M', 'Q4_K_M', 'Q3_K_M', 'Q2_K'];

// Generic fallback for the throughput constant K (tok/s × weight-GB), used only
// when a host has zero measured points. ~220 matches llmfit's CUDA bandwidth
// constant and yields ~56 tok/s for a 7B-Q4 — deliberately conservative.
const GENERIC_K = 220;

// MoE decode efficiency vs a dense model of the same active size (routing +
// shared-attention overhead). Matches llmfit's MoE-offload multiplier.
const MOE_EFFICIENCY = 0.8;

// Per-use-case dimension weights for the composite fit score (sum ≈ 1.0).
const USE_CASE_WEIGHTS = {
  general:        { quality: 0.30, speed: 0.25, fit: 0.25, context: 0.20 },
  coding:         { quality: 0.35, speed: 0.30, fit: 0.20, context: 0.15 },
  reasoning:      { quality: 0.55, speed: 0.15, fit: 0.15, context: 0.15 },
  chat:           { quality: 0.20, speed: 0.40, fit: 0.25, context: 0.15 },
  'long-context': { quality: 0.30, speed: 0.10, fit: 0.20, context: 0.40 }
};

function round(n, p = 0) {
  return Number.isFinite(Number(n)) ? Number(Number(n).toFixed(p)) : null;
}

function clamp(n, lo, hi) {
  return Math.max(lo, Math.min(hi, n));
}

function median(arr) {
  if (!arr.length) return null;
  const s = [...arr].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/** Weight footprint in GB (≈ the bytes read per decoded token). */
function paramGB(paramB, quant) {
  return (Number(paramB) || 0) * bytesPerParam(quant);
}

// ── MoE detection ────────────────────────────────────────────────────────────

/** Parse the ACTIVE expert param count from a MoE model name ("...-a3b" → 3). */
function parseActiveParams(name) {
  if (!name) return null;
  const m = String(name).toLowerCase().match(/[:\-_]a(\d+(?:\.\d+)?)b\b/);
  return m ? parseFloat(m[1]) : null;
}

/** The param count that drives THROUGHPUT: active experts for MoE, else total. */
function throughputParamsB(paramB, modelName) {
  const active = parseActiveParams(modelName);
  return (active && paramB && active < paramB) ? active : paramB;
}

function isMoE(modelOrName, paramB) {
  const name = typeof modelOrName === 'string' ? modelOrName : modelOrName?.modelName;
  const total = paramB != null ? paramB : (typeof modelOrName === 'object' ? modelOrName?.paramB : null);
  const active = parseActiveParams(name);
  return !!(active && total && active < total);
}

/** Resolve the host's total VRAM (MiB) from the best available source. */
function resolveHostVram(host, telemetry) {
  const live = Number(telemetry?.vramTotalMiB);
  if (Number.isFinite(live) && live > 0) {
    return { vramTotalMiB: Math.round(live), source: telemetry.source || 'live-probe' };
  }
  const cfg = Number(host?.gpu?.vramTotalMiB);
  if (Number.isFinite(cfg) && cfg > 0) {
    return { vramTotalMiB: Math.round(cfg), source: 'host-profile' };
  }
  return { vramTotalMiB: null, source: 'unknown' };
}

/**
 * Measured fit level from real VRAM utilization + spill + measurement reliability.
 * llmfit treats ~50–80% utilization as the sweet spot; we anchor on measured
 * data and bias toward practical safety (spill / near-full = risky).
 */
function measuredFitLevel({ vramPct, spillDetected, reliability }) {
  if (spillDetected) return { level: 'spills', label: 'Spills', tone: 'crit' };
  if (vramPct == null) {
    return reliability === 'low'
      ? { level: 'unverified', label: 'Runs (low confidence)', tone: 'warn' }
      : { level: 'runs', label: 'Runs', tone: 'ok' };
  }
  if (vramPct > 90) return { level: 'tight', label: 'Tight', tone: 'warn' };
  if (vramPct >= 50) return { level: 'good', label: 'Good fit', tone: 'ok' };
  return { level: 'comfortable', label: 'Comfortable', tone: 'ok' };
}

/**
 * The subset of measured models suitable for fitting the bandwidth model.
 * Excludes spilled, near-full (>85% VRAM), and MoE profiles: the first two are
 * memory-CAPACITY bound and MoE runs on active (not total) params, so all three
 * would distort a dense bandwidth constant. Falls back to all positive-throughput
 * profiles if filtering leaves nothing (e.g. an all-MoE small-GPU host).
 */
function calibrationSet(measured) {
  const all = (measured || []).filter(m => m.paramB && m.tokensPerSec > 0);
  const clean = all.filter(m =>
    !m.spillDetected && (m.vramPct == null || m.vramPct <= 85) && !isMoE(m.modelName, m.paramB));
  return clean.length ? clean : all;
}

function _confidence(ks) {
  if (ks.length < 2) return { cv: null, confidence: ks.length ? 'low' : 'unknown' };
  const mean = ks.reduce((s, n) => s + n, 0) / ks.length;
  const variance = ks.reduce((s, n) => s + ((n - mean) ** 2), 0) / ks.length;
  const cv = mean > 0 ? Math.sqrt(variance) / mean : null;
  return { cv: round(cv, 3), confidence: cv == null ? 'unknown' : cv <= 0.2 ? 'high' : cv <= 0.4 ? 'medium' : 'low' };
}

/** Clean MoE measured points, for calibrating the MoE throughput constant. */
function moeCalibrationSet(measured) {
  return (measured || []).filter(m =>
    m.paramB && m.tokensPerSec > 0 && isMoE(m.modelName, m.paramB) &&
    !m.spillDetected && (m.vramPct == null || m.vramPct <= 85));
}

/**
 * Fit a throughput model from the host's measured points. Decode throughput is
 * memory-bandwidth-bound: tok/s ≈ K / weightGB. We fit TWO constants because
 * MoE and dense models live on different curves:
 *   K    — dense models, from TOTAL weight-GB
 *   Kmoe — MoE models, from ACTIVE weight-GB. Calibrating Kmoe from the host's
 *          own MoE profiles captures the real MoE overhead (routing + shared
 *          attention), which active-param count alone would overstate. Falls
 *          back to K × MOE_EFFICIENCY when the host has no MoE profiles.
 */
function buildThroughputModel(measured, baseline) {
  const dense = calibrationSet(measured)
    .map(m => m.tokensPerSec * paramGB(m.paramB, m.quant))
    .filter(k => Number.isFinite(k) && k > 0);
  const moe = moeCalibrationSet(measured)
    .map(m => m.tokensPerSec * paramGB(parseActiveParams(m.modelName), m.quant))
    .filter(k => Number.isFinite(k) && k > 0);

  let model;
  if (dense.length) {
    model = { K: median(dense), source: 'profiles', nPoints: dense.length, ..._confidence(dense) };
  } else {
    const bp = parseParameterCount(baseline?.referenceModel);
    if (baseline?.tokensPerSec > 0 && bp) {
      model = { K: baseline.tokensPerSec * paramGB(bp, parseQuantization(baseline.referenceModel)), source: 'baseline', nPoints: 1, cv: null, confidence: 'low' };
    } else {
      model = { K: GENERIC_K, source: 'generic', nPoints: 0, cv: null, confidence: 'low' };
    }
  }

  if (moe.length) {
    model.Kmoe = median(moe);
    model.moeSource = 'profiles';
    model.moeNPoints = moe.length;
  } else {
    model.Kmoe = model.K * MOE_EFFICIENCY;
    model.moeSource = model.source === 'generic' ? 'generic' : 'derived';
    model.moeNPoints = 0;
  }
  return model;
}

/** Estimate tok/s. MoE uses ACTIVE params against the MoE throughput constant. */
function estTpsFromModel(tm, paramB, quant, modelName) {
  if (!tm || !paramB) return null;
  const active = throughputParamsB(paramB, modelName);
  if (active < paramB) {
    const k = tm.Kmoe || (tm.K ? tm.K * MOE_EFFICIENCY : null);
    const gb = paramGB(active, quant);
    return (k && gb > 0) ? round(k / gb, 1) : null;
  }
  const gb = paramGB(paramB, quant);
  return (tm.K && gb > 0) ? round(tm.K / gb, 1) : null;
}

/** Highest-quality quant that fits a target context within 90% of VRAM. */
function recommendQuant(paramB, vramTotalMiB, targetCtx) {
  if (!paramB || !vramTotalMiB || !targetCtx) return null;
  for (const q of QUANT_LADDER) {
    if (estimateTotalVram(paramB, q, targetCtx) / MIB <= vramTotalMiB * 0.9) return q;
  }
  return null;
}

/** llmfit-style estimated fit for a model we have NOT profiled on this host. */
function estimateFit({ paramB, quant, vramTotalMiB }) {
  if (!paramB || !vramTotalMiB) {
    return { verdict: 'unknown', estMaxCtx: null, estVramAt8kMiB: null, estVramPctAt8k: null, recommendedQuant: null };
  }
  const budgetMiB = vramTotalMiB * 0.9;
  const minNeededMiB = estimateTotalVram(paramB, quant, 2048) / MIB;
  const at8kMiB = estimateTotalVram(paramB, quant, 8192) / MIB;

  let verdict;
  if (minNeededMiB > budgetMiB) verdict = 'too-large';
  else if (at8kMiB <= budgetMiB) verdict = 'fits';
  else verdict = 'tight';

  const rq = (verdict === 'too-large' || verdict === 'tight')
    ? recommendQuant(paramB, vramTotalMiB, 8192)
    : null;
  return {
    verdict,
    estMaxCtx: null,
    estVramAt8kMiB: round(at8kMiB),
    estVramPctAt8k: round((at8kMiB / vramTotalMiB) * 100),
    recommendedQuant: rq && rq !== (quant || '').toUpperCase() ? rq : null
  };
}

/** Largest dense model (in B params) this host could run at Q4_K_M / 8k ctx. */
function largestRunnableParamsB(vramTotalMiB) {
  if (!vramTotalMiB) return null;
  const sizes = [400, 235, 120, 70, 32, 27, 14, 8, 4, 3, 1];
  for (const b of sizes) {
    if (estimateTotalVram(b, 'Q4_K_M', 8192) / MIB <= vramTotalMiB * 0.9) return b;
  }
  return null;
}

// ── Composite scoring (llmfit's 4 weighted dimensions) ───────────────────────

function scoreSpeed(tps) {
  return tps == null ? null : clamp(Math.round(tps), 0, 100); // 100 tok/s → 100
}

function scoreFit(vramPct, spillDetected) {
  if (spillDetected) return 15;
  if (vramPct == null) return 75;
  if (vramPct <= 50) return Math.round(70 + (vramPct / 50) * 30);       // 70→100 (room to spare)
  if (vramPct <= 80) return 100;                                         // sweet spot
  if (vramPct <= 90) return Math.round(100 - (vramPct - 80) * 4);       // 100→60
  return Math.max(0, Math.round(60 - (vramPct - 90) * 6));              // 60→0
}

/** Quality from real benchmark score when available, else a params+quant proxy. */
function scoreQuality(paramB, quant, benchmarkScore) {
  if (benchmarkScore != null) return clamp(Math.round(benchmarkScore), 0, 100);
  if (!paramB) return null;
  const base = 30 + Math.log2(paramB) * 18; // 3B≈58, 7B≈81, 14B≈99, 32B+→100
  const q = (quant || '').toUpperCase();
  const penalty = q.startsWith('Q2') ? 25 : q.startsWith('Q3') ? 15 : q.startsWith('Q4') ? 8
    : q.startsWith('Q5') ? 5 : q.startsWith('Q6') ? 3 : 0;
  return clamp(Math.round(base - penalty), 0, 100);
}

function scoreContext(ctx) {
  if (!ctx) return null;
  return clamp(Math.round(40 + Math.log2(ctx / 2048) * 15), 0, 100); // 2k→40,8k→70,32k→100
}

/**
 * Per-dimension scores (0–100, each nullable). For MoE, quality uses TOTAL
 * params (knowledge capacity) while speed already reflects active throughput.
 */
function dimensionScores({ tps, vramPct, spillDetected, benchmarkScore, paramB, quant, ctx }) {
  return {
    speed: scoreSpeed(tps),
    fit: scoreFit(vramPct, spillDetected),
    quality: scoreQuality(paramB, quant, benchmarkScore),
    context: scoreContext(ctx)
  };
}

/** Weighted composite for a use-case, renormalized over present dimensions. */
function compositeScore(dims, useCase) {
  const w = USE_CASE_WEIGHTS[useCase] || USE_CASE_WEIGHTS.general;
  let sum = 0;
  let wsum = 0;
  for (const k of ['quality', 'speed', 'fit', 'context']) {
    if (dims && dims[k] != null) { sum += w[k] * dims[k]; wsum += w[k]; }
  }
  return wsum > 0 ? Math.round(sum / wsum) : null;
}

/** Most capable model measured to run cleanly (no spill, not maxed). */
function pickRecommended(measured) {
  const safe = (measured || [])
    .filter(m => !m.spillDetected && (m.vramPct == null || m.vramPct <= 90))
    .sort((a, b) => (b.paramB || 0) - (a.paramB || 0) || (b.tokensPerSec || 0) - (a.tokensPerSec || 0));
  if (!safe.length) return null;
  const top = safe[0];
  const bits = ['largest model measured to run without spill'];
  if (top.vramPct != null) bits.push(`${top.vramPct}% VRAM`);
  if (top.tokensPerSec != null) bits.push(`${top.tokensPerSec} tok/s`);
  if (top.optimalNumCtx) bits.push(`up to ${top.optimalNumCtx} ctx`);
  return { modelName: top.modelName, adaptedName: top.adaptedName || null, reason: bits.join(' · ') };
}

/** Highest benchmark-scored model that also fits cleanly. */
function pickBestBenchmarked(measured) {
  const scored = (measured || [])
    .filter(m => !m.spillDetected && (m.vramPct == null || m.vramPct <= 90) && m.score != null)
    .sort((a, b) => (b.score || 0) - (a.score || 0));
  if (!scored.length) return null;
  const top = scored[0];
  const bits = [`top benchmark score (${round(top.score, 1)})`];
  if (top.bestCategory) bits.push(`best at ${top.bestCategory}`);
  if (top.tokensPerSec != null) bits.push(`${top.tokensPerSec} tok/s`);
  return { modelName: top.modelName, score: round(top.score, 1), bestCategory: top.bestCategory || null, reason: bits.join(' · ') };
}

module.exports = {
  MIB,
  QUANT_LADDER,
  GENERIC_K,
  MOE_EFFICIENCY,
  USE_CASE_WEIGHTS,
  round,
  clamp,
  median,
  paramGB,
  parseActiveParams,
  throughputParamsB,
  isMoE,
  resolveHostVram,
  measuredFitLevel,
  calibrationSet,
  moeCalibrationSet,
  buildThroughputModel,
  estTpsFromModel,
  recommendQuant,
  estimateFit,
  largestRunnableParamsB,
  dimensionScores,
  compositeScore,
  pickRecommended,
  pickBestBenchmarked
};
