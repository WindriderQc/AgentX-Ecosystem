'use strict';

const crypto = require('crypto');
const ModelAdaptation = require('../../../models/ModelAdaptation');
const HostProfile = require('../../../models/HostProfile');
const { buildAdaptedName, isAdaptedModel } = require('./namingConvention');
const { parseQuantization } = require('../../services/parameterDetection');
const { listModels, createModel } = require('../../clients/ollamaClient');
const logger = require('../../../config/logger');

// ── Modelfile Validation ──────────────────────────────────────────────────────

const KNOWN_PARAMS = new Set([
  'num_ctx', 'num_gpu', 'num_batch', 'num_thread', 'num_predict', 'num_keep',
  'temperature', 'top_k', 'top_p', 'repeat_penalty', 'repeat_last_n', 'seed',
  'mirostat', 'mirostat_eta', 'mirostat_tau', 'tfs_z', 'stop',
  'num_gqa', 'num_kv', 'rope_frequency_base', 'rope_frequency_scale'
]);

const NUMERIC_PARAMS = new Set([...KNOWN_PARAMS].filter(p => p !== 'stop'));

/**
 * Validates a Modelfile's content against host model availability and parameter rules.
 *
 * @param {string} content  - Raw Modelfile text
 * @param {string} hostUrl  - Ollama host base URL (e.g. http://192.0.2.66:11434)
 * @returns {Promise<{valid: boolean, errors: string[], warnings: string[]}>}
 */
async function validateModelfile(content, hostUrl) {
  const errors = [];
  const warnings = [];

  const lines = content
    .split('\n')
    .map(l => l.trim())
    .filter(l => l.length > 0 && !l.startsWith('#'));

  // Check FROM directive
  const fromLine = lines.find(l => /^FROM\s+/i.test(l));
  if (!fromLine) {
    return { valid: false, errors: ['Missing FROM directive — every Modelfile must specify a base model'], warnings };
  }

  // Extract model name from FROM line
  const fromModel = fromLine.replace(/^FROM\s+/i, '').trim();

  // Check model exists on host
  try {
    const data = await listModels(hostUrl);
    const hostModels = (data.models || []).map(m => m.name);
    const found = hostModels.includes(fromModel) ||
      hostModels.includes(`${fromModel}:latest`) ||
      hostModels.includes(fromModel.replace(/:latest$/, ''));
    if (!found) {
      errors.push(`Model "${fromModel}" not found on host ${hostUrl}`);
    }
  } catch (err) {
    warnings.push(`Could not reach host to verify model: ${err.message}`);
  }

  // Validate PARAMETER lines
  for (const line of lines) {
    const paramMatch = line.match(/^PARAMETER\s+(\S+)\s+(.*)/i);
    if (!paramMatch) continue;

    const [, paramName, paramValue] = paramMatch;

    if (!KNOWN_PARAMS.has(paramName)) {
      warnings.push(`Unknown parameter "${paramName}" — will be passed through but may not be supported`);
      continue;
    }

    if (NUMERIC_PARAMS.has(paramName)) {
      const num = Number(paramValue);
      if (isNaN(num)) {
        errors.push(`Parameter "${paramName}" requires a numeric value, got "${paramValue}"`);
      }
    }
  }

  return { valid: errors.length === 0, errors, warnings };
}

// ── Lineage Tracking ──────────────────────────────────────────────────────────

/**
 * Populates lineage metadata for a model name.
 *
 * @param {string} modelName   - Full model name (e.g. llama3.1:8b-q4_K_M)
 * @param {string} [createdVia='profiler'] - Origin: 'profiler' or 'manual'
 * @returns {{parentModel: string, rootModel: string, quantization: string|null, adaptedFrom: string|null, createdVia: string}}
 */
function populateLineage(modelName, createdVia = 'profiler') {
  const quant = parseQuantization(modelName);
  let rootModel = modelName;

  if (quant) {
    const escapedQuant = quant.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const quantRegex = new RegExp(`[-_]?${escapedQuant}$`, 'i');
    rootModel = modelName.replace(quantRegex, '');
  }

  return {
    parentModel: modelName,
    rootModel,
    quantization: quant || null,
    adaptedFrom: isAdaptedModel(modelName) ? modelName : null,
    createdVia
  };
}

/**
 * Returns the largest numPredict value where throughput stays >= 90% of
 * baseline (first entry) throughput.
 *
 * @param {Array<{numPredict: number, tokensPerSec: number}>|null} generationStability
 * @returns {number}
 */
function _bestNumPredict(generationStability) {
  if (!generationStability || generationStability.length === 0) return 512;
  const baseline = generationStability[0]?.tokensPerSec || 0;
  if (baseline <= 0) return 512;
  const threshold = baseline * 0.9;
  let best = 64;
  for (const point of generationStability) {
    if (point.tokensPerSec >= threshold) best = point.numPredict;
  }
  return best;
}

// Conservative ceiling for baked Modelfile defaults. The probe can still record
// higher stress ceilings, but high-context probes have produced impossible
// throughput artifacts; production adaptations must opt in above this cap.
const DEFAULT_OPERATIONAL_NUM_CTX_CAP = 98304;
const DEFAULT_MAX_SANE_TOKENS_PER_SEC = 10000;

function _positiveInteger(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.round(n);
}

function _operationalNumCtxCap() {
  const raw = process.env.MODEL_CONTEXT_OPERATIONAL_CAP
    ?? process.env.AGENTX_OPERATIONAL_NUM_CTX_CAP
    ?? DEFAULT_OPERATIONAL_NUM_CTX_CAP;
  return _positiveInteger(raw);
}

function _maxSaneTokensPerSec() {
  const raw = process.env.PROFILER_MAX_SANE_TOKENS_PER_SEC
    ?? process.env.CONTEXT_PROBE_MAX_SANE_TOKENS_PER_SEC
    ?? DEFAULT_MAX_SANE_TOKENS_PER_SEC;
  return _positiveInteger(raw) || DEFAULT_MAX_SANE_TOKENS_PER_SEC;
}

function _assertSaneTokensPerSec(value, path) {
  if (value === null || value === undefined) return;
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) {
    throw new Error(`Invalid profiler throughput at ${path}: ${value}`);
  }
  const cap = _maxSaneTokensPerSec();
  if (n > cap) {
    throw new Error(`Implausible profiler throughput at ${path}: ${n} tok/s exceeds sane cap ${cap} tok/s`);
  }
}

function _validateProfileThroughput(profile) {
  _assertSaneTokensPerSec(profile?.tokensPerSec, 'profile.tokensPerSec');
  _assertSaneTokensPerSec(profile?.measurementQuality?.tokensPerSecMean, 'profile.measurementQuality.tokensPerSecMean');
  _assertSaneTokensPerSec(profile?.measurementQuality?.tokensPerSecMedian, 'profile.measurementQuality.tokensPerSecMedian');
  _assertSaneTokensPerSec(profile?.measurementQuality?.tokensPerSecMin, 'profile.measurementQuality.tokensPerSecMin');
  _assertSaneTokensPerSec(profile?.measurementQuality?.tokensPerSecMax, 'profile.measurementQuality.tokensPerSecMax');

  for (const [idx, sample] of (profile?.throughputSamples || []).entries()) {
    _assertSaneTokensPerSec(sample?.tokensPerSec, `profile.throughputSamples[${idx}].tokensPerSec`);
  }
  for (const [idx, step] of (profile?.probeSteps || []).entries()) {
    _assertSaneTokensPerSec(step?.tokPerSec ?? step?.tokensPerSec, `profile.probeSteps[${idx}].tokPerSec`);
  }
  for (const [idx, point] of (profile?.throughputCurve || []).entries()) {
    _assertSaneTokensPerSec(point?.tokensPerSec, `profile.throughputCurve[${idx}].tokensPerSec`);
  }
  for (const [idx, point] of (profile?.generationStability || []).entries()) {
    _assertSaneTokensPerSec(point?.tokensPerSec, `profile.generationStability[${idx}].tokensPerSec`);
  }
}

function _runtimeNumCtx(profile) {
  _validateProfileThroughput(profile);
  const verified = _positiveInteger(profile?.spill?.lastSafeNumCtx)
    || _positiveInteger(profile?.optimalNumCtx)
    || 8192;
  const cap = _operationalNumCtxCap();
  if (!cap) return verified;
  return Math.min(verified, cap);
}

/**
 * Generates the runtime config object for a model+host pairing.
 * Uses profiling data (spill detection, generation stability, host CPU)
 * to derive all parameters instead of hardcoded values.
 *
 * @param {object} profile    - Model profile data (optimalNumCtx, vramUsedMiB, spill, generationStability, etc.)
 * @param {object|null} hostProfile - HostProfile doc (gpu.vramTotalMiB, cpu.cores, cpu.threadOverride)
 * @returns {object} config
 */
function generateConfig(profile, hostProfile) {
  const vramTotal = hostProfile?.gpu?.vramTotalMiB || 0;
  const vramUsed = profile.vramUsedMiB || 0;
  const headroom = vramTotal > 0 ? (vramTotal - vramUsed) / vramTotal : 1;

  const numCtx = _runtimeNumCtx(profile);

  let numThread;
  if (hostProfile?.cpu?.threadOverride) {
    numThread = hostProfile.cpu.threadOverride;
  } else {
    const cpuCores = hostProfile?.cpu?.cores || 8;
    numThread = cpuCores <= 4 ? cpuCores : cpuCores - 2;
  }

  return {
    num_ctx: numCtx,
    num_gpu: 99,
    num_batch: Math.min(512, Math.max(128, Math.floor(headroom * 512))),
    num_thread: numThread,
    num_predict: _bestNumPredict(profile.generationStability),
    num_keep: 4
  };
}

/**
 * Generates a Modelfile string with rich comments and all tuned parameters.
 *
 * @param {string} modelName
 * @param {object} profile
 * @param {object|null} hostProfile
 * @returns {{ content: string, generatedAt: Date, hash: string }}
 */
function generateModelfile(modelName, profile, hostProfile) {
  const config = generateConfig(profile, hostProfile);

  const displayName = hostProfile?.displayName || hostProfile?.hostId || 'unknown host';
  const gpuModel = hostProfile?.gpu?.model || 'unknown GPU';
  const configuredVramMiB = hostProfile?.gpu?.vramTotalMiB || 0;
  const observedVramMiB = profile.vramUsedMiB || profile.hardwareTelemetry?.latest?.vramUsedMiB || 0;
  const vramGB = Math.round(Math.max(configuredVramMiB, observedVramMiB) / 1024);
  const vramLabel = observedVramMiB > configuredVramMiB * 1.2
    ? `>=${vramGB}GB observed`
    : `${vramGB}GB VRAM`;
  const profiledDate = profile.profiledAt
    ? new Date(profile.profiledAt).toISOString().slice(0, 16)
    : 'unknown';
  const depth = profile.profileDepth || 'standard';

  // Spill summary. Older profiles predate spillNumCtx, so fall back to the
  // measured GPU-resident percentage rather than printing "ctx null".
  let spillSummary;
  if (profile.spill?.spillDetected) {
    const detectedAt = profile.spill.spillNumCtx != null
      ? `at ctx ${profile.spill.spillNumCtx}`
      : (profile.spill.sizeVram && profile.spill.sizeTotal
        ? `(${Math.round((profile.spill.sizeVram / profile.spill.sizeTotal) * 100)}% GPU-resident)`
        : '(context unknown)');
    spillSummary = `Detected ${detectedAt} -- safe limit: ${profile.spill.lastSafeNumCtx}`;
  } else {
    spillSummary = `None detected (100% GPU up to ctx ${config.num_ctx})`;
  }

  const lines = [
    `FROM ${modelName}`,
    '',
    '# -- AgentX Adaptation -----------------------------------------------',
    `# Host:      ${displayName} (${gpuModel}, ${vramLabel})`,
    `# Profiled:  ${profiledDate} (${depth} depth)`,
    `# Baseline:  ${profile.tokensPerSec || '?'} tok/s @ ctx ${config.num_ctx}`,
    `# Spill:     ${spillSummary}`,
    `# Parent:    ${modelName}`,
  ];

  // Build content without the hash line first (we need to hash the final content)
  const paramLines = [
    '',
    '# -- Performance Parameters ------------------------------------------'
  ];
  for (const [key, value] of Object.entries(config)) {
    paramLines.push(`PARAMETER ${key} ${value}`);
  }

  // Assemble with a placeholder hash, then compute and replace
  const contentNoHash = [...lines, '# Hash:      <pending>', ...paramLines].join('\n');
  const hash = hashModelfile(contentNoHash);
  const content = [...lines, `# Hash:      ${hash}`, ...paramLines].join('\n');

  return {
    content,
    generatedAt: new Date(),
    hash
  };
}

/**
 * Fetches a single adaptation record from DB.
 *
 * @param {string} modelName
 * @param {string} hostId
 * @returns {Promise<object|null>}
 */
async function getAdaptation(modelName, hostId) {
  return ModelAdaptation.findOne({ modelName, hostId }).lean();
}

/**
 * Returns all adaptation records, optionally filtered, sorted by updatedAt desc.
 *
 * @param {object} [filter={}]
 * @param {string} [filter.hostId]
 * @param {string} [filter.status]   - deployment.status value
 * @returns {Promise<object[]>}
 */
async function getAdaptedRoster(filter = {}) {
  const query = {};
  if (filter.hostId) query.hostId = filter.hostId;
  if (filter.status) query['deployment.status'] = filter.status;
  return ModelAdaptation.find(query).sort({ updatedAt: -1 }).lean();
}

/**
 * Upserts an adaptation record by modelName + hostId.
 *
 * @param {object} data
 * @returns {Promise<object>}
 */
async function saveAdaptation(data) {
  return ModelAdaptation.findOneAndUpdate(
    { modelName: data.modelName, hostId: data.hostId },
    { $set: data },
    { upsert: true, new: true, runValidators: true }
  );
}

/**
 * Deploys an adapted model to an Ollama host via /api/create.
 * Updates deployment status on the adaptation record.
 *
 * @param {string} modelName
 * @param {string} hostId
 * @param {string} hostUrl
 * @returns {Promise<{success: boolean, adaptedName?: string, error?: string}>}
 */
async function deployToHost(modelName, hostId, hostUrl) {
  const adaptation = await ModelAdaptation.findOne({ modelName, hostId });
  if (!adaptation?.modelfile?.content) {
    throw new Error(`No Modelfile found for ${modelName} on ${hostId}`);
  }

  const adaptedName = adaptation.adaptedName || buildAdaptedName(modelName);

  try {
    await createModel(hostUrl, { name: adaptedName, modelfile: adaptation.modelfile.content });

    adaptation.deployment.status = 'deployed';
    adaptation.deployment.deployedAt = new Date();
    adaptation.deployment.error = null;
    adaptation.deployment.history = adaptation.deployment.history || [];
    adaptation.deployment.history.push({
      status: 'deployed',
      deployedAt: adaptation.deployment.deployedAt,
      modelfileHash: adaptation.modelfile.hash || null,
      error: null
    });
    await adaptation.save();

    logger.info(`Deployed ${adaptedName} to ${hostId}`);
    return { success: true, adaptedName };
  } catch (err) {
    adaptation.deployment.status = 'failed';
    adaptation.deployment.error = err.message;
    adaptation.deployment.history = adaptation.deployment.history || [];
    adaptation.deployment.history.push({
      status: 'failed',
      deployedAt: new Date(),
      modelfileHash: adaptation.modelfile.hash || null,
      error: err.message
    });
    await adaptation.save();

    logger.error(`Deploy failed for ${adaptedName} on ${hostId}`, { error: err.message });
    return { success: false, error: err.message };
  }
}

/**
 * Hashes Modelfile content with SHA-256 (first 16 hex chars, prefixed).
 *
 * @param {string} content
 * @returns {string}
 */
function hashModelfile(content) {
  return 'sha256:' + crypto.createHash('sha256').update(content).digest('hex').slice(0, 16);
}

module.exports = {
  _bestNumPredict,
  generateConfig,
  generateModelfile,
  getAdaptation,
  getAdaptedRoster,
  saveAdaptation,
  deployToHost,
  hashModelfile,
  validateModelfile,
  populateLineage,
  _operationalNumCtxCap,
  _maxSaneTokensPerSec,
  _validateProfileThroughput
};
