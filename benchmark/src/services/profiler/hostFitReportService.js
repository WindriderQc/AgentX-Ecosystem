'use strict';

/**
 * Host Fit Report Service
 *
 * Builds a per-host "fit report" that answers, for one Ollama host:
 *   - which installed models we have MEASURED (real profiles) and how well they fit
 *   - which installed models are not yet profiled, with an ESTIMATED fit
 *     (llmfit-style VRAM math + a throughput model CALIBRATED from this host's
 *     own measured profiles — see fitEstimator.js)
 *   - recommendations (best fit + best benchmarked) and overall capacity
 *
 * This file is the IO/orchestration layer: it pulls HostProfile, live telemetry,
 * the installed model list, exact-artifact profiles, and ModelProfile metadata,
 * then composes the pure functions in ./fitEstimator into a report.
 */

const ModelPerformanceProfile = require('../../../models/ModelPerformanceProfile');
const ModelProfile = require('../../../models/ModelProfile');
const hostProfileService = require('./hostProfileService');
const liveProbeService = require('./liveProbeService');
const { checkHost } = require('../hostTestService');
const { normalizeModelName } = require('../modelContextResolver');
const { parseParameterCount, parseQuantization } = require('../parameterDetection');
const est = require('./fitEstimator');
const logger = require('../../../config/logger');

const MIB = est.MIB;

function hasProfilerAuthority(readiness, evidence) {
  const receipt = readiness?.authorityReceipt;
  return readiness?.benchmarkQualified === true
    && readiness?.stale !== true
    && ['standard', 'full'].includes(readiness?.profileDepth)
    && receipt?.source === 'profiler_pipeline'
    && Number(receipt.version) === 1
    && /^[a-f0-9]{64}$/i.test(String(receipt.digest || ''))
    && String(receipt.evidenceId || '') === String(readiness?.evidenceId || '')
    && String(readiness?.evidenceId || '') === String(evidence?._id || '');
}

/**
 * Build the full fit report for one host.
 * @param {string} hostId
 * @returns {Promise<object>}
 */
async function buildHostFitReport(hostId) {
  const host = await hostProfileService.getById(hostId);
  if (!host) {
    const err = new Error(`Host not found: ${hostId}`);
    err.statusCode = 404;
    throw err;
  }

  // Live telemetry (best effort) + installed model list (concurrent).
  let telemetry = null;
  let installedModels = [];
  const [probeRes, checkRes] = await Promise.allSettled([
    liveProbeService.getLiveProbeStatus(hostId),
    checkHost(host.hostUrl)
  ]);
  if (probeRes.status === 'fulfilled') telemetry = probeRes.value?.telemetry || null;
  else logger.debug(`fit-report: live probe failed for ${hostId}: ${probeRes.reason?.message}`);
  if (checkRes.status === 'fulfilled' && checkRes.value?.available) installedModels = checkRes.value.models || [];

  const { vramTotalMiB, source: vramSource } = est.resolveHostVram(host, telemetry);

  // Measured profiles for this host, keyed by normalized model name.
  const evidenceRecords = await ModelPerformanceProfile.find({ hostId, active: true, stale: { $ne: true } }).lean();
  const profileByModel = new Map();
  for (const evidence of evidenceRecords) {
    if (evidence?.profile) profileByModel.set(normalizeModelName(evidence.modelName), evidence);
  }

  // Registry metadata (params/quant/family/benchmark scores) for installed models.
  const installedNorm = [...new Set(installedModels.map(normalizeModelName))];
  const registry = installedNorm.length
    ? await ModelProfile.find({ name: { $in: installedNorm } })
      .select('name parameters quantization family benchmarkStats categories readiness').lean()
    : [];
  const metaByModel = new Map(registry.map(r => [normalizeModelName(r.name), r]));

  // ── Pass 1: measured rows ────────────────────────────────────────────────
  const measured = [];
  const unprofiled = [];
  for (const name of installedModels) {
    const norm = normalizeModelName(name);
    const meta = metaByModel.get(norm) || {};
    const paramB = parseParameterCount(meta.parameters) || parseParameterCount(name);
    const quant = parseQuantization(meta.quantization) || parseQuantization(name);
    const evidence = profileByModel.get(norm);
    const readiness = meta?.readiness instanceof Map
      ? meta.readiness.get(hostId)
      : meta?.readiness?.[hostId];
    const artifactMatches = Boolean(
      evidence?.artifact
      && readiness?.artifact
      && evidence.artifact.digest === readiness.artifact.digest
      && evidence.artifact.runtimeFingerprint === readiness.artifact.runtimeFingerprint
      && evidence.artifact.registryQualified === true
      && hasProfilerAuthority(readiness, evidence)
    );
    const p = artifactMatches && Number(evidence.profile?.recommendedInteractiveContext) > 0
      ? evidence.profile
      : null;
    const bench = meta.benchmarkStats || {};

    if (p) {
      const modelVramMiB = (p.spill?.sizeTotal ? p.spill.sizeTotal / MIB : null) ?? p.vramUsedMiB ?? null;
      const vramPct = (modelVramMiB && vramTotalMiB) ? est.round((modelVramMiB / vramTotalMiB) * 100) : null;
      const spillVerified = p.spill?.verified === true;
      const spillDetected = spillVerified ? !!p.spill?.spillDetected : null;
      const fit = est.measuredFitLevel({ vramPct, spillDetected, reliability: p.measurementQuality?.reliability });
      const tps = est.round(p.tokensPerSec, 1);
      const benchScore = bench.avgCompositeScore != null ? bench.avgCompositeScore : null;
      const activeB = est.parseActiveParams(name);
      const moeActiveB = (activeB && paramB && activeB < paramB) ? activeB : null;
      const dims = est.dimensionScores({
        tps, vramPct, spillDetected, benchmarkScore: benchScore, paramB, quant,
        ctx: p.recommendedInteractiveContext || null
      });
      measured.push({
        modelName: name,
        paramB,
        moeActiveB,
        quant,
        tokensPerSec: tps,
        ttftMs: est.round(p.ttftP50Ms),
        reliability: p.measurementQuality?.reliability || null,
        maxVerifiedContext: p.maxVerifiedContext || null,
        recommendedInteractiveContext: p.recommendedInteractiveContext || null,
        recommendedDocumentContext: p.recommendedDocumentContext || null,
        spillVerified,
        spillDetected,
        spillNumCtx: p.spill?.spillNumCtx || null,
        modelVramMiB: est.round(modelVramMiB),
        vramPct,
        coldLoadMs: est.round(p.loadTiming?.coldLoadMs),
        hotLoadMs: est.round(p.loadTiming?.hotLoadMs),
        artifact: evidence.artifact,
        profiledAt: p.profiledAt || null,
        score: benchScore,
        bestCategory: bench.bestCategory || null,
        dims,
        fit
      });
    } else {
      unprofiled.push({ name, paramB, quant, bench });
    }
  }

  // Calibrate the throughput model from the measured points (or fall back).
  const tm = est.buildThroughputModel(measured, host.baseline);

  // ── Pass 2: estimated rows (uses the calibrated throughput model) ─────────
  const estimated = unprofiled.map(({ name, paramB, quant, bench }) => {
    const ef = est.estimateFit({ paramB, quant, vramTotalMiB });
    const estTps = est.estTpsFromModel(tm, paramB, quant, name);
    const benchScore = bench.avgCompositeScore != null ? bench.avgCompositeScore : null;
    const activeB = est.parseActiveParams(name);
    const moeActiveB = (activeB && paramB && activeB < paramB) ? activeB : null;
    const dims = est.dimensionScores({
      tps: estTps, vramPct: ef.estVramPctAt8k, spillDetected: ef.verdict === 'too-large',
      benchmarkScore: benchScore, paramB, quant, ctx: ef.estMaxCtx
    });
    return {
      modelName: name,
      paramB,
      moeActiveB,
      quant,
      installed: true,
      estTokensPerSec: estTps,
      score: benchScore,
      bestCategory: bench.bestCategory || null,
      dims,
      ...ef
    };
  });

  // Back-test: accuracy of the calibrated estimator on the points it was fit
  // from (the bandwidth-representative subset, not capacity-bound outliers).
  let calibrationErrorPct = null;
  if (tm.source === 'profiles' && measured.length) {
    const errs = est.calibrationSet(measured)
      .map(m => {
        const pred = est.estTpsFromModel(tm, m.paramB, m.quant, m.modelName);
        return pred ? Math.abs(pred - m.tokensPerSec) / m.tokensPerSec : null;
      })
      .filter(e => e != null);
    if (errs.length) calibrationErrorPct = est.round((errs.reduce((s, e) => s + e, 0) / errs.length) * 100, 1);
  }

  // Stable, useful ordering: biggest models first within each section.
  measured.sort((a, b) => (b.paramB || 0) - (a.paramB || 0) || (b.tokensPerSec || 0) - (a.tokensPerSec || 0));
  estimated.sort((a, b) => (b.paramB || 0) - (a.paramB || 0));

  const capacity = {
    vramTotalMiB,
    vramSource,
    installedCount: installedModels.length,
    measuredCount: measured.length,
    estimatedCount: estimated.length,
    fitClean: measured.filter(m => m.fit.level === 'good' || m.fit.level === 'comfortable').length,
    tight: measured.filter(m => m.fit.level === 'tight').length,
    spills: measured.filter(m => m.fit.level === 'spills').length,
    largestRunnableParamsB: est.largestRunnableParamsB(vramTotalMiB)
  };

  return {
    host: {
      hostId: host.hostId,
      displayName: host.displayName || host.hostId,
      hostUrl: host.hostUrl,
      status: host.status,
      gpuName: telemetry?.gpuName || host.gpu?.model || null,
      driver: telemetry?.driver || host.gpu?.driver || null,
      pcieGen: telemetry?.pcieGen ?? null,
      pcieWidth: telemetry?.pcieWidth ?? null,
      utilization: telemetry?.utilization ?? null,
      cpuCores: host.cpu?.cores || null,
      ollamaBackend: host.ollama?.backend || null,
      ollamaVersion: host.ollama?.version || null,
      telemetrySource: telemetry?.source || null,
      dedicatedModel: host.dedicated?.model || null,
      baseline: host.baseline?.tokensPerSec != null ? {
        referenceModel: host.baseline.referenceModel || null,
        tokensPerSec: est.round(host.baseline.tokensPerSec, 1),
        ttftMs: est.round(host.baseline.ttftMs),
        testedAt: host.baseline.testedAt || null
      } : null
    },
    vram: { totalMiB: vramTotalMiB, source: vramSource },
    throughputModel: {
      source: tm.source,
      nPoints: tm.nPoints,
      confidence: tm.confidence,
      cv: tm.cv,
      calibrationErrorPct,
      moeSource: tm.moeSource || null,
      moeNPoints: tm.moeNPoints || 0
    },
    useCaseWeights: est.USE_CASE_WEIGHTS,
    recommended: est.pickRecommended(measured),
    recommendedBenchmarked: est.pickBestBenchmarked(measured),
    measured,
    estimated,
    capacity,
    generatedAt: new Date()
  };
}

module.exports = { buildHostFitReport };
