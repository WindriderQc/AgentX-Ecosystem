'use strict';

const hostTestService = require('../hostTestService');
const contextProbeService = require('../contextProbeService');
const modelProfileService = require('./modelProfileService');
const adaptationService = require('./adaptationService');
const hostProfileService = require('./hostProfileService');
const settingsService = require('./settingsService');
const liveProbeService = require('./liveProbeService');
const { runPrefillDecodeMatrix } = require('./prefillDecodeMatrix');
const { profileThinkingBehavior } = require('./thinkingProfileService');
const { buildAdaptedName } = require('./namingConvention');
const { resolveModelNumCtxDetails, modelNameCandidates } = require('../modelContextResolver');
const { listRunning, generate, showModel } = require('../../clients/ollamaClient');
const { isSameOllamaModel } = require('../../helpers/ollamaModelIdentity');
const ModelAdaptation = require('../../../models/ModelAdaptation');
const ModelProfile = require('../../../models/ModelProfile');
const logger = require('../../../config/logger');
const buddySurface = require('../benchmark/buddySurfaceEvents');

const READY_STAGES = new Set(['profiled', 'adapted', 'benchmarked']);

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
    recommendation = `Can handle ${_formatCtx(discoveredNumCtx)} context (currently ${_formatCtx(previousNumCtx)}) — ${factor}x upgrade available`;
  } else if (downgrade) {
    recommendation = `Current ${_formatCtx(previousNumCtx)} exceeds safe limit ${_formatCtx(discoveredNumCtx)} — reduce to avoid spill`;
  } else {
    recommendation = `Already near optimal (${_formatCtx(previousNumCtx)} → ${_formatCtx(discoveredNumCtx)})`;
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

function summarizeThroughputSamples(samples) {
  // Exclude warm-up / discarded samples from steady-state stats. They stay
  // on the record (sample.discarded=true) so the UI can show them, but they
  // never contribute to mean/median/CV/reliability.
  const kept = samples.filter(s => !s.discarded);
  const passing = kept.filter(s => s.status === 'pass' && Number.isFinite(Number(s.tokensPerSec)) && Number(s.tokensPerSec) > 0);
  const values = passing.map(s => Number(s.tokensPerSec));
  if (!values.length) {
    return {
      sampleCount: kept.length,
      tokensPerSecMean: null,
      tokensPerSecMedian: null,
      tokensPerSecMin: null,
      tokensPerSecMax: null,
      tokensPerSecStdDev: null,
      coefficientOfVariation: null,
      reliability: 'unknown'
    };
  }
  const mean = values.reduce((sum, n) => sum + n, 0) / values.length;
  // Single sample → CV is mathematically 0 but tells us nothing about
  // variance. Surface that as 'unknown' rather than misleading 'high'.
  if (values.length < 2) {
    return {
      sampleCount: kept.length,
      tokensPerSecMean: _round(mean),
      tokensPerSecMedian: _round(mean),
      tokensPerSecMin: _round(mean),
      tokensPerSecMax: _round(mean),
      tokensPerSecStdDev: null,
      coefficientOfVariation: null,
      reliability: 'unknown'
    };
  }
  const variance = values.reduce((sum, n) => sum + ((n - mean) ** 2), 0) / values.length;
  const stdDev = Math.sqrt(variance);
  const cv = mean > 0 ? stdDev / mean : null;
  const reliability = cv == null ? 'unknown' : cv <= 0.05 ? 'high' : cv <= 0.12 ? 'medium' : 'low';
  return {
    sampleCount: kept.length,
    tokensPerSecMean: _round(mean),
    tokensPerSecMedian: _round(_median(values)),
    tokensPerSecMin: _round(Math.min(...values)),
    tokensPerSecMax: _round(Math.max(...values)),
    tokensPerSecStdDev: _round(stdDev),
    coefficientOfVariation: cv == null ? null : _round(cv, 4),
    reliability
  };
}

function _sampleFromResult(result, sample, opts = {}) {
  return {
    sample,
    tokensPerSec: result.tokensPerSec ?? null,
    promptEvalTokensPerSec: result.promptEvalTokensPerSec ?? null,
    ttftMs: result.timeToFirstTokenMs ?? null,
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

async function scout(modelName, hosts) {
  const results = [];
  for (const host of hosts) {
    try {
      const testResult = await hostTestService.testModelOnHost(modelName, host.hostUrl);
      results.push({
        hostId: host.hostId,
        fit: testResult.status === 'pass',
        tokensPerSec: testResult.tokensPerSec || null,
        error: testResult.error || null
      });
    } catch (err) {
      results.push({ hostId: host.hostId, fit: false, error: err.message });
    }
  }
  return results;
}

async function profile(modelName, hostId, hostUrl, depth = 'standard', { onProgress } = {}) {
  const notify = typeof onProgress === 'function' ? onProgress : () => {};
  logger.info(`Profiling ${modelName} on ${hostId} (${depth})`);
  const settings = await settingsService.getAll();
  const hardwareSnapshots = [];
  const initialHardware = await _captureHardwareSnapshot(hostId, 'before_profile', settings);
  if (initialHardware) hardwareSnapshots.push(initialHardware);

  // Snapshot current context from the Ollama Modelfile (source of truth)
  let previousCtx = null;
  try {
    const showData = await showModel(hostUrl, modelName);
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
    logger.debug(`Could not read Modelfile context for ${modelName}: ${err.message}`);
  }
  // Last resort: resolution chain
  if (!previousCtx) {
    try {
      previousCtx = await resolveModelNumCtxDetails(modelName, { targetHost: hostUrl });
    } catch (err) {
      logger.debug(`Could not resolve pre-profile context for ${modelName}: ${err.message}`);
    }
  }

  // --- warmup + single throughput test ---
  // skipPriorProfileArtifacts: the deployed adaptation and latest probe
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
    skipPriorProfileArtifacts: true
  };
  const testResult = await hostTestService.testModelOnHost(modelName, hostUrl, baseTestOptions);
  if (testResult.status !== 'pass') {
    throw new Error(`Throughput test failed: ${testResult.error || testResult.status}`);
  }

  const requestedSamples = Math.max(1, Math.min(5, Number(settings.throughputSamples) || 1));
  // When 3+ samples are requested, drop sample 1 from CV stats: even after
  // the explicit 2-pass warm-up, the first measured run can carry KV-cache
  // settle overhead that inflates variance. With 1 or 2 samples we have no
  // budget to discard, so we keep them all.
  const discardFirst = requestedSamples >= 3;
  const throughputSamples = [_sampleFromResult(testResult, 1, discardFirst
    ? { discarded: true, discardReason: 'warmup_settle' }
    : {})];
  for (let i = 2; i <= requestedSamples; i++) {
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
  const measurementQuality = summarizeThroughputSamples(throughputSamples);
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

  const representativeTokensPerSec = measurementQuality.tokensPerSecMedian || testResult.tokensPerSec;
  const tpsStr = Number(representativeTokensPerSec).toFixed(1);
  const ttftStr = testResult.timeToFirstTokenMs ? ` · TTFT ${Math.round(testResult.timeToFirstTokenMs)}ms` : '';
  const pevalStr = testResult.promptEvalTokensPerSec ? ` · prompt eval ${Number(testResult.promptEvalTokensPerSec).toFixed(0)} tok/s` : '';
  notify('throughput', {
    message: `Throughput: ${tpsStr} tok/s${ttftStr}${pevalStr} · reliability ${measurementQuality.reliability}`,
    tokensPerSec: representativeTokensPerSec,
    measurementQuality,
    sampleCount: throughputSamples.length
  });

  notify('spill_detection', { message: 'Checking GPU memory offload…' });
  const spill = await _detectSpill(hostUrl, modelName);
  const spillMsg = spill.spillDetected
    ? `Spill detected — ${spill.sizeVram && spill.sizeTotal ? Math.round(spill.sizeVram / spill.sizeTotal * 100) : '?'}% on GPU`
    : 'No spill — model fully loaded on GPU';
  notify('spill_detection', { message: spillMsg });
  const spillHardware = await _captureHardwareSnapshot(hostId, 'after_spill_detection', settings);
  if (spillHardware) hardwareSnapshots.push(spillHardware);

  let thinkingProfile = null;
  if (settings.thinkingProbeEnabled !== false) {
    notify('thinking_behavior', { message: 'Checking think=true behavior and visible-answer safety…' });
    try {
      thinkingProfile = await profileThinkingBehavior(modelName, hostUrl, {
        numCtx: testResult.numCtx || null,
        numPredict: 512,
        timeoutMs: Math.max(60000, (Number(settings.testTimeoutSec) || 60) * 1000)
      });
      notify('thinking_behavior', {
        message: `Thinking behavior: ${thinkingProfile.recommendedPolicy} (${thinkingProfile.channel}, ${thinkingProfile.supportSignal})`,
        thinking: thinkingProfile
      });
    } catch (err) {
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

  const profileData = {
    tokensPerSec: representativeTokensPerSec,
    promptEvalTokensPerSec: testResult.promptEvalTokensPerSec || null,
    ttftMs: testResult.timeToFirstTokenMs || null,
    comparisonPromptTokens: testResult.promptTokens || null,
    comparisonPromptTargetTokens: testResult.requestedPromptTokens || null,
    contextProbeFillPct: Number(settings.contextProbeFillPct) || 80,
    comparisonWorkloadMode: testResult.promptWorkloadMode || 'fixed',
    optimalNumCtx: testResult.numCtx || null,
    vramUsedMiB: testResult.vramUsedMiB || null,
    throughputSamples,
    measurementQuality,
    spill: {
      ...spill,
      // The /api/ps check itself can't know the context — it observed the
      // model as loaded by the throughput test, so that test's numCtx is the
      // context at which the spill was (or wasn't) seen.
      spillNumCtx: spill.spillDetected ? (testResult.numCtx || null) : null,
      lastSafeNumCtx: spill.spillDetected ? null : (testResult.numCtx || null)
    },
    profiledAt: new Date(),
    profileDepth: depth,
    thinking: thinkingProfile,
    hardwareTelemetry: _buildHardwareTelemetry(hardwareSnapshots)
  };

  // --- quick: done here ---
  if (depth === 'quick') {
    if (previousCtx?.num_ctx) {
      const discovered = profileData.spill?.lastSafeNumCtx || profileData.optimalNumCtx;
      profileData.contextInsight = buildContextInsight(previousCtx.num_ctx, previousCtx.source, discovered);
    }
    notify('saving', { message: 'Saving profile to database…' });
    const lineage = adaptationService.populateLineage(modelName);
    await adaptationService.saveAdaptation({
      modelName, hostId,
      adaptedName: buildAdaptedName(modelName),
      profile: profileData,
      lineage
    });
    await modelProfileService.updateReadiness(modelName, hostId, 'profiled');
    if (profileData.thinking) {
      await modelProfileService.updateThinkingCapability(modelName, hostId, profileData.thinking);
    }
    return { modelName, hostId, profile: profileData };
  }

  // --- standard: add context probe ---
  notify('context_probe', { message: 'Probing context window — resolving model limits…' });
  const probeResult = await contextProbeService.probeModelContext(modelName, {
    hostUrl,
    acknowledgeMaintenance: true,
    contextProbeFillPct: Number(settings.contextProbeFillPct) || 80,
    onProgress: (info) => {
      if (info.type === 'baseline') {
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
  // `optimalNumCtx` is retained as a persisted compatibility field. Its value
  // is the largest verified context, not a synthetic performance tier.
  profileData.optimalNumCtx = probeResult.testedNumCtx || null;
  profileData.degradationPct = probeResult.degradationPct || null;
  profileData.probeSteps = (probeResult.steps || []).map(s => ({
    numCtx: s.numCtx, tokPerSec: s.tokensPerSec, vramMiB: s.vramMiB
  }));
  const contextHardware = await _captureHardwareSnapshot(hostId, 'after_context_probe', settings);
  if (contextHardware) {
    hardwareSnapshots.push(contextHardware);
    profileData.hardwareTelemetry = _buildHardwareTelemetry(hardwareSnapshots);
  }
  // The context probe already records the largest passing point. Preserve the
  // measured value exactly; arbitrary percentage margins create a second,
  // hidden runtime context policy.
  profileData.spill.lastSafeNumCtx = probeResult.testedNumCtx || null;

  // Context insight: compare what was configured vs what probe discovered
  if (previousCtx?.num_ctx) {
    const discovered = profileData.spill?.lastSafeNumCtx || profileData.optimalNumCtx;
    profileData.contextInsight = buildContextInsight(previousCtx.num_ctx, previousCtx.source, discovered);
    if (profileData.contextInsight?.upgradeAvailable) {
      logger.info(`Context upgrade available for ${modelName} on ${hostId}: ${profileData.contextInsight.recommendation}`);
    }
  }

  if (depth === 'standard') {
    notify('saving', { message: 'Saving profile to database…' });
    const lineage = adaptationService.populateLineage(modelName);
    await adaptationService.saveAdaptation({
      modelName, hostId,
      adaptedName: buildAdaptedName(modelName),
      profile: profileData,
      lineage
    });
    await modelProfileService.updateReadiness(modelName, hostId, 'profiled');
    if (profileData.thinking) {
      await modelProfileService.updateThinkingCapability(modelName, hostId, profileData.thinking);
    }
    // Adapt and deploy — failures block so invalid models are never left available
    notify('adapting', { message: 'Generating adapted Modelfile with optimal parameters…' });
    await adapt(modelName, hostId, hostUrl, { deploy: true });
    notify('deployed', { message: `Deployed ${buildAdaptedName(modelName)} — profile complete` });
    return { modelName, hostId, profile: profileData };
  }

  // --- full: add throughputCurve + generationStability + loadTiming ---
  const maxCtx = profileData.optimalNumCtx;
  notify('throughput_curve', { message: `Running throughput curve across 5 context fills (max ${_formatCtx(maxCtx)})…` });
  profileData.throughputCurve = await _runThroughputCurve(hostUrl, modelName, maxCtx, settings, notify);
  notify('generation_stability', { message: 'Testing generation stability at 64/256/512 output tokens…' });
  profileData.generationStability = await _runGenerationStability(hostUrl, modelName, maxCtx, settings, notify);
  notify('prefill_decode_matrix', { message: 'Running fixed prefill/decode matrix…' });
  profileData.prefillDecodeMatrix = await runPrefillDecodeMatrix(hostUrl, modelName, {
    safeNumCtx: profileData.spill?.lastSafeNumCtx || maxCtx,
    timeoutMs: Math.max(120000, (Number(settings.testTimeoutSec) || 60) * 1000),
    onProgress: ({ index, total, cell }) => {
      const label = `${cell.prefillTokens}p/${cell.decodeTokens}d`;
      const detail = cell.status === 'pass'
        ? `prefill ${cell.prefillTokensPerSec ?? '?'} tok/s · decode ${cell.decodeTokensPerSec ?? '?'} tok/s`
        : cell.status;
      notify('prefill_decode_matrix', { message: `Matrix ${index}/${total} — ${label}: ${detail}` });
    }
  });
  notify('load_timing', { message: 'Measuring cold and hot load timing…' });
  profileData.loadTiming = await _runLoadTiming(hostUrl, modelName);
  const fullHardware = await _captureHardwareSnapshot(hostId, 'after_full_profile', settings);
  if (fullHardware) {
    hardwareSnapshots.push(fullHardware);
    profileData.hardwareTelemetry = _buildHardwareTelemetry(hardwareSnapshots);
  }

  notify('saving', { message: 'Saving profile to database…' });
  const lineage = adaptationService.populateLineage(modelName);
  await adaptationService.saveAdaptation({
    modelName, hostId,
    adaptedName: buildAdaptedName(modelName),
    profile: profileData,
    lineage
  });
  await modelProfileService.updateReadiness(modelName, hostId, 'profiled');
  if (profileData.thinking) {
    await modelProfileService.updateThinkingCapability(modelName, hostId, profileData.thinking);
  }
  // Adapt and deploy — failures block so invalid models are never left available
  notify('adapting', { message: 'Generating adapted Modelfile with optimal parameters…' });
  await adapt(modelName, hostId, hostUrl, { deploy: true });
  notify('deployed', { message: `Deployed ${buildAdaptedName(modelName)} — profile complete` });
  return { modelName, hostId, profile: profileData };
}

async function adapt(modelName, hostId, hostUrl, { deploy = false } = {}) {
  const adaptation = await adaptationService.getAdaptation(modelName, hostId);
  if (!adaptation?.profile) throw new Error(`No profile data for ${modelName} on ${hostId}`);
  const hostProfile = await hostProfileService.getById(hostId);
  const config = adaptationService.generateConfig(adaptation.profile, hostProfile);
  const modelfile = adaptationService.generateModelfile(modelName, adaptation.profile, hostProfile);
  const lineage = adaptationService.populateLineage(modelName);
  await adaptationService.saveAdaptation({
    modelName, hostId,
    adaptedName: buildAdaptedName(modelName),
    config,
    modelfile,
    lineage
  });
  await modelProfileService.updateReadiness(modelName, hostId, 'adapted');
  if (deploy && hostUrl) {
    const deployment = await adaptationService.deployToHost(modelName, hostId, hostUrl);
    if (!deployment?.success) {
      throw new Error(`Deploy failed for ${buildAdaptedName(modelName)} on ${hostId}: ${deployment?.error || 'unknown error'}`);
    }
    return deployment;
  }
  return { success: true, adaptedName: buildAdaptedName(modelName), config, deployed: false };
}

async function fullPipeline(modelName, hosts) {
  const results = [];
  for (const host of hosts) {
    try {
      const profileResult = await profile(modelName, host.hostId, host.hostUrl, 'standard');
      results.push({ ...host, profileResult, success: true });
    } catch (err) {
      results.push({ ...host, success: false, error: err.message });
    }
  }
  return results;
}

async function preflight(batchConfig) {
  const ready = [], profilesNeeded = [], adaptsNeeded = [], warnings = [];
  // batchOrchestrator passes the SAME hostUrl for every model in the batch —
  // resolve each distinct URL to its hostId once instead of once per model.
  const hostIdByUrl = new Map();
  for (const model of batchConfig.models) {
    // model.host may be a hostId slug or a hostUrl depending on the caller.
    // batchOrchestrator passes hostUrl. Resolve to the hostId used by storage
    // (ModelProfile.readiness Map and ModelAdaptation both key by slug).
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
        warnings.push({ modelName: model.name, hostId: model.host, reason: 'host not found in HostProfile registry' });
        ready.push(model);
        continue;
      }
    }
    // Carry both the resolved hostId (for DB lookups) and hostUrl (for
    // network calls) on the pushed model so runPreflight doesn't have to
    // re-resolve.
    const resolved = { ...model, host: hostId, hostUrl };

    // Source of truth for "is this model ready to benchmark on this host" is
    // ModelProfile.readiness.<hostId>.stage ∈ {profiled, adapted, benchmarked}.
    // ModelAdaptation is a separate concern (tuned config deployment) and
    // should NOT trigger a re-profile when the profile itself is fresh.
    //
    // Exact model names win, with namespace-stripped names as a compatibility
    // fallback. Current profiler writes records for ax/* models under the ax
    // name; older/base records may exist under the stripped parent name.
    const lookupNames = modelNameCandidates(model.name);
    const profile = await ModelProfile.findOne({ name: { $in: lookupNames } }).select('readiness').lean();
    const readinessForHost = profile?.readiness?.[hostId] || null;
    const stage = readinessForHost?.stage || null;
    const hasProfile = stage && READY_STAGES.has(stage);

    if (!hasProfile) {
      profilesNeeded.push(resolved);
      continue;
    }

    if (readinessForHost?.stale) {
      warnings.push({ modelName: model.name, hostId, reason: 'profile marked stale — consider re-profiling' });
    }

    const adaptation = await ModelAdaptation.findOne({ modelName: { $in: lookupNames }, hostId }).lean();
    if (!adaptation || !adaptation.config || adaptation.deployment?.status !== 'deployed') {
      adaptsNeeded.push(resolved);
    } else {
      ready.push(resolved);
      if (adaptation.staleness?.stale) {
        warnings.push({ modelName: model.name, hostId, reason: adaptation.staleness.reason });
      }
    }
  }
  return { ready, profilesNeeded, adaptsNeeded, warnings };
}

async function runPreflight(preflightResult, hostMap, { onEvent } = {}) {
  const emit = typeof onEvent === 'function' ? onEvent : () => {};
  const profileCount = preflightResult.profilesNeeded.length;
  const adaptCount = preflightResult.adaptsNeeded.length;
  // Rate-limited: one Buddy preflight_start for the whole reprofile/adapt pass
  // (runs before execution → not the judge/scoring critical window). The
  // per-model timeline `emit('preflight_reprofile_start', …)` is preserved
  // below; this only adds the Buddy surface signal alongside it.
  if (profileCount || adaptCount) {
    buddySurface.emitLifecycle(
      'preflight_start',
      `Preflight: profiling ${profileCount} and adapting ${adaptCount} model(s) before the run…`
    );
  }
  for (const model of preflightResult.profilesNeeded) {
    const hostUrl = hostMap?.[model.host] || model.hostUrl;
    await emit('preflight_reprofile_start', { model: model.name, host: hostUrl, details: { hostId: model.host, reason: 'no_profile' } });
    await profile(model.name, model.host, hostUrl, 'standard');
  }
  for (const model of preflightResult.adaptsNeeded) {
    const hostUrl = hostMap?.[model.host] || model.hostUrl;
    await emit('preflight_reprofile_start', { model: model.name, host: hostUrl, details: { hostId: model.host, reason: 'missing_adaptation' } });
    await adapt(model.name, model.host, hostUrl, { deploy: true });
  }
  // Pre-run only: reprofile/adapt finished, batch about to execute. suggesting
  // is allowed here (no judge/scoring active yet).
  if (profileCount || adaptCount) {
    buddySurface.emitLifecycle('preflight_ok', 'Preflight profiling complete — starting the run.');
  }
}

/**
 * Detect GPU spill by querying Ollama /api/ps and comparing size_vram vs size.
 * If size_vram < size, the model has spilled weights to CPU RAM.
 */
async function _detectSpill(hostUrl, modelName) {
  const safeDefaults = {
    spillDetected: false,
    lastSafeNumCtx: null,
    spillNumCtx: null,
    vramAtSpill: null,
    sizeVram: null,
    sizeTotal: null
  };

  try {
    const data = await listRunning(hostUrl, { timeoutMs: 8000 });
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
    const spillDetected = sizeVram < sizeTotal;

    return {
      spillDetected,
      lastSafeNumCtx: null,
      spillNumCtx: null,
      vramAtSpill: spillDetected ? Math.round(sizeVram / (1024 * 1024)) : null,
      sizeVram,
      sizeTotal
    };
  } catch (err) {
    logger.debug(`_detectSpill: failed to query ${hostUrl}/api/ps — ${err.message}`);
    return safeDefaults;
  }
}

/**
 * Test throughput at 5 context fill percentages: 10%, 25%, 50%, 75%, 90%.
 * Returns array of { contextFillPct, numCtx, tokensPerSec, vramUsedMiB, gpuOffloaded }.
 */
async function _runThroughputCurve(hostUrl, modelName, maxCtx, settings, notify) {
  const percentages = [10, 25, 50, 75, 90];
  const results = [];

  for (const pct of percentages) {
    const numCtx = Math.max(512, Math.round(maxCtx * pct / 100));
    if (notify) notify('throughput_curve', { message: `Throughput curve: testing ${pct}% fill (${_formatCtx(numCtx)} ctx)…` });
    try {
      const testResult = await hostTestService.testModelOnHost(modelName, hostUrl, {
        numPredict: settings.numPredict,
        contextFillPct: pct,
        numCtx,
        promptWorkloadMode: 'scaled',
        timeoutMs: settings.testTimeoutSec * 1000
      });
      const spillCheck = await _detectSpill(hostUrl, modelName);
      results.push({
        contextFillPct: pct,
        numCtx,
        tokensPerSec: testResult.tokensPerSec,
        vramUsedMiB: testResult.vramUsedMiB,
        gpuOffloaded: spillCheck.spillDetected
      });
    } catch (err) {
      logger.warn(`_runThroughputCurve: ${pct}% failed for ${modelName} — ${err.message}`);
      results.push({
        contextFillPct: pct,
        numCtx,
        tokensPerSec: 0,
        vramUsedMiB: null,
        gpuOffloaded: false
      });
    }
  }

  return results;
}

/**
 * Test generation stability at 3 output token lengths: 64, 256, 512.
 * Returns array of { numPredict, tokensPerSec, totalLatencyMs }.
 */
async function _runGenerationStability(hostUrl, modelName, numCtx, settings, notify) {
  const targets = [64, 256, 512];
  const results = [];

  for (const target of targets) {
    if (notify) notify('generation_stability', { message: `Stability: generating ${target} tokens…` });
    try {
      const testResult = await hostTestService.testModelOnHost(modelName, hostUrl, {
        maxPromptTokens: settings.maxPromptTokens,
        numPredict: target,
        numCtx,
        promptWorkloadMode: 'fixed',
        timeoutMs: settings.testTimeoutSec * 1000
      });
      results.push({
        numPredict: target,
        tokensPerSec: testResult.tokensPerSec,
        totalLatencyMs: testResult.totalLatencyMs || 0
      });
    } catch (err) {
      logger.warn(`_runGenerationStability: ${target} tokens failed for ${modelName} — ${err.message}`);
      results.push({
        numPredict: target,
        tokensPerSec: 0,
        totalLatencyMs: 0
      });
    }
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
async function _runLoadTiming(hostUrl, modelName) {
  try {
    // Unload model
    await generate(hostUrl, { model: modelName, keep_alive: 0, stream: false }, { timeoutMs: 10000 });

    // Wait 2 seconds for unload to settle
    await new Promise(resolve => setTimeout(resolve, 2000));

    // Cold start
    const coldStart = Date.now();
    await generate(hostUrl, { model: modelName, prompt: 'Hi', stream: false, options: { num_predict: 1 } }, { timeoutMs: 120000 });
    const coldLoadMs = Date.now() - coldStart;

    // Hot start
    const hotStart = Date.now();
    await generate(hostUrl, { model: modelName, prompt: 'Hi', stream: false, options: { num_predict: 1 } }, { timeoutMs: 30000 });
    const hotLoadMs = Date.now() - hotStart;

    return { coldLoadMs, hotLoadMs };
  } catch (err) {
    logger.warn(`_runLoadTiming: failed for ${modelName} — ${err.message}`);
    return { coldLoadMs: null, hotLoadMs: null };
  }
}

module.exports = {
  scout, profile, adapt, fullPipeline, preflight, runPreflight,
  _detectSpill, _runThroughputCurve, _runGenerationStability, _runLoadTiming,
  summarizeThroughputSamples
};
