'use strict';

const crypto = require('crypto');
const {
  createProfilerAuthorityReceipt,
  verifyProfilerAuthorityReceipt
} = require('./profilerAuthorityReceipt');
const hostTestService = require('../hostTestService');
const contextProbeService = require('../contextProbeService');
const modelProfileService = require('./modelProfileService');
const modelPerformanceProfileService = require('./modelPerformanceProfileService');
const { identitiesMatch, resolveArtifactIdentity } = require('./artifactIdentityService');
const hostProfileService = require('./hostProfileService');
const settingsService = require('./settingsService');
const liveProbeService = require('./liveProbeService');
const { runPrefillDecodeMatrix } = require('./prefillDecodeMatrix');
const { profileThinkingBehavior } = require('./thinkingProfileService');
const { resolveModelNumCtxDetails } = require('../modelContextResolver');
const { listRunning, generate, showModel } = require('../../clients/ollamaClient');
const { isSameOllamaModel } = require('../../helpers/ollamaModelIdentity');
const ModelProfile = require('../../../models/ModelProfile');
const ModelPerformanceProfile = require('../../../models/ModelPerformanceProfile');
const logger = require('../../../config/logger');
const buddySurface = require('../benchmark/buddySurfaceEvents');

function _formatCtx(n) {
  if (n >= 1024) return `${Math.round(n / 1024)}k`;
  return String(n);
}

function buildContextInsight(previousNumCtx, previousSource, discoveredNumCtx) {
  if (!previousNumCtx || !discoveredNumCtx) return null;
  const factor = Number((discoveredNumCtx / previousNumCtx).toFixed(1));
  const upgradeAvailable = discoveredNumCtx > previousNumCtx * 1.25; // >25% gain counts
  const downgrade = discoveredNumCtx < previousNumCtx * 0.75;

  let recommendation;
  if (upgradeAvailable) {
    recommendation = `Verified capacity reached ${_formatCtx(discoveredNumCtx)} context (runtime was ${_formatCtx(previousNumCtx)})`;
  } else if (downgrade) {
    recommendation = `Runtime ${_formatCtx(previousNumCtx)} exceeds the current verified maximum ${_formatCtx(discoveredNumCtx)} — reconfigure by workload`;
  } else {
    recommendation = `Runtime is near the measured maximum (${_formatCtx(previousNumCtx)} → ${_formatCtx(discoveredNumCtx)})`;
  }

  return { previousNumCtx, previousSource, discoveredNumCtx, upgradeAvailable, upgradeFactor: factor, recommendation };
}

function _round(n, places = 2) {
  return Number(Number(n || 0).toFixed(places));
}

function _compactHardwareSnapshot(status, phase) {
  const telemetry = status?.telemetry;
  if (!telemetry) return null;
  return {
    phase,
    capturedAt: new Date(),
    ok: !!telemetry.ok,
    source: telemetry.source || 'none',
    capability: telemetry.capability || {
      contract: 'agentx.profiler-hardware-capability/v1',
      status: 'unavailable',
      qualificationAuthority: 'none',
      collector: {
        requiredContract: 'agentx.profiler-hardware-collector/v1',
        status: 'not_configured',
        ownershipBoundary: 'deployment_extension'
      }
    },
    gpuName: telemetry.gpuName || '',
    gpuCount: telemetry.gpuCount || (telemetry.gpus?.length || null),
    utilization: telemetry.utilization ?? null,
    temperature: telemetry.temperature ?? null,
    powerDrawW: telemetry.powerDrawW ?? null,
    pcieGen: telemetry.pcieGen ?? null,
    pcieGenMax: telemetry.pcieGenMax ?? null,
    pcieWidth: telemetry.pcieWidth ?? null,
    pcieWidthMax: telemetry.pcieWidthMax ?? null,
    vramUsedMiB: telemetry.vramUsedMiB ?? null,
    vramTotalMiB: telemetry.vramTotalMiB ?? null,
    topology: typeof telemetry.topology === 'string' ? telemetry.topology.slice(0, 4000) : null,
    gpus: (telemetry.gpus || []).map(gpu => ({
      index: gpu.index ?? null,
      name: gpu.name || '',
      busId: gpu.busId || '',
      utilizationPct: gpu.utilizationPct ?? null,
      memoryUsedMiB: gpu.memoryUsedMiB ?? null,
      memoryTotalMiB: gpu.memoryTotalMiB ?? null,
      powerDrawW: gpu.powerDrawW ?? null,
      powerLimitW: gpu.powerLimitW ?? null,
      temperatureC: gpu.temperatureC ?? null,
      pcieGen: gpu.pcieGen ?? null,
      pcieGenMax: gpu.pcieGenMax ?? null,
      pcieWidth: gpu.pcieWidth ?? null,
      pcieWidthMax: gpu.pcieWidthMax ?? null,
      source: gpu.source || telemetry.source || 'unknown'
    })),
    runningModels: (telemetry.runningModels || []).map(model => ({
      name: model.name,
      sizeVramMiB: model.sizeVramMiB ?? null,
      sizeTotalMiB: model.sizeTotalMiB ?? null
    })),
    diagnostics: telemetry.diagnostics || null,
    error: telemetry.error || null
  };
}

async function _captureHardwareSnapshot(hostId, phase, settings) {
  if (settings.collectHardwareTelemetry === false) return null;
  try {
    const status = await liveProbeService.getLiveProbeStatus(hostId);
    return _compactHardwareSnapshot(status, phase);
  } catch (err) {
    logger.debug(`Hardware telemetry snapshot failed for ${hostId}/${phase}: ${err.message}`);
    return {
      phase,
      capturedAt: new Date(),
      ok: false,
      source: 'none',
      error: err.message,
      runningModels: [],
      gpus: []
    };
  }
}

function _buildHardwareTelemetry(snapshots) {
  const kept = (snapshots || []).filter(Boolean);
  if (!kept.length) return null;
  const latest = [...kept].reverse().find(s => s.ok) || kept[kept.length - 1];
  return {
    enabled: true,
    source: latest.source || 'none',
    capability: latest.capability || null,
    capturedAt: latest.capturedAt || new Date(),
    latest,
    diagnostics: latest.diagnostics || null,
    snapshots: kept
  };
}

function _median(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function _buildProfilerCapabilities(depth, hardwareTelemetry) {
  const hardwareCapability = hardwareTelemetry?.capability
    || hardwareTelemetry?.latest?.capability
    || {
      contract: 'agentx.profiler-hardware-capability/v1',
      status: 'unavailable',
      qualificationAuthority: 'none',
      collector: {
        requiredContract: 'agentx.profiler-hardware-collector/v1',
        status: 'not_configured',
        ownershipBoundary: 'deployment_extension'
      }
    };
  return {
    contract: 'agentx.profiler-capability-coverage/v1',
    profileDepth: depth,
    qualificationScope: 'single_request_exact_artifact_runtime',
    singleRequestPerformance: { status: 'measured', authority: 'profiler_pipeline' },
    contextCapacity: { status: depth === 'quick' ? 'unknown' : 'measured', authority: depth === 'quick' ? 'none' : 'profiler_pipeline' },
    hardwareTelemetry: hardwareCapability,
    concurrentServing: {
      status: 'unknown',
      authority: 'none',
      reason: 'concurrency_not_measured_by_current_profiler',
      metrics: {
        goodput: null,
        latencyP95Ms: null,
        fairness: null,
        saturationConcurrency: null
      }
    },
    responseQuality: {
      status: 'not_measured',
      authority: 'none',
      reason: 'profiler_measures_runtime_performance_not_semantic_quality'
    },
    productionServingQualification: {
      qualified: false,
      reason: 'concurrency_goodput_fairness_and_long_context_quality_not_measured'
    }
  };
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

function summarizeThroughputSamples(samples, { minimumRetainedSamples = 2 } = {}) {
  // Exclude warm-up / discarded samples from steady-state stats. They stay
  // on the record (sample.discarded=true) so the UI can show them, but they
  // never contribute to mean/median/CV/reliability.
  const kept = samples.filter(s => !s.discarded);
  const passing = kept.filter(s => s.status === 'pass' && Number.isFinite(Number(s.tokensPerSec)) && Number(s.tokensPerSec) > 0);
  const values = passing.map(s => Number(s.tokensPerSec));
  if (!values.length) {
    return {
      sampleCount: kept.length,
      retainedSampleCount: kept.length,
      passingSampleCount: 0,
      minimumRetainedSamples,
      tokensPerSecMean: null,
      tokensPerSecMedian: null,
      tokensPerSecMin: null,
      tokensPerSecMax: null,
      tokensPerSecStdDev: null,
      coefficientOfVariation: null,
      p50: null,
      p95: null,
      ttftP50Ms: null,
      ttftP95Ms: null,
      ttftSampleCount: 0,
      promptEvalP50Ms: null,
      promptEvalP95Ms: null,
      confidenceInterval95: null,
      reliability: 'unknown'
    };
  }
  const mean = values.reduce((sum, n) => sum + n, 0) / values.length;
  // Single sample → CV is mathematically 0 but tells us nothing about
  // variance. Surface that as 'unknown' rather than misleading 'high'.
  if (values.length < 2) {
    return {
      sampleCount: kept.length,
      retainedSampleCount: kept.length,
      passingSampleCount: values.length,
      minimumRetainedSamples,
      tokensPerSecMean: _round(mean),
      tokensPerSecMedian: _round(mean),
      tokensPerSecMin: _round(mean),
      tokensPerSecMax: _round(mean),
      tokensPerSecStdDev: null,
      coefficientOfVariation: null,
      p50: _round(mean),
      p95: _round(mean),
      ttftP50Ms: Number.isFinite(Number(passing[0]?.ttftMs)) ? _round(passing[0].ttftMs) : null,
      ttftP95Ms: Number.isFinite(Number(passing[0]?.ttftMs)) ? _round(passing[0].ttftMs) : null,
      ttftSampleCount: passing[0]?.ttftMeasurement === 'streamed_wall_clock'
        && Number.isFinite(Number(passing[0]?.ttftMs)) ? 1 : 0,
      promptEvalP50Ms: Number.isFinite(Number(passing[0]?.promptEvalDurationMs)) ? _round(passing[0].promptEvalDurationMs) : null,
      promptEvalP95Ms: Number.isFinite(Number(passing[0]?.promptEvalDurationMs)) ? _round(passing[0].promptEvalDurationMs) : null,
      confidenceInterval95: null,
      reliability: 'unknown'
    };
  }
  const variance = values.reduce((sum, n) => sum + ((n - mean) ** 2), 0) / (values.length - 1);
  const stdDev = Math.sqrt(variance);
  const cv = mean > 0 ? stdDev / mean : null;
  const margin95 = _studentTCritical95(values.length) * stdDev / Math.sqrt(values.length);
  const streamedTtft = passing
    .filter(sample => sample.ttftMeasurement === 'streamed_wall_clock' && Number.isFinite(Number(sample.ttftMs)))
    .map(sample => Number(sample.ttftMs));
  const promptEvalDurations = passing
    .filter(sample => Number.isFinite(Number(sample.promptEvalDurationMs)))
    .map(sample => Number(sample.promptEvalDurationMs));
  const reliability = values.length < minimumRetainedSamples || cv == null
    ? 'unknown'
    : cv <= 0.05 ? 'high' : cv <= 0.12 ? 'medium' : 'low';
  return {
    sampleCount: kept.length,
    retainedSampleCount: kept.length,
    passingSampleCount: values.length,
    minimumRetainedSamples,
    tokensPerSecMean: _round(mean),
    tokensPerSecMedian: _round(_median(values)),
    tokensPerSecMin: _round(Math.min(...values)),
    tokensPerSecMax: _round(Math.max(...values)),
    tokensPerSecStdDev: _round(stdDev),
    coefficientOfVariation: cv == null ? null : _round(cv, 4),
    p50: _round(_quantile(values, 0.5)),
    p95: _round(_quantile(values, 0.95)),
    ttftP50Ms: streamedTtft.length ? _round(_quantile(streamedTtft, 0.5)) : null,
    ttftP95Ms: streamedTtft.length ? _round(_quantile(streamedTtft, 0.95)) : null,
    ttftSampleCount: streamedTtft.length,
    promptEvalP50Ms: promptEvalDurations.length ? _round(_quantile(promptEvalDurations, 0.5)) : null,
    promptEvalP95Ms: promptEvalDurations.length ? _round(_quantile(promptEvalDurations, 0.95)) : null,
    confidenceInterval95: {
      low: _round(Math.max(0, mean - margin95)),
      high: _round(mean + margin95),
      method: 'student_t'
    },
    reliability
  };
}

function _sampleFromResult(result, sample, opts = {}) {
  return {
    sample,
    tokensPerSec: result.tokensPerSec ?? null,
    promptEvalTokensPerSec: result.promptEvalTokensPerSec ?? null,
    promptEvalDurationMs: result.promptEvalDurationMs ?? null,
    ttftMs: result.timeToFirstTokenMs ?? null,
    ttftMeasurement: result.ttftMeasurement ?? null,
    latencyMs: result.latencyMs ?? null,
    promptTokens: result.promptTokens ?? null,
    completionTokens: result.completionTokens ?? null,
    vramUsedMiB: result.vramUsedMiB ?? null,
    status: result.status,
    error: result.error || null,
    discarded: opts.discarded === true,
    discardReason: opts.discardReason || null
  };
}

function summarizePositiveMeasurements(values, { minimumSamples = 3 } = {}) {
  const samples = values.map(Number).filter(value => Number.isFinite(value) && value > 0);
  if (!samples.length) return {
    sampleCount: 0, minimumSamples, mean: null, p50: null, p95: null,
    standardDeviation: null, coefficientOfVariation: null,
    confidenceInterval95: null, reliability: 'unknown'
  };
  const mean = samples.reduce((sum, value) => sum + value, 0) / samples.length;
  if (samples.length < 2) return {
    sampleCount: samples.length,
    minimumSamples,
    mean: _round(mean), p50: _round(mean), p95: _round(mean),
    standardDeviation: null, coefficientOfVariation: null,
    confidenceInterval95: null, reliability: 'unknown'
  };
  const variance = samples.reduce((sum, value) => sum + ((value - mean) ** 2), 0) / (samples.length - 1);
  const standardDeviation = Math.sqrt(variance);
  const cv = mean > 0 ? standardDeviation / mean : null;
  const margin = _studentTCritical95(samples.length) * standardDeviation / Math.sqrt(samples.length);
  return {
    sampleCount: samples.length,
    minimumSamples,
    mean: _round(mean),
    p50: _round(_quantile(samples, 0.5)),
    p95: _round(_quantile(samples, 0.95)),
    standardDeviation: _round(standardDeviation),
    coefficientOfVariation: cv == null ? null : _round(cv, 4),
    confidenceInterval95: {
      low: _round(Math.max(0, mean - margin)),
      high: _round(mean + margin),
      method: 'student_t'
    },
    reliability: samples.length < minimumSamples || cv == null
      ? 'unknown'
      : cv <= 0.05 ? 'high' : cv <= 0.12 ? 'medium' : 'low'
  };
}

function completeRepeatedStatistics(statistics, minimumSamples, options = {}) {
  const maxCv = Number.isFinite(Number(options.maxCoefficientOfVariation))
    ? Number(options.maxCoefficientOfVariation)
    : 0.12;
  const maxRelativeCiWidth = Number.isFinite(Number(options.maxRelativeCi95Width))
    ? Number(options.maxRelativeCi95Width)
    : 0.30;
  const mean = Number(statistics?.mean);
  const low = Number(statistics?.confidenceInterval95?.low);
  const high = Number(statistics?.confidenceInterval95?.high);
  const relativeCiWidth = mean > 0 && Number.isFinite(low) && Number.isFinite(high)
    ? (high - low) / mean
    : Infinity;
  return Number(statistics?.sampleCount) >= minimumSamples
    && ['medium', 'high'].includes(statistics?.reliability)
    && Number.isFinite(Number(statistics?.coefficientOfVariation))
    && Number(statistics.coefficientOfVariation) <= maxCv
    && Number.isFinite(low)
    && Number.isFinite(high)
    && relativeCiWidth <= maxRelativeCiWidth;
}

function contextProbeRepeatsForDepth(depth, settings = {}) {
  return depth === 'full'
    ? Math.min(20, Math.max(5, Number(settings.fullPhaseRepeats) || 5))
    : 2;
}

function hasProfilerAuthorityReceipt(readiness, evidence, identity = {}) {
  return verifyProfilerAuthorityReceipt(readiness, evidence, identity);
}

function profileQualificationFailures(profileData) {
  const failures = [];
  const required = Number(profileData.requiredRetainedSamples) || 0;
  const quality = profileData.measurementQuality || {};
  if (profileData.profileDepth === 'quick') failures.push('quick_diagnostic_only');
  if (!(Number(profileData.maxVerifiedContext) > 0)) failures.push('max_context_unverified');
  if (!(Number(profileData.recommendedInteractiveContext) > 0)) failures.push('interactive_context_unverified');
  if (!(Number(profileData.recommendedDocumentContext) > 0)) failures.push('document_context_unverified');
  if (Number(profileData.recommendedInteractiveContext) > Number(profileData.maxVerifiedContext)) {
    failures.push('interactive_context_exceeds_verified_max');
  }
  if (Number(profileData.recommendedDocumentContext) > Number(profileData.maxVerifiedContext)) {
    failures.push('document_context_exceeds_verified_max');
  }
  if (Number(quality.passingSampleCount) < required) failures.push('retained_sample_minimum_not_met');
  if (!['medium', 'high'].includes(quality.reliability)) failures.push(`reliability_${quality.reliability || 'unknown'}`);
  const mainMean = Number(quality.tokensPerSecMean);
  const mainLow = Number(quality.confidenceInterval95?.low);
  const mainHigh = Number(quality.confidenceInterval95?.high);
  const maxCv = Number(profileData.fullMaxCoefficientOfVariation ?? 0.12);
  const maxRelativeCi95Width = Number(profileData.fullMaxRelativeCi95Width ?? 0.30);
  if (profileData.profileDepth === 'full'
    && (!(Number(quality.coefficientOfVariation) <= maxCv)
      || !(mainMean > 0)
      || !Number.isFinite(mainLow)
      || !Number.isFinite(mainHigh)
      || ((mainHigh - mainLow) / mainMean) > maxRelativeCi95Width)) {
    failures.push('full_primary_measurement_uncertain');
  }
  if (profileData.ttftMeasurement !== 'streamed_wall_clock'
    || !Number.isFinite(Number(profileData.ttftMs))
    || Number(profileData.ttftMs) < 0) failures.push('streamed_ttft_missing');
  const requiredTtftSamples = Number(profileData.requiredTtftSamples) || required;
  if (requiredTtftSamples > 0 && Number(quality.ttftSampleCount) < requiredTtftSamples) {
    failures.push('streamed_ttft_sample_minimum_not_met');
  }
  if (profileData.spill?.verified !== true) failures.push('gpu_residency_unverified');

  if (profileData.profileDepth === 'full') {
    const requiredFullSamples = Math.max(5, Number(profileData.requiredFullPhaseSamples) || 5);
    const fullStatOptions = {
      maxCoefficientOfVariation: maxCv,
      maxRelativeCi95Width
    };
    const authoritativeContexts = [...new Set([
      profileData.maxVerifiedContext,
      profileData.recommendedInteractiveContext,
      profileData.recommendedDocumentContext
    ].map(Number).filter(value => value > 0))];
    const contextSteps = Array.isArray(profileData.probeSteps) ? profileData.probeSteps : [];
    const contextEvidenceComplete = Number(profileData.contextProbeCandidateRepeats) >= requiredFullSamples
      && authoritativeContexts.length > 0
      && authoritativeContexts.every(numCtx => {
        const step = contextSteps.find(candidate => Number(candidate.numCtx) === numCtx && candidate.passed === true);
        return step
          && Number(step.repetitionCount) >= requiredFullSamples
          && completeRepeatedStatistics(step.throughputStatistics, requiredFullSamples, fullStatOptions);
      });
    if (!contextEvidenceComplete) failures.push('full_context_probe_incomplete');
    const curve = Array.isArray(profileData.throughputCurve) ? profileData.throughputCurve : [];
    const curveCoverage = [...new Set(curve.map(point => Number(point.contextFillPct)))].sort((a, b) => a - b);
    if (curve.length !== 5
      || JSON.stringify(curveCoverage) !== JSON.stringify([10, 25, 50, 75, 90])
      || curve.some(point => !(Number(point.tokensPerSec) > 0)
        || point.gpuOffloaded !== false
        || Number(point.passingSampleCount) < requiredFullSamples
        || !completeRepeatedStatistics(point.throughputStatistics, requiredFullSamples, fullStatOptions))) {
      failures.push('full_throughput_curve_incomplete');
    }
    const stability = Array.isArray(profileData.generationStability) ? profileData.generationStability : [];
    const stabilityCoverage = [...new Set(stability.map(point => Number(point.numPredict)))].sort((a, b) => a - b);
    if (stability.length !== 3
      || JSON.stringify(stabilityCoverage) !== JSON.stringify([64, 256, 512])
      || stability.some(point => !(Number(point.tokensPerSec) > 0)
        || !(Number(point.totalLatencyMs) > 0)
        || Number(point.passingSampleCount) < requiredFullSamples
        || !completeRepeatedStatistics(point.throughputStatistics, requiredFullSamples, fullStatOptions)
        || !completeRepeatedStatistics(point.latencyStatistics, requiredFullSamples, fullStatOptions))) {
      failures.push('full_generation_stability_incomplete');
    }
    const matrix = profileData.prefillDecodeMatrix;
    const cells = Array.isArray(matrix?.cells) ? matrix.cells : [];
    const expectedCellCount = Array.isArray(matrix?.prefillTokens) && Array.isArray(matrix?.decodeTokens)
      ? matrix.prefillTokens.length * matrix.decodeTokens.length
      : 0;
    const completeMatrix = expectedCellCount > 0
      && cells.length === expectedCellCount
      && Number(matrix.cellCount) === expectedCellCount
      && Number(matrix.passCount) === expectedCellCount
      && Number(matrix.skippedCount || 0) === 0
      && cells.every(cell => cell.status === 'pass'
        && Number(cell.promptTokens) > 0
        && Number(cell.requestedPromptTokens) > 0
        && Number(cell.promptCoveragePct) >= Number(cell.minimumPromptCoveragePct || 80)
        && Number(cell.promptEvalDurationMs) > 0
        && Number(cell.evalDurationMs) > 0
        && Number(cell.runtimeContextLength) === Number(matrix.numCtx)
        && Number(cell.passingSampleCount) >= requiredFullSamples
        && completeRepeatedStatistics(cell.prefillStatistics, requiredFullSamples, fullStatOptions)
        && completeRepeatedStatistics(cell.decodeStatistics, requiredFullSamples, fullStatOptions)
        && Number.isFinite(Number(cell.prefillTokensPerSec))
        && Number(cell.prefillTokensPerSec) > 0
        && Number.isFinite(Number(cell.decodeTokensPerSec))
        && Number(cell.decodeTokensPerSec) > 0);
    if (!completeMatrix) {
      failures.push('full_prefill_decode_matrix_incomplete');
    }
    if (!(Number(profileData.loadTiming?.coldLoadMs) > 0)
      || !(Number(profileData.loadTiming?.hotLoadMs) > 0)
      || profileData.loadTiming?.unloadVerified !== true
      || Number(profileData.loadTiming?.passingSampleCount) < requiredFullSamples
      || !completeRepeatedStatistics(profileData.loadTiming?.coldStatistics, requiredFullSamples, fullStatOptions)
      || !completeRepeatedStatistics(profileData.loadTiming?.hotStatistics, requiredFullSamples, fullStatOptions)) {
      failures.push('full_load_timing_incomplete');
    }
  }
  return failures;
}

async function scout(modelName, hosts, { assertClaimActive, claimIdentityFor, signal } = {}) {
  const results = [];
  for (const host of hosts) {
    try {
      assertClaimActive?.();
      const testResult = await hostTestService.testModelOnHost(modelName, host.hostUrl, {
        benchmarkClaim: claimIdentityFor?.(host.hostUrl) || null,
        assertClaimActive,
        signal
      });
      assertClaimActive?.();
      results.push({
        hostId: host.hostId,
        fit: testResult.status === 'pass',
        tokensPerSec: testResult.tokensPerSec || null,
        error: testResult.error || null
      });
    } catch (err) {
      if (err.code === 'BENCHMARK_CLAIM_LOST' || err.code === 'BENCHMARK_CLAIM_STOPPED') throw err;
      results.push({ hostId: host.hostId, fit: false, error: err.message });
    }
  }
  return results;
}

async function persistProfileEvidence({
  modelName,
  hostId,
  hostUrl,
  artifact,
  profileData,
  assertClaimActive,
  signal
}) {
  const checkpoint = () => {
    if (signal?.aborted) {
      const error = signal.reason instanceof Error ? signal.reason : new Error('Profiler authority write aborted');
      error.code = error.code || 'BENCHMARK_CLAIM_STOPPED';
      throw error;
    }
    assertClaimActive?.();
  };
  let evidence = null;
  try {
    checkpoint();
    const currentArtifact = await resolveArtifactIdentity(modelName, hostId, hostUrl, { refresh: true });
    checkpoint();
    if (!identitiesMatch(artifact, currentArtifact)) {
      throw new Error(`Artifact or runtime changed while profiling ${modelName} on ${hostUrl}; discard this run and retry`);
    }
    const required = Number(profileData.requiredRetainedSamples) || 0;
    const quality = profileData.measurementQuality || {};
    const qualificationFailures = profileQualificationFailures(profileData);
    const benchmarkQualified = qualificationFailures.length === 0;
    profileData.benchmarkQualified = benchmarkQualified;
    profileData.qualificationFailures = qualificationFailures;
    evidence = await modelPerformanceProfileService.saveProfile({
      modelName,
      hostId,
      artifact: currentArtifact,
      profile: { ...profileData, artifact: currentArtifact }
    }, {
      signal,
      assertAuthorityActive: checkpoint
    });
    checkpoint();
    const authorityReceipt = createProfilerAuthorityReceipt({
      modelName,
      hostId,
      artifact: currentArtifact,
      profile: { ...profileData, artifact: currentArtifact },
      evidenceId: evidence?._id
    });
    checkpoint();
    await modelProfileService.updateReadiness(modelName, hostId, 'profiled', {
      [`readiness.${hostId}.artifact`]: currentArtifact,
      [`readiness.${hostId}.evidenceId`]: evidence?._id || null,
      [`readiness.${hostId}.profileDepth`]: profileData.profileDepth,
      [`readiness.${hostId}.benchmarkQualified`]: benchmarkQualified,
      [`readiness.${hostId}.qualificationReason`]: benchmarkQualified ? null : qualificationFailures.join(','),
      [`readiness.${hostId}.measurementReliability`]: quality.reliability || 'unknown',
      [`readiness.${hostId}.authorityReceipt`]: authorityReceipt,
      [`readiness.${hostId}.stale`]: false,
      [`readiness.${hostId}.staleReason`]: null
    }, { signal });
    checkpoint();
    if (profileData.thinking) {
      await modelProfileService.updateThinkingCapability(modelName, hostId, profileData.thinking, { signal });
      checkpoint();
    }
    await modelPerformanceProfileService.retireSupersededProfiles({
      modelName,
      hostId,
      evidenceId: evidence?._id,
      assertAuthorityActive: checkpoint,
      signal
    });
    checkpoint();
    return evidence;
  } catch (error) {
    if (evidence?._id) {
      const reason = error.code === 'BENCHMARK_CLAIM_LOST' || error.code === 'BENCHMARK_CLAIM_STOPPED'
        ? 'claim_lost_during_profiler_authority_write'
        : 'profiler_authority_write_failed';
      const invalidations = await Promise.allSettled([
        modelPerformanceProfileService.invalidateProfile(evidence._id, reason),
        modelProfileService.invalidateReadinessIfEvidence(modelName, hostId, evidence._id, reason),
        ...(profileData.thinking
          ? [modelProfileService.invalidateThinkingCapability(modelName, hostId, reason)]
          : [])
      ]);
      const invalidationFailures = invalidations
        .filter(result => result.status === 'rejected')
        .map(result => result.reason);
      if (invalidationFailures.length > 0) {
        error.authorityInvalidationFailed = true;
        error.invalidationErrors = invalidationFailures;
        error.code = error.code || 'PROFILER_AUTHORITY_INVALIDATION_FAILED';
      }
    }
    throw error;
  }
}

async function profile(modelName, hostId, hostUrl, depth = 'standard', {
  onProgress,
  assertClaimActive,
  claimIdentity,
  signal
} = {}) {
  const notify = typeof onProgress === 'function' ? onProgress : () => {};
  const checkpoint = typeof assertClaimActive === 'function' ? assertClaimActive : () => {};
  logger.info(`Profiling ${modelName} on ${hostId} (${depth})`);
  checkpoint();
  let residentCtx = null;
  try {
    const running = await listRunning(hostUrl, { timeoutMs: 8000, signal });
    const resident = (running.models || []).find(model =>
      isSameOllamaModel(model.name, modelName) || isSameOllamaModel(model.model, modelName)
    );
    const value = Number(resident?.context_length);
    if (Number.isFinite(value) && value > 0) {
      residentCtx = { num_ctx: Math.floor(value), source: 'ollama_ps_resident' };
    }
  } catch (err) {
    if (signal?.aborted) throw (signal.reason instanceof Error ? signal.reason : err);
    logger.debug(`Could not snapshot resident context for ${modelName}: ${err.message}`);
  }
  const artifact = await resolveArtifactIdentity(modelName, hostId, hostUrl, { refresh: true });
  const settings = await settingsService.getAll();
  const hardwareSnapshots = [];
  const initialHardware = await _captureHardwareSnapshot(hostId, 'before_profile', settings);
  if (initialHardware) hardwareSnapshots.push(initialHardware);

  // Preserve the context of an already-loaded model. Falling back to model
  // metadata is appropriate only when there is no resident runtime to retain.
  let previousCtx = residentCtx;
  if (!previousCtx) {
    try {
      const showData = await showModel(hostUrl, modelName, { signal });
      const paramLines = (showData.parameters || '').split('\n');
      const ctxLine = paramLines.find(l => /^\s*num_ctx\b/i.test(l));
      if (ctxLine) {
        const val = parseInt(ctxLine.replace(/^\s*num_ctx\s+/i, ''), 10);
        if (Number.isFinite(val) && val > 0) {
          previousCtx = { num_ctx: val, source: 'modelfile' };
        }
      }
      // Fall back to model_info context_length (native architecture max)
      if (!previousCtx) {
        const mi = showData.model_info || {};
        const ctxKey = Object.keys(mi).find(k => k.endsWith('.context_length'));
        if (ctxKey && Number.isFinite(mi[ctxKey]) && mi[ctxKey] > 0) {
          previousCtx = { num_ctx: mi[ctxKey], source: 'model_architecture' };
        }
      }
    } catch (err) {
      if (signal?.aborted) throw (signal.reason instanceof Error ? signal.reason : err);
      logger.debug(`Could not read Modelfile context for ${modelName}: ${err.message}`);
    }
  }
  // Last resort: resolution chain
  if (!previousCtx) {
    try {
      previousCtx = await resolveModelNumCtxDetails(modelName, { targetHost: hostUrl });
    } catch (err) {
      if (signal?.aborted) throw (signal.reason instanceof Error ? signal.reason : err);
      logger.debug(`Could not resolve pre-profile context for ${modelName}: ${err.message}`);
    }
  }

  // --- warmup + single throughput test ---
  // skipPriorProfileArtifacts: the materialized context profile and latest probe
  // snapshot are exactly what this re-profile is about to replace. Letting
  // them dictate warm-up ctx makes re-profiling impossible whenever the
  // previous run picked an ambitious ctx the host can no longer warm up
  // within the timeout (e.g. 131072 on a 24GB host).
  notify('warmup', { message: 'Warming up model — sending test prompt…' });
  const baseTestOptions = {
    maxPromptTokens: settings.maxPromptTokens,
    numPredict: settings.numPredict,
    promptWorkloadMode: 'fixed',
    timeoutMs: settings.testTimeoutSec * 1000,
    skipPriorProfileArtifacts: true,
    benchmarkClaim: claimIdentity || null,
    assertClaimActive: checkpoint,
    signal,
    ...(residentCtx ? { numCtx: residentCtx.num_ctx } : {})
  };
  checkpoint();
  const testResult = await hostTestService.testModelOnHost(modelName, hostUrl, baseTestOptions);
  if (testResult.status !== 'pass') {
    throw new Error(`Throughput test failed: ${testResult.error || testResult.status}`);
  }

  const minimumRetainedSamples = depth === 'full'
    ? Math.max(10, Number(settings.fullRetainedSamples) || 10)
    : depth === 'standard'
      ? Math.max(5, Number(settings.standardRetainedSamples) || 5)
      : 1;
  const requestedSamples = depth === 'quick'
    ? 1
    : Math.min(26, Math.max(minimumRetainedSamples + 1, Number(settings.throughputSamples) || 0));
  // When 3+ samples are requested, drop sample 1 from CV stats: even after
  // the explicit 2-pass warm-up, the first measured run can carry KV-cache
  // settle overhead that inflates variance. With 1 or 2 samples we have no
  // budget to discard, so we keep them all.
  const discardFirst = requestedSamples >= 3;
  const throughputSamples = [_sampleFromResult(testResult, 1, discardFirst
    ? { discarded: true, discardReason: 'warmup_settle' }
    : {})];
  for (let i = 2; i <= requestedSamples; i++) {
    checkpoint();
    notify('throughput', { message: `Throughput sample ${i}/${requestedSamples} — repeat run for reliability…`, sample: i, sampleCount: requestedSamples });
    const repeat = await hostTestService.testModelOnHost(modelName, hostUrl, {
      ...baseTestOptions,
      warmup: false
    });
    throughputSamples.push(_sampleFromResult(repeat, i));
    if (repeat.status !== 'pass') {
      logger.warn(`Throughput repeat sample failed for ${modelName} on ${hostId}`, { sample: i, error: repeat.error || repeat.status });
    }
  }
  const measurementQuality = summarizeThroughputSamples(throughputSamples, { minimumRetainedSamples });
  const throughputHardware = await _captureHardwareSnapshot(hostId, 'after_throughput', settings);
  if (throughputHardware) {
    hardwareSnapshots.push(throughputHardware);
    const hardwareTelemetry = _buildHardwareTelemetry(hardwareSnapshots);
    if (hardwareTelemetry?.latest?.ok) {
      const hw = hardwareTelemetry.latest;
      const util = hw.utilization != null ? `GPU ${Math.round(hw.utilization)}%` : null;
      const vram = hw.vramUsedMiB != null && hw.vramTotalMiB
        ? `VRAM ${(hw.vramUsedMiB / 1024).toFixed(1)}/${(hw.vramTotalMiB / 1024).toFixed(0)}GB`
        : null;
      const parts = [util, vram, hw.pcieGen && hw.pcieWidth ? `PCIe Gen${hw.pcieGen} x${hw.pcieWidth}` : null].filter(Boolean);
      if (parts.length) {
        notify('throughput', {
          message: `Hardware: ${parts.join(' · ')}`,
          hardwareTelemetry
        });
      }
    }
  }

  const representativeTokensPerSec = measurementQuality.tokensPerSecMedian;
  if (!representativeTokensPerSec) throw new Error('No retained passing throughput sample');
  const representativeSample = throughputSamples
    .filter(sample => !sample.discarded && sample.status === 'pass' && Number(sample.tokensPerSec) > 0)
    .sort((left, right) => Math.abs(Number(left.tokensPerSec) - representativeTokensPerSec)
      - Math.abs(Number(right.tokensPerSec) - representativeTokensPerSec))[0];
  const tpsStr = Number(representativeTokensPerSec).toFixed(1);
  const ttftStr = measurementQuality.ttftP50Ms != null
    ? ` · TTFT p50 ${Math.round(measurementQuality.ttftP50Ms)}ms`
    : '';
  const pevalStr = testResult.promptEvalTokensPerSec ? ` · prompt eval ${Number(testResult.promptEvalTokensPerSec).toFixed(0)} tok/s` : '';
  notify('throughput', {
    message: `Throughput: ${tpsStr} tok/s${ttftStr}${pevalStr} · reliability ${measurementQuality.reliability}`,
    tokensPerSec: representativeTokensPerSec,
    measurementQuality,
    sampleCount: throughputSamples.length
  });

  notify('spill_detection', { message: 'Checking GPU memory offload…' });
  checkpoint();
  const spill = await _detectSpill(hostUrl, modelName, signal);
  checkpoint();
  const spillMsg = spill.verified === false
    ? 'GPU residency unknown — no-spill is not verified'
    : spill.spillDetected
    ? `Spill detected — ${spill.sizeVram && spill.sizeTotal ? Math.round(spill.sizeVram / spill.sizeTotal * 100) : '?'}% on GPU`
    : 'No spill — model fully loaded on GPU';
  notify('spill_detection', { message: spillMsg });
  const spillHardware = await _captureHardwareSnapshot(hostId, 'after_spill_detection', settings);
  if (spillHardware) hardwareSnapshots.push(spillHardware);

  let thinkingProfile = null;
  if (settings.thinkingProbeEnabled !== false) {
    checkpoint();
    notify('thinking_behavior', { message: 'Checking think=true behavior and visible-answer safety…' });
    try {
      thinkingProfile = await profileThinkingBehavior(modelName, hostUrl, {
        numCtx: testResult.numCtx || null,
        maxNumCtx: testResult.numCtx || undefined,
        numPredict: 512,
        timeoutMs: Math.max(60000, (Number(settings.testTimeoutSec) || 60) * 1000),
        signal,
        assertClaimActive: checkpoint
      });
      checkpoint();
      notify('thinking_behavior', {
        message: `Thinking behavior: ${thinkingProfile.recommendedPolicy} (${thinkingProfile.channel}, ${thinkingProfile.supportSignal})`,
        thinking: thinkingProfile
      });
    } catch (err) {
      if (signal?.aborted || err.code === 'BENCHMARK_CLAIM_LOST' || err.code === 'BENCHMARK_CLAIM_STOPPED') throw err;
      logger.warn(`Thinking behavior probe failed for ${modelName} on ${hostId}`, { error: err.message });
      thinkingProfile = {
        profiledAt: new Date(),
        apiMode: 'chat',
        supported: false,
        supportSignal: 'error',
        channel: 'error',
        visibleFinalAnswerOk: false,
        finalAnswerContractOk: false,
        thinkingOnlyResponse: false,
        runawayRisk: false,
        recommendedPolicy: 'unknown',
        recommendationReason: `thinking probe failed: ${err.message}`
      };
      notify('thinking_behavior', { message: `Thinking behavior probe failed: ${err.message}`, thinking: thinkingProfile });
    }
  }

  const initialHardwareTelemetry = _buildHardwareTelemetry(hardwareSnapshots);
  const profileData = {
    tokensPerSec: representativeTokensPerSec,
    promptEvalTokensPerSec: representativeSample?.promptEvalTokensPerSec || null,
    promptEvalDurationMs: representativeSample?.promptEvalDurationMs || null,
    ttftMs: measurementQuality.ttftP50Ms ?? null,
    ttftP50Ms: measurementQuality.ttftP50Ms ?? null,
    ttftP95Ms: measurementQuality.ttftP95Ms ?? null,
    ttftMeasurement: measurementQuality.ttftP50Ms != null ? 'streamed_wall_clock' : null,
    comparisonPromptTokens: representativeSample?.promptTokens || null,
    comparisonPromptTargetTokens: testResult.requestedPromptTokens || null,
    contextProbeFillPct: Number(settings.contextProbeFillPct) || 80,
    comparisonWorkloadMode: testResult.promptWorkloadMode || 'fixed',
    optimalNumCtx: testResult.numCtx || null,
    performanceKneeContext: null,
    performanceKneeDegradationPct: Number(settings.performanceKneeDegradationThreshold) || 15,
    qualityVerifiedContext: null,
    qualityContextStatus: 'unknown',
    vramUsedMiB: testResult.vramUsedMiB || null,
    throughputSamples,
    measurementQuality,
    requiredRetainedSamples: minimumRetainedSamples,
    requiredTtftSamples: minimumRetainedSamples,
    requiredFullPhaseSamples: depth === 'full'
      ? Math.max(5, Number(settings.fullPhaseRepeats) || 5)
      : null,
    fullMaxCoefficientOfVariation: Number(settings.fullMaxCoefficientOfVariation) || 0.12,
    fullMaxRelativeCi95Width: Number(settings.fullMaxRelativeCi95Width) || 0.30,
    spill: {
      ...spill,
      // /api/ps reports offload, not the context that caused it. Attribute a
      // spill only to the throughput call's reported numCtx; if that evidence
      // is absent, keep it null rather than inventing a fallback. A spill also
      // proves no safe context; a later context probe may provide one.
      spillNumCtx: spill.spillDetected === true ? (testResult.numCtx || null) : null,
      lastSafeNumCtx: spill.verified === true && spill.spillDetected === false
        ? (testResult.numCtx || null)
        : null
    },
    profiledAt: new Date(),
    profileDepth: depth,
    thinking: thinkingProfile,
    hardwareTelemetry: initialHardwareTelemetry,
    profilerCapabilities: _buildProfilerCapabilities(depth, initialHardwareTelemetry)
  };

  // --- quick: done here ---
  if (depth === 'quick') {
    notify('saving', { message: 'Saving profile to database…' });
    checkpoint();
    const evidence = await persistProfileEvidence({
      modelName, hostId, hostUrl, artifact, profileData, assertClaimActive: checkpoint, signal
    });
    return { modelName, hostId, artifact, evidenceId: evidence?._id || null, profile: profileData };
  }

  // --- standard: add context probe ---
  notify('context_probe', { message: 'Probing context window — resolving model limits…' });
  const probeResult = await contextProbeService.probeModelContext(modelName, {
    hostUrl,
    artifactIdentity: artifact,
    acknowledgeMaintenance: true,
    contextProbeFillPct: Number(settings.contextProbeFillPct) || 80,
    interactiveDegradationThreshold: Number(settings.interactiveDegradationThreshold),
    documentDegradationThreshold: Number(settings.documentDegradationThreshold),
    performanceKneeDegradationThreshold: Number(settings.performanceKneeDegradationThreshold),
    candidateRepeats: contextProbeRepeatsForDepth(depth, settings),
    profileDepth: depth,
    assertClaimActive: checkpoint,
    signal,
    onProgress: (info) => {
      if (info.type === 'resident') {
        const msg = info.tokensPerSec == null
          ? `Validating resident ${_formatCtx(info.numCtx)} context before reload…`
          : `Resident ${_formatCtx(info.numCtx)} context: ${info.tokensPerSec} tok/s ${info.passed ? '✓' : '✗'}`;
        notify('context_probe', { message: msg });
      } else if (info.type === 'baseline') {
        const msg = info.tokensPerSec == null
          ? `Measuring baseline at ${_formatCtx(info.numCtx)} ctx…`
          : `Baseline: ${info.tokensPerSec} tok/s at ${_formatCtx(info.numCtx)} ctx`;
        notify('context_probe', { message: msg });
      } else if (info.type === 'step') {
        const dropStr = info.degradationPct != null ? ` (${info.degradationPct}% drop)` : '';
        const verdict = info.passed ? '✓' : '✗';
        notify('context_probe', { message: `Testing ${_formatCtx(info.numCtx)} ctx — ${info.tokensPerSec} tok/s${dropStr} ${verdict}` });
      } else if (info.type === 'result') {
        notify('context_probe', { message: `Largest verified context: ${_formatCtx(info.testedNumCtx)} (${info.degradationPct}% throughput change)` });
      }
    }
  });
  checkpoint();
  // `optimalNumCtx` is retained as a persisted compatibility field. Its value
  // is the largest verified context, not a synthetic performance tier.
  profileData.optimalNumCtx = probeResult.testedNumCtx || null;
  profileData.maxVerifiedContext = probeResult.testedNumCtx || null;
  profileData.recommendedInteractiveContext = probeResult.recommendedInteractiveContext || null;
  profileData.recommendedDocumentContext = probeResult.recommendedDocumentContext || null;
  profileData.performanceKneeContext = probeResult.performanceKneeContext || null;
  profileData.performanceKneeDegradationPct = Number(probeResult.performanceKneeDegradationThreshold)
    || Number(settings.performanceKneeDegradationThreshold)
    || 15;
  // Profiler measures runtime behavior only. Long-context semantic quality is
  // populated exclusively by a separately qualified Benchmark campaign.
  profileData.qualityVerifiedContext = null;
  profileData.qualityContextStatus = 'unknown';
  profileData.degradationPct = probeResult.degradationPct || null;
  profileData.contextProbeCandidateRepeats = contextProbeRepeatsForDepth(depth, settings);
  profileData.probeSteps = (probeResult.steps || []).map(s => ({
    numCtx: s.numCtx, tokPerSec: s.tokensPerSec, vramMiB: s.vramMiB,
    degradationPct: s.degradationPct, passed: s.passed,
    repetitionCount: s.repetitionCount,
    throughputStatistics: s.throughputStatistics || null,
    samples: Array.isArray(s.samples) ? s.samples : []
  }));
  const contextHardware = await _captureHardwareSnapshot(hostId, 'after_context_probe', settings);
  if (contextHardware) {
    hardwareSnapshots.push(contextHardware);
    profileData.hardwareTelemetry = _buildHardwareTelemetry(hardwareSnapshots);
    profileData.profilerCapabilities = _buildProfilerCapabilities(depth, profileData.hardwareTelemetry);
  }
  // The context probe already records the largest passing point. Preserve the
  // measured value exactly; arbitrary percentage margins create a second,
  // hidden runtime context policy.
  profileData.spill.lastSafeNumCtx = probeResult.testedNumCtx || null;

  // Context insight: compare what was configured vs what probe discovered
  if (previousCtx?.num_ctx) {
    const discovered = profileData.maxVerifiedContext;
    profileData.contextInsight = buildContextInsight(previousCtx.num_ctx, previousCtx.source, discovered);
    if (profileData.contextInsight?.upgradeAvailable) {
      logger.info(`Context upgrade available for ${modelName} on ${hostId}: ${profileData.contextInsight.recommendation}`);
    }
  }

  if (depth === 'standard') {
    notify('saving', { message: 'Saving profile to database…' });
    checkpoint();
    const evidence = await persistProfileEvidence({
      modelName, hostId, hostUrl, artifact, profileData, assertClaimActive: checkpoint, signal
    });
    notify('saved', { message: `Profile saved for exact artifact ${modelName}` });
    return { modelName, hostId, artifact, evidenceId: evidence?._id || null, profile: profileData };
  }

  // --- full: add throughputCurve + generationStability + loadTiming ---
  const maxCtx = profileData.maxVerifiedContext;
  notify('throughput_curve', { message: `Running throughput curve across 5 context fills (max ${_formatCtx(maxCtx)})…` });
  checkpoint();
  profileData.throughputCurve = await _runThroughputCurve(hostUrl, modelName, maxCtx, settings, notify, { checkpoint, claimIdentity, signal });
  notify('generation_stability', { message: 'Testing generation stability at 64/256/512 output tokens…' });
  checkpoint();
  profileData.generationStability = await _runGenerationStability(hostUrl, modelName, maxCtx, settings, notify, { checkpoint, claimIdentity, signal });
  notify('prefill_decode_matrix', { message: 'Running fixed prefill/decode matrix…' });
  profileData.prefillDecodeMatrix = await runPrefillDecodeMatrix(hostUrl, modelName, {
    safeNumCtx: profileData.spill?.lastSafeNumCtx || maxCtx,
    timeoutMs: Math.max(120000, (Number(settings.testTimeoutSec) || 60) * 1000),
    assertClaimActive: checkpoint,
    signal,
    repeats: Math.max(5, Number(settings.fullPhaseRepeats) || 5),
    captureTelemetry: ({ prefillTokens, decodeTokens, repeat }) => _captureHardwareSnapshot(
      hostId,
      `matrix_${prefillTokens}p_${decodeTokens}d_r${repeat}`,
      settings
    ),
    onProgress: ({ index, total, cell }) => {
      const label = `${cell.prefillTokens}p/${cell.decodeTokens}d`;
      const detail = cell.status === 'pass'
        ? `prefill ${cell.prefillTokensPerSec ?? '?'} tok/s · decode ${cell.decodeTokensPerSec ?? '?'} tok/s`
        : cell.status;
      notify('prefill_decode_matrix', { message: `Matrix ${index}/${total} — ${label}: ${detail}` });
    }
  });
  notify('load_timing', { message: 'Measuring cold and hot load timing…' });
  profileData.loadTiming = await _runLoadTiming(hostUrl, modelName, {
    checkpoint,
    signal,
    minimumSamples: profileData.requiredFullPhaseSamples
  });
  const fullHardware = await _captureHardwareSnapshot(hostId, 'after_full_profile', settings);
  if (fullHardware) {
    hardwareSnapshots.push(fullHardware);
    profileData.hardwareTelemetry = _buildHardwareTelemetry(hardwareSnapshots);
    profileData.profilerCapabilities = _buildProfilerCapabilities(depth, profileData.hardwareTelemetry);
  }

  notify('saving', { message: 'Saving profile to database…' });
  checkpoint();
  const evidence = await persistProfileEvidence({
    modelName, hostId, hostUrl, artifact, profileData, assertClaimActive: checkpoint, signal
  });
  notify('saved', { message: `Profile saved for exact artifact ${modelName}` });
  return { modelName, hostId, artifact, evidenceId: evidence?._id || null, profile: profileData };
}

async function adapt() {
  const error = new Error('Model adaptation was retired: profiling records evidence for the exact installed artifact and never creates a replacement tag');
  error.statusCode = 410;
  throw error;
}

async function fullPipeline(modelName, hosts, { assertClaimActive, claimIdentityFor, signal } = {}) {
  const results = [];
  for (const host of hosts) {
    try {
      assertClaimActive?.();
      const profileResult = await profile(modelName, host.hostId, host.hostUrl, 'full', {
        assertClaimActive,
        claimIdentity: claimIdentityFor?.(host.hostUrl) || null,
        signal
      });
      results.push({
        ...host,
        profileResult,
        success: true,
        benchmarkQualified: profileResult?.profile?.benchmarkQualified === true
      });
    } catch (err) {
      if (err.authorityInvalidationFailed === true
        || err.code === 'BENCHMARK_CLAIM_LOST'
        || err.code === 'BENCHMARK_CLAIM_STOPPED') throw err;
      results.push({ ...host, success: false, error: err.message });
    }
  }
  const failures = results.filter(result => result.success !== true);
  return {
    completed: failures.length === 0 && results.length === hosts.length,
    benchmarkQualified: failures.length === 0
      && results.length === hosts.length
      && results.every(result => result.benchmarkQualified === true),
    results,
    failures: failures.map(result => ({ hostId: result.hostId, error: result.error }))
  };
}

async function preflight(batchConfig) {
  const ready = [], profilesNeeded = [], warnings = [];
  // batchOrchestrator passes the SAME hostUrl for every model in the batch —
  // resolve each distinct URL to its hostId once instead of once per model.
  const hostIdByUrl = new Map();
  for (const model of batchConfig.models) {
    // model.host may be a hostId slug or a hostUrl depending on the caller.
    // batchOrchestrator passes hostUrl. Resolve to the hostId used by storage
    // (ModelProfile.readiness is keyed by the HostProfile slug).
    let hostId = model.host;
    let hostUrl = model.hostUrl || null;
    if (typeof hostId === 'string' && /^https?:\/\//i.test(hostId)) {
      hostUrl = hostUrl || hostId;
      if (!hostIdByUrl.has(hostUrl)) {
        const hostDoc = await hostProfileService.getByUrl(hostUrl);
        hostIdByUrl.set(hostUrl, hostDoc?.hostId || null);
      }
      hostId = hostIdByUrl.get(hostUrl);
      if (!hostId) {
        profilesNeeded.push({ ...model, profileReason: 'host_not_registered' });
        continue;
      }
    }
    if (!hostUrl && hostId) {
      const hostDoc = await hostProfileService.getById(hostId);
      hostUrl = hostDoc?.hostUrl || null;
      if (!hostUrl) {
        profilesNeeded.push({ ...model, profileReason: 'host_not_registered' });
        continue;
      }
    }
    // Carry both the resolved hostId (for DB lookups) and hostUrl (for
    // network calls) on the pushed model so runPreflight doesn't have to
    // re-resolve.
    const resolved = { ...model, host: hostId, hostUrl };

    const artifact = await resolveArtifactIdentity(model.name, hostId, hostUrl, { refresh: true });
    const profile = await ModelProfile.findOne({ name: artifact.model }).select('readiness').lean();
    const readinessForHost = profile?.readiness instanceof Map
      ? profile.readiness.get(hostId)
      : profile?.readiness?.[hostId] || null;
    const performanceEvidence = readinessForHost?.evidenceId
      ? await ModelPerformanceProfile.findOne({
        _id: readinessForHost.evidenceId,
        modelName: artifact.model,
        hostId,
        active: true,
        stale: { $ne: true }
      }).lean()
      : null;
    const hasProfile = ['standard', 'full'].includes(readinessForHost?.profileDepth)
      && readinessForHost?.benchmarkQualified === true
      && hasProfilerAuthorityReceipt(readinessForHost, performanceEvidence, {
        modelName: artifact.model,
        hostId
      });

    if (!hasProfile || !identitiesMatch(readinessForHost?.artifact, artifact)) {
      profilesNeeded.push({
        ...resolved,
        artifact,
        profileReason: !hasProfile ? 'missing_or_quick_profile' : 'artifact_or_runtime_drift'
      });
      continue;
    }

    if (readinessForHost?.stale) {
      profilesNeeded.push({ ...resolved, artifact, profileReason: 'profile_marked_stale' });
      continue;
    }

    ready.push({ ...resolved, artifact });
  }
  return { ready, profilesNeeded, warnings };
}

async function runPreflight(preflightResult, hostMap, { onEvent, assertClaimActive, claimIdentityFor, signal } = {}) {
  const emit = typeof onEvent === 'function' ? onEvent : () => {};
  const profileCount = preflightResult.profilesNeeded.length;
  // Rate-limited: one Buddy preflight_start for the whole reprofile pass
  // (runs before execution → not the judge/scoring critical window). The
  // per-model timeline `emit('preflight_reprofile_start', …)` is preserved
  // below; this only adds the Buddy surface signal alongside it.
  if (profileCount) {
    buddySurface.emitLifecycle(
      'preflight_start',
      `Preflight: profiling ${profileCount} exact artifact(s) before the run…`
    );
  }
  for (const model of preflightResult.profilesNeeded) {
    const hostUrl = hostMap?.[model.host] || model.hostUrl;
    assertClaimActive?.();
    await emit('preflight_reprofile_start', { model: model.name, host: hostUrl, details: { hostId: model.host, reason: model.profileReason || 'missing_profile' } });
    await profile(model.name, model.host, hostUrl, 'standard', {
      assertClaimActive,
      claimIdentity: claimIdentityFor?.(hostUrl) || null,
      signal
    });
  }
  // Pre-run only: profiling finished, batch about to execute. Suggesting
  // is allowed here (no judge/scoring active yet).
  if (profileCount) {
    buddySurface.emitLifecycle('preflight_ok', 'Exact-artifact profiling complete — starting the run.');
  }
}

/**
 * Detect GPU spill by querying Ollama /api/ps and comparing size_vram vs size.
 * If size_vram < size, the model has spilled weights to CPU RAM.
 */
async function _detectSpill(hostUrl, modelName, signal = null) {
  const safeDefaults = {
    spillDetected: null,
    verified: false,
    lastSafeNumCtx: null,
    spillNumCtx: null,
    vramAtSpill: null,
    sizeVram: null,
    sizeTotal: null
  };

  try {
    const data = await listRunning(hostUrl, { timeoutMs: 8000, signal });
    const models = data.models || [];

    // Same matcher as contextProbeService.snapshotGpuOffload — the two spill
    // checks must agree on which /api/ps row is "this model".
    const entry = models.find(m =>
      isSameOllamaModel(m.name, modelName) || isSameOllamaModel(m.model, modelName)
    );

    if (!entry) {
      logger.debug(`_detectSpill: model ${modelName} not found in /api/ps on ${hostUrl}`);
      return safeDefaults;
    }

    const sizeVram = entry.size_vram;
    const sizeTotal = entry.size;
    if (!Number.isFinite(Number(sizeVram)) || !Number.isFinite(Number(sizeTotal)) || Number(sizeTotal) <= 0) {
      return safeDefaults;
    }
    const spillDetected = sizeVram < sizeTotal;

    return {
      spillDetected,
      verified: true,
      lastSafeNumCtx: null,
      spillNumCtx: null,
      vramAtSpill: spillDetected ? Math.round(sizeVram / (1024 * 1024)) : null,
      sizeVram,
      sizeTotal
    };
  } catch (err) {
    if (signal?.aborted) throw (signal.reason instanceof Error ? signal.reason : err);
    logger.debug(`_detectSpill: failed to query ${hostUrl}/api/ps — ${err.message}`);
    return safeDefaults;
  }
}

/**
 * Test throughput at 5 context fill percentages: 10%, 25%, 50%, 75%, 90%.
 * Returns array of { contextFillPct, numCtx, tokensPerSec, vramUsedMiB, gpuOffloaded }.
 */
async function _runThroughputCurve(hostUrl, modelName, maxCtx, settings, notify, { checkpoint = () => {}, claimIdentity = null, signal = null } = {}) {
  const percentages = [10, 25, 50, 75, 90];
  const minimumSamples = Math.max(5, Number(settings.fullPhaseRepeats) || 5);
  const results = [];

  for (const pct of percentages) {
    checkpoint();
    const numCtx = Math.max(512, Math.round(maxCtx * pct / 100));
    if (notify) notify('throughput_curve', { message: `Throughput curve: testing ${pct}% fill (${_formatCtx(numCtx)} ctx)…` });
    const samples = [];
    for (let repeat = 1; repeat <= minimumSamples; repeat += 1) {
      try {
        checkpoint();
        const testResult = await hostTestService.testModelOnHost(modelName, hostUrl, {
          numPredict: settings.numPredict,
          contextFillPct: pct,
          numCtx,
          promptWorkloadMode: 'scaled',
          timeoutMs: settings.testTimeoutSec * 1000,
          benchmarkClaim: claimIdentity,
          assertClaimActive: checkpoint,
          signal
        });
        checkpoint();
        const spillCheck = await _detectSpill(hostUrl, modelName, signal);
        checkpoint();
        samples.push({
          repeat,
          status: testResult.status === 'pass' ? 'pass' : 'error',
          tokensPerSec: testResult.tokensPerSec,
          vramUsedMiB: testResult.vramUsedMiB,
          gpuOffloaded: spillCheck.verified === true ? spillCheck.spillDetected : null,
          error: testResult.status === 'pass' ? null : (testResult.error || testResult.status)
        });
      } catch (err) {
        if (signal?.aborted || err.code === 'BENCHMARK_CLAIM_LOST' || err.code === 'BENCHMARK_CLAIM_STOPPED') throw err;
        logger.warn(`_runThroughputCurve: ${pct}% repeat ${repeat} failed for ${modelName} — ${err.message}`);
        samples.push({ repeat, status: 'error', tokensPerSec: null, vramUsedMiB: null, gpuOffloaded: null, error: err.message });
      }
    }
    const passing = samples.filter(sample => sample.status === 'pass'
      && Number(sample.tokensPerSec) > 0);
    const throughputStatistics = summarizePositiveMeasurements(
      passing.map(sample => sample.tokensPerSec),
      { minimumSamples }
    );
    results.push({
      contextFillPct: pct,
      numCtx,
      tokensPerSec: throughputStatistics.p50 || 0,
      vramUsedMiB: _median(passing.map(sample => Number(sample.vramUsedMiB)).filter(Number.isFinite)),
      gpuOffloaded: samples.every(sample => sample.gpuOffloaded === false)
        ? false
        : samples.some(sample => sample.gpuOffloaded === true) ? true : null,
      sampleCount: samples.length,
      passingSampleCount: passing.length,
      minimumSamples,
      samples,
      throughputStatistics
    });
  }

  return results;
}

/**
 * Test generation stability at 3 output token lengths: 64, 256, 512.
 * Returns array of { numPredict, tokensPerSec, totalLatencyMs }.
 */
async function _runGenerationStability(hostUrl, modelName, numCtx, settings, notify, { checkpoint = () => {}, claimIdentity = null, signal = null } = {}) {
  const targets = [64, 256, 512];
  const minimumSamples = Math.max(5, Number(settings.fullPhaseRepeats) || 5);
  const results = [];

  for (const target of targets) {
    checkpoint();
    if (notify) notify('generation_stability', { message: `Stability: generating ${target} tokens…` });
    const samples = [];
    for (let repeat = 1; repeat <= minimumSamples; repeat += 1) {
      try {
        checkpoint();
        const testResult = await hostTestService.testModelOnHost(modelName, hostUrl, {
          maxPromptTokens: settings.maxPromptTokens,
          numPredict: target,
          numCtx,
          promptWorkloadMode: 'fixed',
          timeoutMs: settings.testTimeoutSec * 1000,
          benchmarkClaim: claimIdentity,
          assertClaimActive: checkpoint,
          signal
        });
        checkpoint();
        samples.push({
          repeat,
          status: testResult.status === 'pass' ? 'pass' : 'error',
          tokensPerSec: testResult.tokensPerSec,
          totalLatencyMs: testResult.latencyMs,
          error: testResult.status === 'pass' ? null : (testResult.error || testResult.status)
        });
      } catch (err) {
        if (signal?.aborted || err.code === 'BENCHMARK_CLAIM_LOST' || err.code === 'BENCHMARK_CLAIM_STOPPED') throw err;
        logger.warn(`_runGenerationStability: ${target} tokens repeat ${repeat} failed for ${modelName} — ${err.message}`);
        samples.push({ repeat, status: 'error', tokensPerSec: null, totalLatencyMs: null, error: err.message });
      }
    }
    const passing = samples.filter(sample => sample.status === 'pass'
      && Number(sample.tokensPerSec) > 0
      && Number(sample.totalLatencyMs) > 0);
    const throughputStatistics = summarizePositiveMeasurements(passing.map(sample => sample.tokensPerSec), { minimumSamples });
    const latencyStatistics = summarizePositiveMeasurements(passing.map(sample => sample.totalLatencyMs), { minimumSamples });
    results.push({
      numPredict: target,
      tokensPerSec: throughputStatistics.p50 || 0,
      totalLatencyMs: latencyStatistics.p50 || 0,
      sampleCount: samples.length,
      passingSampleCount: passing.length,
      minimumSamples,
      samples,
      throughputStatistics,
      latencyStatistics
    });
  }

  return results;
}

/**
 * Measure cold start and hot start latency.
 * 1. Unload model (keep_alive: 0)
 * 2. Wait 2 seconds
 * 3. Cold start: timed generate call
 * 4. Hot start: immediate second generate call
 */
async function _runLoadTiming(hostUrl, modelName, { checkpoint = () => {}, signal = null, minimumSamples: requestedSamples = 3 } = {}) {
  const minimumSamples = Math.max(3, Number(requestedSamples) || 3);
  const samples = [];
  const abortableDelay = () => new Promise((resolve, reject) => {
      let settled = false;
      const cleanup = () => signal?.removeEventListener('abort', abort);
      const finish = (callback) => {
        if (settled) return;
        settled = true;
        cleanup();
        callback();
      };
      const timer = setTimeout(() => finish(resolve), 2000);
      const abort = () => {
        clearTimeout(timer);
        finish(() => reject(signal.reason instanceof Error ? signal.reason : new Error('Profiler claim stopped')));
      };
      if (signal?.aborted) abort();
      else signal?.addEventListener('abort', abort, { once: true });
    });
  for (let repeat = 1; repeat <= minimumSamples; repeat += 1) {
    let unloadPending = false;
    try {
      checkpoint();
      unloadPending = true;
      await generate(hostUrl, { model: modelName, keep_alive: 0, stream: false }, { timeoutMs: 10000, signal });
      unloadPending = false;
      checkpoint();
      await abortableDelay();
      checkpoint();
      const afterUnload = await listRunning(hostUrl, { timeoutMs: 10000, signal });
      const stillResident = (afterUnload?.models || []).some(entry => isSameOllamaModel(entry?.name || entry?.model, modelName));
      if (stillResident) throw Object.assign(new Error('Cold-load sample invalid: model remained resident after unload'), { code: 'COLD_UNLOAD_NOT_ATTESTED' });

      const coldStart = Date.now();
      await generate(hostUrl, { model: modelName, prompt: 'Hi', stream: false, options: { num_predict: 1, temperature: 0, seed: 7 } }, { timeoutMs: 120000, signal });
      checkpoint();
      const coldLoadMs = Date.now() - coldStart;
      const hotStart = Date.now();
      await generate(hostUrl, { model: modelName, prompt: 'Hi', stream: false, options: { num_predict: 1, temperature: 0, seed: 7 } }, { timeoutMs: 30000, signal });
      checkpoint();
      const hotLoadMs = Date.now() - hotStart;
      samples.push({ repeat, status: 'pass', unloadVerified: true, coldLoadMs, hotLoadMs });
    } catch (err) {
      if (signal?.aborted || err.code === 'BENCHMARK_CLAIM_LOST' || err.code === 'BENCHMARK_CLAIM_STOPPED') throw err;
      if (unloadPending) {
        err.retainAdmission = true;
        err.code = err.code || 'OLLAMA_UNLOAD_TERMINALITY_UNKNOWN';
        throw err;
      }
      logger.warn(`_runLoadTiming: repeat ${repeat} failed for ${modelName} — ${err.message}`);
      samples.push({ repeat, status: 'error', unloadVerified: false, coldLoadMs: null, hotLoadMs: null, error: err.message });
    }
  }
  const passing = samples.filter(sample => sample.status === 'pass' && sample.unloadVerified === true);
  const coldStatistics = summarizePositiveMeasurements(passing.map(sample => sample.coldLoadMs), { minimumSamples });
  const hotStatistics = summarizePositiveMeasurements(passing.map(sample => sample.hotLoadMs), { minimumSamples });
  return {
    coldLoadMs: coldStatistics.p50,
    hotLoadMs: hotStatistics.p50,
    unloadVerified: passing.length === minimumSamples,
    sampleCount: samples.length,
    passingSampleCount: passing.length,
    minimumSamples,
    samples,
    coldStatistics,
    hotStatistics
  };
}

module.exports = {
  scout, profile, adapt, fullPipeline, preflight, runPreflight,
  _detectSpill, _runThroughputCurve, _runGenerationStability, _runLoadTiming,
  summarizeThroughputSamples,
  summarizePositiveMeasurements,
  hasProfilerAuthorityReceipt,
  profileQualificationFailures,
  _contextProbeRepeatsForDepth: contextProbeRepeatsForDepth,
  _buildProfilerCapabilities
};
