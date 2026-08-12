/**
 * Benchmark-owned context probe service.
 *
 * Empirically tests usable context for a model on a host and persists results
 * to benchmark-owned storage instead of writing back into modelregistries.
 */

const ModelProfile = require('../../models/ModelProfile');
const ModelContextProbeSnapshot = require('../../models/ModelContextProbeSnapshot');
const ollamaVramService = require('./ollamaVramService');
const modelContextProfileService = require('./modelContextProfileService');
const { showModel, generate, listRunning } = require('../clients/ollamaClient');
const { generateFillPrompt } = require('./contextProbePayload');
const { isSameOllamaModel } = require('../helpers/ollamaModelIdentity');
const { normalizeHostUrl } = require('../helpers/ollamaHostConfig');
const { normalizeModelName, resolveModelNumCtxDetails } = require('./modelContextResolver');
const { parseQuantization } = require('./parameterDetection');
const { resolveHostBandwidthGBs, isImplausibleThroughput } = require('./modelFitEstimator');
const logger = require('../../config/logger');

const DEFAULT_DEGRADATION_PCT = 50;
const DEFAULT_TIMEOUT_MS = 120000;
const DEFAULT_MIN_CTX = 2048;
const DEFAULT_MAX_CTX = 262144;
// Decode length per probe step. The old value (16) only exercised prefill, so a
// context could pass the probe yet stall during a real (longer) generation —
// the "detected big context but hangs in use" gap. 64 exercises sustained
// decode at the tested fill without making the probe crawl. Env-overridable.
const PROBE_NUM_PREDICT = parseInt(process.env.CONTEXT_PROBE_NUM_PREDICT, 10) || 64;
const DEFAULT_MAX_SANE_TOKENS_PER_SEC = 10000;
const MIN_PROBE_COMPLETION_TOKENS = Math.min(
  PROBE_NUM_PREDICT,
  parseInt(process.env.CONTEXT_PROBE_MIN_COMPLETION_TOKENS, 10)
    || Math.max(4, Math.floor(PROBE_NUM_PREDICT * 0.5))
);

function maxSaneTokensPerSec() {
  const value = Number(process.env.CONTEXT_PROBE_MAX_SANE_TOKENS_PER_SEC);
  return Number.isFinite(value) && value > 0 ? value : DEFAULT_MAX_SANE_TOKENS_PER_SEC;
}

function isSaneTokensPerSec(tokensPerSec) {
  const value = Number(tokensPerSec);
  return Number.isFinite(value) && value >= 0 && value <= maxSaneTokensPerSec();
}

// Margin above the analytical physical ceiling before a reading is rejected.
// Generous on purpose: the ceiling is an estimate, and false-flagging a real
// probe is worse than letting a borderline artifact through (the flat cap is
// the hard backstop). Env-overridable.
const PHYSICAL_CEILING_MARGIN = (() => {
  const v = Number(process.env.CONTEXT_PROBE_CEILING_MARGIN);
  return Number.isFinite(v) && v > 0 ? v : 2;
})();

/**
 * Throughput plausibility for a probe reading. Two layers:
 *  1. Flat sane cap (`maxSaneTokensPerSec`) — host-agnostic hard backstop, always on.
 *  2. B1 model-aware physical ceiling (llmfit-derived: bandwidth ÷ active-weight)
 *     — a tighter bound that catches sub-cap artifacts (e.g. 5000 tok/s on a 30B
 *     where the flat 10000 cap would pass). Applied ONLY when inputs are
 *     trustworthy: a resolvable host bandwidth AND an explicit quant in the model
 *     name. Skipped for ambiguous names (`*-qat`, no-quant) to avoid false
 *     positives on MoE models whose active-params aren't encoded in the name.
 * @returns {{ plausible: boolean, detail: string|null }}
 */
function assessThroughputPlausibility(tokensPerSec, { modelName, hostUrl, family, families, architecture, modelInfo } = {}) {
  if (!isSaneTokensPerSec(tokensPerSec)) {
    return { plausible: false, detail: `${tokensPerSec} tok/s exceeds sane cap ${maxSaneTokensPerSec()} tok/s` };
  }
  const hostBandwidthGBs = resolveHostBandwidthGBs(hostUrl);
  const quant = parseQuantization(modelName);
  if (hostBandwidthGBs && quant) {
    const ceiling = isImplausibleThroughput(tokensPerSec, {
      modelName,
      hostBandwidthGBs,
      family,
      families,
      architecture,
      modelInfo,
      marginFactor: PHYSICAL_CEILING_MARGIN
    });
    if (ceiling.implausible) {
      return {
        plausible: false,
        detail: `${Number(tokensPerSec).toFixed(1)} tok/s exceeds physical ceiling `
          + `${ceiling.ceilingTokSec.toFixed(1)} tok/s (×${PHYSICAL_CEILING_MARGIN}) for ${modelName} on ${hostUrl}`
      };
    }
  }
  return { plausible: true, detail: null };
}

function findImplausibleThroughputStep(steps = [], modelContext = null) {
  return steps.find((step) => !assessThroughputPlausibility(step?.tokensPerSec, modelContext || {}).plausible);
}

function getConfig() {
  return {
    degradationPct: parseInt(process.env.CONTEXT_PROBE_DEGRADATION_PCT, 10) || DEFAULT_DEGRADATION_PCT,
    timeoutMs: parseInt(process.env.CONTEXT_PROBE_TIMEOUT_MS, 10) || DEFAULT_TIMEOUT_MS,
    minCtx: parseInt(process.env.CONTEXT_PROBE_MIN_CTX, 10) || DEFAULT_MIN_CTX,
    maxCtx: parseInt(process.env.CONTEXT_PROBE_MAX_CTX, 10) || DEFAULT_MAX_CTX
  };
}

function buildCoarseCandidates(minCtx, upperBound) {
  const floorCtx = Math.max(1, Math.floor(minCtx));
  const ceilingCtx = Math.max(floorCtx, Math.floor(upperBound));
  const candidates = [floorCtx];

  let nextCtx = floorCtx;
  while (nextCtx < ceilingCtx) {
    nextCtx *= 2;
    if (nextCtx >= ceilingCtx) break;
    candidates.push(nextCtx);
  }

  if (candidates[candidates.length - 1] !== ceilingCtx) {
    candidates.push(ceilingCtx);
  }

  return candidates;
}

function buildRefinementStages(lowerBound, upperBound, minIncrement) {
  const baseIncrement = Math.max(1, Math.floor(minIncrement));
  const range = Math.max(0, Math.floor(upperBound) - Math.floor(lowerBound));
  if (range <= baseIncrement) return [];

  let step = 2 ** Math.floor(Math.log2(Math.max(baseIncrement, Math.floor(range / 4))));
  const stages = [];

  while (step >= baseIncrement) {
    stages.push(step);
    step = Math.floor(step / 2);
  }

  if (stages[stages.length - 1] !== baseIncrement) {
    stages.push(baseIncrement);
  }

  return stages;
}

function assessProbeStep(step, baselineSpeed, speedThreshold) {
  const requestPassed = step.passed;
  const hasGpuSpill = step.gpuPercent !== null && step.gpuPercent < 100;
  const degradationPct = baselineSpeed > 0
    ? Number(((1 - step.tokensPerSec / baselineSpeed) * 100).toFixed(1))
    : null;
  const speedOk = requestPassed && step.tokensPerSec >= speedThreshold;

  if (speedOk && !hasGpuSpill) {
    step.passed = true;
    step.degradationPct = degradationPct;
    step.reason = `${step.tokensPerSec} tok/s (${degradationPct}% drop) GPU=${step.gpuPercent ?? '?'}%`;
    return step;
  }

  step.passed = false;
  step.degradationPct = degradationPct;
  step.reason = hasGpuSpill
    ? `GPU spill: ${step.gpuPercent}% on GPU (${step.tokensPerSec} tok/s)`
    : (!requestPassed ? (step.reason || 'Request failed') : `${step.tokensPerSec} tok/s < threshold ${speedThreshold.toFixed(1)} tok/s`);
  return step;
}

async function refinePassingBracket(lowerPassingCtx, upperFailingCtx, minIncrement, testCandidate) {
  let bestPassingCtx = lowerPassingCtx;
  let failLimit = upperFailingCtx;
  const refinementStages = buildRefinementStages(lowerPassingCtx, upperFailingCtx, minIncrement);

  for (const increment of refinementStages) {
    let candidate = bestPassingCtx + increment;
    while (candidate < failLimit) {
      const step = await testCandidate(candidate);
      if (step.passed) {
        bestPassingCtx = step.numCtx;
        candidate = bestPassingCtx + increment;
        continue;
      }

      failLimit = candidate;
      break;
    }
  }

  return bestPassingCtx;
}

async function resolveHostUrl(modelName, explicitHostUrl) {
  if (explicitHostUrl) {
    return normalizeHostUrl(explicitHostUrl);
  }

  const entry = await ModelProfile.findOne({
    $or: [
      { name: normalizeModelName(modelName) }
    ]
  }).lean();

  const hostUrl = normalizeHostUrl(entry?.sourceHost || entry?.host || null);
  if (!hostUrl) {
    throw new Error(`No host URL found for model: ${modelName}`);
  }

  return hostUrl;
}

async function fetchModelMetadata(hostUrl, modelName) {
  try {
    const data = await showModel(hostUrl, modelName);
    const info = data.model_info || {};
    let theoreticalMax = null;
    for (const key of Object.keys(info)) {
      if (key.includes('context_length') && typeof info[key] === 'number') {
        theoreticalMax = info[key];
        break;
      }
    }
    return {
      theoreticalMax,
      modelInfo: info,
      family: data.details?.family || null,
      families: Array.isArray(data.details?.families) ? data.details.families : [],
      architecture: info['general.architecture'] || data.details?.family || null
    };
  } catch (err) {
    logger.warn('Failed to fetch model theoretical max', { hostUrl, modelName, error: err.message });
    return { theoreticalMax: null, modelInfo: {}, family: null, families: [], architecture: null };
  }
}

async function fetchModelTheoreticalMax(hostUrl, modelName) {
  const metadata = await fetchModelMetadata(hostUrl, modelName);
  return metadata.theoreticalMax;
}

async function sendProbeRequest(hostUrl, modelName, prompt, numCtx, timeoutMs) {
  const start = Date.now();
  try {
    const data = await generate(hostUrl, {
      model: modelName,
      prompt,
      stream: false,
      options: {
        num_ctx: numCtx,
        num_predict: PROBE_NUM_PREDICT,
        temperature: 0.1
      }
    }, { timeoutMs });

    const latencyMs = Date.now() - start;
    const evalCount = data.eval_count || 0;
    const evalDuration = data.eval_duration || 0;
    const promptTokens = data.prompt_eval_count || 0;
    const durationSec = evalDuration / 1e9;
    const tokensPerSec = durationSec > 0 ? evalCount / durationSec : 0;

    return {
      ok: true,
      tokensPerSec: Number(tokensPerSec.toFixed(2)),
      promptTokens,
      completionTokens: evalCount,
      latencyMs
    };
  } catch (err) {
    return {
      ok: false,
      tokensPerSec: 0,
      promptTokens: 0,
      completionTokens: 0,
      latencyMs: Date.now() - start,
      error: err.message
    };
  }
}

async function snapshotVram(hostUrl) {
  try {
    const result = await ollamaVramService.getHostVram(hostUrl);
    if (result.ok) {
      return { usedMiB: result.memoryUsedMiBTotal, totalMiB: result.memoryTotalMiBTotal };
    }
  } catch (_) {
    // best effort
  }
  return { usedMiB: null, totalMiB: null };
}

async function snapshotGpuOffload(hostUrl, modelName) {
  try {
    const data = await listRunning(hostUrl);
    const model = (data.models || []).find((item) =>
      isSameOllamaModel(item.name, modelName) || isSameOllamaModel(item.model, modelName)
    );
    if (!model) {
      return { gpuPercent: null, sizeTotal: null, sizeVram: null, contextLength: null };
    }

    const sizeTotal = model.size || 0;
    const sizeVram = model.size_vram || 0;
    const gpuPercent = sizeTotal > 0 ? Number(((sizeVram / sizeTotal) * 100).toFixed(1)) : null;

    return {
      gpuPercent,
      sizeTotal,
      sizeVram,
      contextLength: model.context_length || null
    };
  } catch (_) {
    return { gpuPercent: null, sizeTotal: null, sizeVram: null, contextLength: null };
  }
}

async function runStep(hostUrl, modelName, numCtx, timeoutMs, promptFillPct = 80, modelContext = {}) {
  const fillRatio = Math.min(100, Math.max(5, Number(promptFillPct) || 80)) / 100;
  const { prompt } = generateFillPrompt(Math.floor(numCtx * fillRatio));
  const probeResult = await sendProbeRequest(hostUrl, modelName, prompt, numCtx, timeoutMs);
  const shortCompletion = probeResult.ok && probeResult.completionTokens < MIN_PROBE_COMPLETION_TOKENS;
  const plausibility = probeResult.ok
    ? assessThroughputPlausibility(probeResult.tokensPerSec, { ...modelContext, modelName, hostUrl })
    : { plausible: true, detail: null };
  const implausibleThroughput = probeResult.ok && !plausibility.plausible;
  const [vram, offload] = await Promise.all([
    snapshotVram(hostUrl),
    snapshotGpuOffload(hostUrl, modelName)
  ]);

  return {
    numCtx,
    tokensPerSec: probeResult.tokensPerSec,
    promptTokens: probeResult.promptTokens,
    completionTokens: probeResult.completionTokens,
    vramUsedMiB: vram.usedMiB,
    vramTotalMiB: vram.totalMiB,
    gpuPercent: offload.gpuPercent,
    gpuSizeTotal: offload.sizeTotal,
    gpuSizeVram: offload.sizeVram,
    ollamaContextLength: offload.contextLength,
    latencyMs: probeResult.latencyMs,
    promptFillPct: Math.round(fillRatio * 100),
    requestedCompletionTokens: PROBE_NUM_PREDICT,
    minCompletionTokens: MIN_PROBE_COMPLETION_TOKENS,
    passed: probeResult.ok && !shortCompletion && !implausibleThroughput,
    reason: implausibleThroughput
      ? `Implausible throughput: ${plausibility.detail}`
      : shortCompletion
      ? `Short completion: ${probeResult.completionTokens}/${PROBE_NUM_PREDICT} tokens generated; probe decode sample is invalid`
      : (probeResult.ok ? null : probeResult.error)
  };
}

async function probeModelContext(modelName, options = {}) {
  // Maintenance-mode gate: the probe sweeps num_ctx across a staged search on a
  // live host, which evicts the KV cache and breaks concurrent production
  // traffic. Callers must explicitly acknowledge they are running maintenance.
  // (Audit 2026-04-18 §4.2 step 5 — the durable version will consult
  // HostPreference.status once the pinning plan lands tasks 0049-0059.)
  if (options.acknowledgeMaintenance !== true) {
    throw new Error('Context probe refused: caller must set acknowledgeMaintenance:true — probe evicts KV cache and breaks live traffic');
  }

  const cfg = getConfig();
  const degradationPct = options.degradationPct ?? cfg.degradationPct;
  const timeoutMs = options.timeoutMs ?? cfg.timeoutMs;
  const minCtx = options.minCtx ?? cfg.minCtx;
  const maxCtx = options.maxCtx ?? cfg.maxCtx;
  const promptFillPct = Math.min(100, Math.max(5, Number(options.contextProbeFillPct ?? options.promptFillPct ?? 80) || 80));
  const probeNotify = typeof options.onProgress === 'function' ? options.onProgress : () => {};
  const normalizedModel = normalizeModelName(modelName);
  const hostUrl = await resolveHostUrl(normalizedModel, options.hostUrl);
  const probeStart = Date.now();
  const steps = [];

  try {
    const seedResolution = await resolveModelNumCtxDetails(normalizedModel, { targetHost: hostUrl });
    const metadata = await fetchModelMetadata(hostUrl, normalizedModel);
    const theoreticalMax = metadata.theoreticalMax;
    const modelContext = { modelName: normalizedModel, hostUrl, ...metadata };
    const upperBound = Math.max(minCtx, Math.min(theoreticalMax || maxCtx, maxCtx));
    const coarseCandidates = buildCoarseCandidates(minCtx, upperBound);
    const stepCache = new Map();

    if (coarseCandidates.length === 0) {
      throw new Error(`No valid context candidates for ${normalizedModel}`);
    }

    probeNotify({ type: 'baseline', numCtx: coarseCandidates[0], tokensPerSec: null });
    const baseline = await runStep(hostUrl, normalizedModel, coarseCandidates[0], timeoutMs, promptFillPct, modelContext);
    steps.push(baseline);
    stepCache.set(baseline.numCtx, baseline);

    if (!baseline.passed) {
      throw new Error(`Baseline failed at num_ctx=${coarseCandidates[0]}: ${baseline.reason}`);
    }

    const baselineSpeed = baseline.tokensPerSec;
    if (baselineSpeed <= 0) {
      throw new Error('Baseline produced 0 tokens/sec');
    }

    probeNotify({ type: 'baseline', numCtx: coarseCandidates[0], tokensPerSec: baselineSpeed });
    baseline.reason = `Baseline: ${baselineSpeed} tok/s`;
    baseline.degradationPct = 0;

    const speedThreshold = baselineSpeed * (1 - degradationPct / 100);
    let bestPassingStep = baseline;

    async function testCandidate(numCtx) {
      if (stepCache.has(numCtx)) {
        return stepCache.get(numCtx);
      }

      // The fill percentage is fixed for a whole probe run so degradation
      // compares like with like.
      const evaluatedStep = assessProbeStep(
        await runStep(hostUrl, normalizedModel, numCtx, timeoutMs, promptFillPct, modelContext),
        baselineSpeed,
        speedThreshold
      );

      stepCache.set(numCtx, evaluatedStep);
      steps.push(evaluatedStep);
      probeNotify({
        type: 'step',
        numCtx,
        tokensPerSec: evaluatedStep.tokensPerSec,
        degradationPct: evaluatedStep.degradationPct,
        passed: evaluatedStep.passed
      });
      return evaluatedStep;
    }

    for (const candidate of coarseCandidates.slice(1)) {
      const step = await testCandidate(candidate);
      if (step.passed) {
        bestPassingStep = step;
        continue;
      }

      const refinedBestCtx = await refinePassingBracket(
        bestPassingStep.numCtx,
        candidate,
        minCtx,
        testCandidate
      );
      bestPassingStep = stepCache.get(refinedBestCtx) || bestPassingStep;
      break;
    }

    const testedNumCtx = bestPassingStep.numCtx;
    const bestStep = steps.find((step) => step.numCtx === testedNumCtx && step.passed) || baseline;
    const degradation = Number(((1 - bestStep.tokensPerSec / baselineSpeed) * 100).toFixed(1));
    probeNotify({ type: 'result', testedNumCtx, degradationPct: degradation });

    const implausibleStep = findImplausibleThroughputStep(steps, modelContext);
    if (implausibleStep) {
      const { detail } = assessThroughputPlausibility(implausibleStep.tokensPerSec, modelContext);
      throw new Error(`Implausible throughput at num_ctx=${implausibleStep.numCtx}: ${detail || `${implausibleStep.tokensPerSec} tok/s implausible`}`);
    }

    const snapshot = await ModelContextProbeSnapshot.create({
      modelName: normalizedModel,
      hostUrl,
      testedNumCtx,
      baselineTokensPerSec: baselineSpeed,
      atLimitTokensPerSec: bestStep.tokensPerSec,
      degradationPct: degradation,
      degradationThreshold: degradationPct,
      promptFillPct,
      vramAtLimitMiB: bestStep.vramUsedMiB ?? null,
      gpuPercentAtLimit: bestStep.gpuPercent ?? null,
      modelTheoreticalMax: theoreticalMax,
      resolutionSeedNumCtx: seedResolution.num_ctx,
      resolutionSeedSource: seedResolution.source,
      testedAt: new Date(),
      testDurationMs: Date.now() - probeStart,
      status: 'completed',
      error: null,
      steps
    });

    logger.info('Benchmark context probe completed', {
      modelName: normalizedModel,
      hostUrl,
      testedNumCtx,
      durationMs: snapshot.testDurationMs
    });

    const snapshotObject = snapshot.toObject();
    try {
      await modelContextProfileService.updateFromProbeSnapshot(snapshotObject);
    } catch (profileErr) {
      logger.warn('Failed to update model context profile from probe snapshot', {
        modelName: normalizedModel,
        hostUrl,
        snapshotId: snapshotObject._id ? String(snapshotObject._id) : null,
        error: profileErr.message
      });
    }

    return snapshotObject;
  } catch (err) {
    const snapshot = await ModelContextProbeSnapshot.create({
      modelName: normalizedModel,
      hostUrl,
      testedNumCtx: null,
      testedAt: new Date(),
      testDurationMs: Date.now() - probeStart,
      status: 'failed',
      error: err.message,
      promptFillPct,
      steps
    });
    logger.error('Benchmark context probe failed', { modelName: normalizedModel, hostUrl, error: err.message });
    throw Object.assign(new Error(err.message), {
      snapshotId: snapshot?._id ? snapshot._id.toString() : null
    });
  }
}

async function getProbeStatus(modelName, options = {}) {
  const filter = {
    modelName: normalizeModelName(modelName)
  };
  if (options.hostUrl) {
    filter.hostUrl = normalizeHostUrl(options.hostUrl);
  }
  return ModelContextProbeSnapshot.findOne(filter).sort({ testedAt: -1 }).lean();
}

module.exports = {
  probeModelContext,
  getProbeStatus,
  getConfig,
  _internal: {
    assessProbeStep,
    buildCoarseCandidates,
    buildRefinementStages,
    refinePassingBracket,
    fetchModelTheoreticalMax,
    sendProbeRequest,
    snapshotVram,
    snapshotGpuOffload,
    runStep,
    MIN_PROBE_COMPLETION_TOKENS,
    PROBE_NUM_PREDICT,
    findImplausibleThroughputStep,
    assessThroughputPlausibility,
    isSaneTokensPerSec,
    maxSaneTokensPerSec
  }
};
