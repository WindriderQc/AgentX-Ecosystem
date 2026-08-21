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
const hostProfileService = require('./profiler/hostProfileService');
const { identitiesMatch, resolveArtifactIdentity } = require('./profiler/artifactIdentityService');
const { showModel, generate, listRunning } = require('../clients/ollamaClient');
const { generateFillPrompt } = require('./contextProbePayload');
const { isSameOllamaModel } = require('../helpers/ollamaModelIdentity');
const { normalizeHostUrl } = require('../helpers/ollamaHostConfig');
const { normalizeModelName, resolveModelNumCtxDetails } = require('./modelContextResolver');
const logger = require('../../config/logger');

const DEFAULT_TIMEOUT_MS = 120000;
const DEFAULT_MIN_CTX = 2048;
const DEFAULT_MAX_CTX = 262144;
// Decode length per probe step. The old value (16) only exercised prefill, so a
// context could pass the probe yet stall during a real (longer) generation —
// the "detected big context but hangs in use" gap. 64 exercises sustained
// decode at the tested fill without making the probe crawl. Env-overridable.
const PROBE_NUM_PREDICT = parseInt(process.env.CONTEXT_PROBE_NUM_PREDICT, 10) || 64;
const MIN_PROBE_COMPLETION_TOKENS = Math.min(
  PROBE_NUM_PREDICT,
  parseInt(process.env.CONTEXT_PROBE_MIN_COMPLETION_TOKENS, 10)
    || Math.max(4, Math.floor(PROBE_NUM_PREDICT * 0.5))
);

function isValidTokensPerSec(tokensPerSec) {
  const value = Number(tokensPerSec);
  return Number.isFinite(value) && value > 0;
}

/**
 * Reject only structurally impossible/corrupt throughput readings. Hardware,
 * quantization, and active-weight estimates are not measured context evidence
 * and must not decide whether a successful probe is persisted.
 * @returns {{ plausible: boolean, detail: string|null }}
 */
function validateThroughput(tokensPerSec) {
  if (!isValidTokensPerSec(tokensPerSec)) {
    return { plausible: false, detail: `${tokensPerSec} tok/s is not a positive finite measurement` };
  }
  return { plausible: true, detail: null };
}

function findInvalidThroughputStep(steps = []) {
  return steps.find((step) => (
    step?.requestSucceeded !== false
    && !validateThroughput(step?.tokensPerSec).plausible
  ));
}

function getConfig() {
  return {
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

function assessProbeStep(step, baselineSpeed) {
  const requestPassed = step.passed;
  const hasGpuSpill = step.gpuPercent !== null && step.gpuPercent < 100;
  const degradationPct = baselineSpeed > 0
    ? Number(((1 - step.tokensPerSec / baselineSpeed) * 100).toFixed(1))
    : null;

  // A larger KV cache is expected to change throughput. Record that change as
  // benchmark evidence, but do not turn an arbitrary speed delta into a
  // smaller runtime context contract. Context verification fails only when the
  // request/decode fails or the model spills off GPU.
  if (requestPassed && !hasGpuSpill) {
    step.passed = true;
    step.degradationPct = degradationPct;
    step.reason = `${step.tokensPerSec} tok/s (${degradationPct}% drop) GPU=${step.gpuPercent ?? '?'}%`;
    return step;
  }

  step.passed = false;
  step.degradationPct = degradationPct;
  step.reason = hasGpuSpill
    ? `GPU spill: ${step.gpuPercent}% on GPU (${step.tokensPerSec} tok/s)`
    : (step.reason || 'Request failed');
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
    ? validateThroughput(probeResult.tokensPerSec)
    : { plausible: true, detail: null };
  const invalidThroughput = probeResult.ok && !plausibility.plausible;
  const [vram, offload] = await Promise.all([
    snapshotVram(hostUrl),
    snapshotGpuOffload(hostUrl, modelName)
  ]);

  return {
    numCtx,
    requestSucceeded: probeResult.ok,
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
    passed: probeResult.ok && !shortCompletion && !invalidThroughput,
    reason: invalidThroughput
      ? `Invalid throughput: ${plausibility.detail}`
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
  const timeoutMs = options.timeoutMs ?? cfg.timeoutMs;
  const minCtx = options.minCtx ?? cfg.minCtx;
  const maxCtx = options.maxCtx ?? cfg.maxCtx;
  const promptFillPct = Math.min(100, Math.max(5, Number(options.contextProbeFillPct ?? options.promptFillPct ?? 80) || 80));
  const probeNotify = typeof options.onProgress === 'function' ? options.onProgress : () => {};
  const normalizedModel = normalizeModelName(modelName);
  const hostUrl = await resolveHostUrl(normalizedModel, options.hostUrl);
  const hostProfile = options.artifactIdentity ? null : await hostProfileService.getByUrl(hostUrl);
  const artifactIdentity = options.artifactIdentity || await resolveArtifactIdentity(
    normalizedModel,
    hostProfile?.hostId,
    hostUrl,
    { refresh: true }
  );
  const probeStart = Date.now();
  const steps = [];

  try {
    const seedResolution = await resolveModelNumCtxDetails(normalizedModel, {
      targetHost: hostUrl,
      artifactIdentity
    });
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

    let bestPassingStep = baseline;

    async function testCandidate(numCtx) {
      if (stepCache.has(numCtx)) {
        return stepCache.get(numCtx);
      }

      // The fill percentage is fixed for a whole probe run so throughput
      // remains comparable across verified windows.
      const evaluatedStep = assessProbeStep(
        await runStep(hostUrl, normalizedModel, numCtx, timeoutMs, promptFillPct, modelContext),
        baselineSpeed
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

    const invalidStep = findInvalidThroughputStep(steps);
    if (invalidStep) {
      const { detail } = validateThroughput(invalidStep.tokensPerSec);
      throw new Error(`Invalid throughput at num_ctx=${invalidStep.numCtx}: ${detail || `${invalidStep.tokensPerSec} tok/s invalid`}`);
    }

    const currentArtifact = await resolveArtifactIdentity(
      normalizedModel,
      hostProfile?.hostId || artifactIdentity.hostId,
      hostUrl,
      { refresh: true }
    );
    if (!identitiesMatch(artifactIdentity, currentArtifact)) {
      throw new Error(`Artifact or runtime changed during context probe for ${normalizedModel} on ${hostUrl}`);
    }

    const snapshot = await ModelContextProbeSnapshot.create({
      modelName: normalizedModel,
      hostUrl,
      hostId: currentArtifact.hostId,
      artifactDigest: currentArtifact.digest,
      runtimeFingerprint: currentArtifact.runtimeFingerprint,
      testedNumCtx,
      baselineTokensPerSec: baselineSpeed,
      atLimitTokensPerSec: bestStep.tokensPerSec,
      degradationPct: degradation,
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
      hostId: artifactIdentity.hostId,
      artifactDigest: artifactIdentity?.digest || null,
      runtimeFingerprint: artifactIdentity?.runtimeFingerprint || null,
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
    findInvalidThroughputStep,
    validateThroughput,
    isValidTokensPerSec
  }
};
