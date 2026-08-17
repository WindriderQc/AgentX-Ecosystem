/**
 * Model Fit Estimator (analytical layer) — llmfit-derived
 *
 * Predictive/analytical primitives that COMPLEMENT AgentX's empirical
 * profiling + benchmarking. They are cheap pre-filters and sanity-bounds,
 * NOT a replacement for measured `ModelProfile` data: a real profile always
 * wins. See docs/benchmark/master-optimization-plan-2026-06-18.md (Track B).
 *
 * Provides:
 *   B1  physicalCeilingTokSec / estimateTokSec / isImplausibleThroughput
 *   B2  selectBestQuantForVram (quantization-walk fit)
 *   B3  parseActiveParams / effectiveThroughputParams (MoE active-param math)
 *
 * Throughput model (memory-bound, llmfit-style):
 *   tok/s ≈ (hostBandwidthGBs / activeWeightGiB) × efficiency
 * The *physical ceiling* uses efficiency = 1.0 (cannot be exceeded by physics),
 * so any observed reading above it (× margin) is an instrumentation artifact.
 *
 * Reuses the shared VRAM math exposed by ./parameterDetection.
 */

const {
  parseParameterCount,
  parseQuantization,
  bytesPerParam,
  estimateTotalVram
} = require('./parameterDetection');

const GIB = 1024 * 1024 * 1024;
const QWEN35MOE_ACTIVE_PARAMS_B = 3;

/**
 * Reference memory bandwidth (GB/s) for common GPUs, plus a CUDA fallback.
 * Vendor spec figures; used only for analytical bounds, calibrate the
 * efficiency factor from hostperformancesnapshots for predictions.
 */
const GPU_BANDWIDTH_GBS = {
  'rtx 3090': 936,
  'rtx 3080 ti': 912,
  'rtx 5070 ti': 896,
  _cuda_fallback: 900
};

/**
 * Resolve memory bandwidth from GPU metadata. Host addresses never imply
 * hardware; callers without GPU metadata must use measured profiles.
 * @param {string} hint - e.g. "RTX 3090"
 * @returns {number|null} GB/s, or null if unresolved
 */
function resolveHostBandwidthGBs(hint) {
  if (!hint) return null;
  const s = String(hint).toLowerCase();
  for (const [name, bw] of Object.entries(GPU_BANDWIDTH_GBS)) {
    if (name.startsWith('_')) continue;
    if (s.includes(name)) return bw;
  }
  return null;
}

/**
 * B3 — Parse MoE active-parameter count (billions) from a model name.
 * Recognizes `aNb` (Qwen/Gemma active-param tag, e.g. "35b-a3b", "26b-a4b")
 * and `eNb` (Gemma "effective" tag, e.g. "gemma4:e4b"). Dense models return
 * null (caller falls back to total params).
 * @param {string} modelName
 * @returns {number|null} active params in billions, or null if not MoE-tagged
 */
function parseActiveParams(modelName) {
  if (!modelName) return null;
  const s = String(modelName).toLowerCase();
  const active = s.match(/[-:_]a(\d+(?:\.\d+)?)b\b/);
  if (active) return parseFloat(active[1]);
  const eff = s.match(/[-:_]e(\d+(?:\.\d+)?)b\b/);
  if (eff) return parseFloat(eff[1]);
  return null;
}

function _metadataValue(modelInfo, suffix) {
  if (!modelInfo || typeof modelInfo !== 'object') return null;
  const entry = Object.entries(modelInfo).find(([key]) => String(key).endsWith(suffix));
  return entry ? entry[1] : null;
}

function inferKnownMoEActiveParams({ modelName, paramBillions, family, families, architecture, modelInfo } = {}) {
  const paramB = Number.isFinite(paramBillions) && paramBillions > 0
    ? paramBillions
    : parseParameterCount(modelName) || Number(_metadataValue(modelInfo, '.parameter_count')) / 1e9;

  const hints = [
    modelName,
    family,
    architecture,
    modelInfo?.['general.architecture'],
    ...(Array.isArray(families) ? families : [])
  ].filter(Boolean).map(v => String(v).toLowerCase());
  const joined = hints.join(' ');

  // Ollama's Ornith 35B tag is architecture=qwen35moe with 8/256 routed
  // experts, but its tag omits the usual "-a3b" active-param marker. Treat the
  // qwen35moe 30-40B family like Qwen's 35B-A3B line for decode ceilings.
  if ((joined.includes('qwen35moe') || joined.includes('ornith')) && paramB >= 30 && paramB <= 40) {
    return QWEN35MOE_ACTIVE_PARAMS_B;
  }

  return null;
}

/**
 * B3 — Effective parameter count that drives throughput. For MoE models this
 * is the active-expert subset; for dense models it is the total.
 * @param {{ modelName?: string, paramBillions?: number, activeParamBillions?: number }} args
 * @returns {number|null} billions, or null if undeterminable
 */
function effectiveThroughputParams(args = {}) {
  const { modelName, paramBillions, activeParamBillions } = args;
  if (Number.isFinite(activeParamBillions) && activeParamBillions > 0) return activeParamBillions;
  const active = parseActiveParams(modelName);
  if (Number.isFinite(active) && active > 0) return active;
  const knownMoE = inferKnownMoEActiveParams(args);
  if (Number.isFinite(knownMoE) && knownMoE > 0) return knownMoE;
  const total = Number.isFinite(paramBillions) && paramBillions > 0
    ? paramBillions
    : parseParameterCount(modelName);
  return Number.isFinite(total) && total > 0 ? total : null;
}

/**
 * B1 — Physical (un-exceedable) throughput ceiling in tok/s for a memory-bound
 * decode. efficiency = 1.0. Real throughput is a fraction of this; nothing can
 * legitimately exceed it.
 * @param {object} args
 * @param {string} [args.modelName]
 * @param {number} [args.paramBillions]
 * @param {number} [args.activeParamBillions]
 * @param {string} [args.quantization]
 * @param {number} args.hostBandwidthGBs - GB/s
 * @returns {number|null} tok/s ceiling, or null if inputs insufficient
 */
function physicalCeilingTokSec({ modelName, paramBillions, activeParamBillions, quantization, hostBandwidthGBs }) {
  const bw = Number.isFinite(hostBandwidthGBs) && hostBandwidthGBs > 0
    ? hostBandwidthGBs
    : resolveHostBandwidthGBs(modelName);
  if (!Number.isFinite(bw) || bw <= 0) return null;
  const effParams = effectiveThroughputParams({ modelName, paramBillions, activeParamBillions });
  if (!Number.isFinite(effParams) || effParams <= 0) return null;
  const quant = quantization || parseQuantization(modelName);
  const weightGiB = (effParams * 1e9 * bytesPerParam(quant)) / GIB;
  if (weightGiB <= 0) return null;
  // bandwidth is GB/s (1e9 bytes); weight in GiB → convert weight to GB for ratio.
  const weightGB = weightGiB * (GIB / 1e9);
  return bw / weightGB;
}

/**
 * B1 — Rough throughput prediction (efficiency-scaled). Default efficiency is
 * llmfit's 0.55, but it should be calibrated per host from measured snapshots.
 * Prefer a real ModelProfile when one exists.
 * @param {object} args - same as physicalCeilingTokSec plus:
 * @param {number} [args.efficiency=0.55]
 * @returns {number|null} predicted tok/s, or null
 */
function estimateTokSec(args) {
  const ceiling = physicalCeilingTokSec(args);
  if (ceiling == null) return null;
  const eff = Number.isFinite(args.efficiency) && args.efficiency > 0 ? args.efficiency : 0.55;
  return ceiling * eff;
}

/**
 * B1 — Implausibility check for an observed/profiled throughput. A reading
 * above the physical ceiling × marginFactor is an instrumentation artifact
 * (e.g. the qwopus high-context "1000000 tok/s" probe).
 * @param {number} observedTokSec
 * @param {object} args - same as physicalCeilingTokSec plus:
 * @param {number} [args.marginFactor=1.25] - tolerance above the hard ceiling
 * @returns {{ implausible: boolean, ceilingTokSec: number|null, reason: string }}
 */
function isImplausibleThroughput(observedTokSec, args = {}) {
  if (!Number.isFinite(observedTokSec) || observedTokSec <= 0) {
    return { implausible: false, ceilingTokSec: null, reason: 'no observed throughput' };
  }
  const ceiling = physicalCeilingTokSec(args);
  if (ceiling == null) {
    return { implausible: false, ceilingTokSec: null, reason: 'ceiling undeterminable — cannot judge' };
  }
  const margin = Number.isFinite(args.marginFactor) && args.marginFactor > 0 ? args.marginFactor : 1.25;
  const limit = ceiling * margin;
  // Throughput evidence and the operator-facing ceiling are recorded to one
  // decimal place. Allow one unit at that precision so a boundary reading
  // such as 69.4 tok/s is not rejected solely because the unrounded limit is
  // 69.333... tok/s. This is deliberately absolute and tiny: materially
  // impossible readings still fail the same physical-ceiling guard.
  const comparisonToleranceTokSec = 0.1;
  const implausible = observedTokSec > (limit + comparisonToleranceTokSec);
  return {
    implausible,
    ceilingTokSec: ceiling,
    reason: implausible
      ? `observed ${observedTokSec.toFixed(1)} tok/s exceeds physical ceiling ${ceiling.toFixed(1)} ×${margin} = ${limit.toFixed(1)}`
      : `observed ${observedTokSec.toFixed(1)} tok/s within ceiling ${ceiling.toFixed(1)} ×${margin}`
  };
}

const DEFAULT_QUANT_LADDER = ['Q8_0', 'Q6_K', 'Q5_K_M', 'Q4_K_M', 'Q3_K_M', 'Q2_K'];

/**
 * B2 — Quantization-walk fit. Walks a quality-descending quant ladder and
 * returns the highest-quality quant that fits the host VRAM at the requested
 * context. It never changes the requested context as a hidden fallback.
 * Uses estimateTotalVram from parameterDetection for the weight+KV+overhead math.
 * @param {object} args
 * @param {number} [args.paramBillions]
 * @param {string} [args.modelName] - used to derive paramBillions if not given
 * @param {number} args.hostVramMiB
 * @param {number} args.numCtx - explicit context to evaluate
 * @param {string[]} [args.ladder=DEFAULT_QUANT_LADDER]
 * @param {number} [args.utilization=0.9] - target VRAM utilization budget
 * @returns {{ fits: boolean, quantization: string|null, num_ctx: number, estVramMiB: number|null, reason: string }}
 */
function selectBestQuantForVram({
  paramBillions,
  modelName,
  hostVramMiB,
  numCtx,
  ladder = DEFAULT_QUANT_LADDER,
  utilization = 0.9
}) {
  const paramB = Number.isFinite(paramBillions) && paramBillions > 0
    ? paramBillions
    : parseParameterCount(modelName);
  if (!Number.isFinite(paramB) || paramB <= 0 || !Number.isFinite(hostVramMiB) || hostVramMiB <= 0
      || !Number.isFinite(numCtx) || numCtx <= 0) {
    return { fits: false, quantization: null, num_ctx: numCtx || null, estVramMiB: null, reason: 'insufficient inputs (paramBillions / hostVramMiB / numCtx)' };
  }
  const budgetBytes = hostVramMiB * 1024 * 1024 * utilization;
  for (const quant of ladder) {
    const needed = estimateTotalVram(paramB, quant, numCtx);
    if (Number.isFinite(needed) && needed <= budgetBytes) {
      const estVramMiB = Math.round(needed / 1024 / 1024);
      return {
        fits: true,
        quantization: quant,
        num_ctx: numCtx,
        estVramMiB,
        reason: `${paramB}B ${quant} @ ${numCtx} ctx ≈ ${estVramMiB} MiB ≤ ${Math.round(budgetBytes / 1024 / 1024)} MiB budget (${Math.round(utilization * 100)}% of ${hostVramMiB} MiB)`
      };
    }
  }
  return {
    fits: false,
    quantization: null,
    num_ctx: numCtx,
    estVramMiB: null,
    reason: `no quant in [${ladder.join(', ')}] fits ${paramB}B at the requested ${numCtx} context in ${hostVramMiB} MiB`
  };
}

module.exports = {
  GPU_BANDWIDTH_GBS,
  DEFAULT_QUANT_LADDER,
  resolveHostBandwidthGBs,
  parseActiveParams,
  effectiveThroughputParams,
  physicalCeilingTokSec,
  estimateTokSec,
  isImplausibleThroughput,
  selectBestQuantForVram
};
