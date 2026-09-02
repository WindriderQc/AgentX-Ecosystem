'use strict';

const { fingerprint, normalizeWorkerEnvelope, normalizeWorkerReceipt, projectWorkerReceiptPublic } = require('./workerContract');

const BENCHMARK_TARGET_SCHEMA = 'agentx.benchmark-target/v1';
const HARNESS_EXECUTION_SCHEMA = 'agentx.harness-execution/v1';
const SCHEMA_VERSION = 1;
const EXECUTION_KINDS = Object.freeze(['ollama', 'harness']);
const EXECUTION_MODES = Object.freeze(['direct_model', 'isolated_model', 'native_agent']);
const TIERS = Object.freeze(['local', 'free_cloud', 'paid_cloud']);
const HEX_64 = /^[a-f0-9]{64}$/;

function contractError(code, message, statusCode = 400) {
  const error = new Error(message);
  error.code = code;
  error.statusCode = statusCode;
  return error;
}

function object(value, name) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw contractError('OBJECT_REQUIRED', `${name} must be an object`);
  }
  return value;
}

function text(value, name, max = 240) {
  const normalized = String(value == null ? '' : value).trim();
  if (!normalized) throw contractError('FIELD_REQUIRED', `${name} is required`);
  if (normalized.length > max) throw contractError('FIELD_TOO_LONG', `${name} must be at most ${max} characters`);
  return normalized;
}

function optionalText(value, name, max = 240) {
  if (value == null || value === '') return null;
  return text(value, name, max);
}

function identifier(value, name, max = 180, { model = false } = {}) {
  const normalized = text(value, name, max);
  const pattern = model
    ? /^[a-zA-Z0-9][a-zA-Z0-9._:@/+\-]*$/
    : /^[a-zA-Z0-9][a-zA-Z0-9._:@+\-]*$/;
  if (!pattern.test(normalized) || normalized.includes('://') || normalized.includes('\\') || normalized.includes('/../')) {
    throw contractError('INVALID_IDENTIFIER', `${name} must be a logical identifier, not an address or path`);
  }
  return normalized;
}

function optionalIdentifier(value, name, max = 180, options = {}) {
  if (value == null || value === '') return null;
  return identifier(value, name, max, options);
}

function enumValue(value, name, allowed) {
  const normalized = text(value, name, 80).toLowerCase();
  if (!allowed.includes(normalized)) {
    throw contractError('INVALID_ENUM', `${name} must be one of: ${allowed.join(', ')}`);
  }
  return normalized;
}

function safeInteger(value, name, { min = 0, max = Number.MAX_SAFE_INTEGER, nullable = false } = {}) {
  if (nullable && (value == null || value === '')) return null;
  const normalized = Number(value);
  if (!Number.isSafeInteger(normalized) || normalized < min || normalized > max) {
    throw contractError('INVALID_INTEGER', `${name} must be an integer between ${min} and ${max}`);
  }
  return normalized;
}

function fingerprintValue(value, name, nullable = false) {
  if (nullable && (value == null || value === '')) return null;
  const normalized = text(value, name, 64).toLowerCase();
  if (!HEX_64.test(normalized)) throw contractError('INVALID_FINGERPRINT', `${name} must be a SHA-256 fingerprint`);
  return normalized;
}

function normalizeVersionedIdentity(rawValue, name, { optional = false } = {}) {
  if (optional && (rawValue == null || rawValue === '')) return null;
  const raw = object(rawValue, name);
  return {
    name: identifier(raw.name, `${name}.name`, 180),
    version: identifier(raw.version, `${name}.version`, 160),
  };
}

function normalizeNativePolicy(rawValue, mode) {
  if (mode !== 'native_agent') return null;
  const raw = object(rawValue, 'target.nativePolicy');
  const tools = (Array.isArray(raw.tools) ? raw.tools : []).map((entry, index) => {
    const tool = object(entry, `target.nativePolicy.tools[${index}]`);
    return {
      name: identifier(tool.name, `target.nativePolicy.tools[${index}].name`, 160),
      version: optionalIdentifier(tool.version, `target.nativePolicy.tools[${index}].version`, 120),
      schemaFingerprint: fingerprintValue(tool.schemaFingerprint, `target.nativePolicy.tools[${index}].schemaFingerprint`),
    };
  });
  const filesystemMode = enumValue(raw.filesystemMode || 'workspace_write', 'target.nativePolicy.filesystemMode', ['none', 'read_only', 'workspace_write']);
  const allowedOperations = [...new Set((Array.isArray(raw.allowedOperations) ? raw.allowedOperations : [])
    .map((value) => enumValue(value, 'target.nativePolicy.allowedOperations[]', ['read', 'list', 'create', 'update', 'delete', 'execute'])))].sort();
  return {
    tools,
    filesystemMode,
    allowedOperations,
    networkDestinations: [...new Set((Array.isArray(raw.networkDestinations) ? raw.networkDestinations : [])
      .map((value) => identifier(value, 'target.nativePolicy.networkDestinations[]', 160)))].sort(),
    maxTurns: safeInteger(raw.maxTurns ?? 100, 'target.nativePolicy.maxTurns', { min: 1, max: 100_000 }),
    maxToolCalls: safeInteger(raw.maxToolCalls ?? 1_000, 'target.nativePolicy.maxToolCalls', { min: 0, max: 1_000_000 }),
  };
}

function normalizePricing(rawValue, tier) {
  if (rawValue == null) {
    if (tier === 'paid_cloud') throw contractError('PAID_PRICE_REQUIRED', 'paid_cloud targets require a manual price declaration');
    return tier === 'free_cloud' ? {
      kind: 'free', currency: 'USD', estimated: false, source: 'declared-free', effectiveAt: null,
      inputNanodollarsPerMillion: 0, outputNanodollarsPerMillion: 0, callNanodollars: 0,
    } : null;
  }
  const raw = object(rawValue, 'pricing');
  const kind = enumValue(raw.kind, 'pricing.kind', ['free', 'manual_per_token', 'manual_per_call']);
  const normalized = {
    kind,
    currency: enumValue(raw.currency || 'USD', 'pricing.currency', ['usd']).toUpperCase(),
    estimated: kind !== 'free',
    source: text(raw.source || (kind === 'free' ? 'declared-free' : ''), 'pricing.source', 240),
    effectiveAt: raw.effectiveAt == null ? null : isoTimestamp(raw.effectiveAt, 'pricing.effectiveAt'),
    inputNanodollarsPerMillion: safeInteger(raw.inputNanodollarsPerMillion ?? 0, 'pricing.inputNanodollarsPerMillion'),
    outputNanodollarsPerMillion: safeInteger(raw.outputNanodollarsPerMillion ?? 0, 'pricing.outputNanodollarsPerMillion'),
    callNanodollars: safeInteger(raw.callNanodollars ?? 0, 'pricing.callNanodollars'),
  };
  if (kind === 'free' && (normalized.inputNanodollarsPerMillion || normalized.outputNanodollarsPerMillion || normalized.callNanodollars)) {
    throw contractError('FREE_PRICE_CONFLICT', 'free pricing cannot carry a positive price');
  }
  if (kind === 'manual_per_token' && normalized.inputNanodollarsPerMillion === 0 && normalized.outputNanodollarsPerMillion === 0) {
    throw contractError('MANUAL_PRICE_REQUIRED', 'manual_per_token requires an input or output rate');
  }
  if (kind === 'manual_per_call' && normalized.callNanodollars === 0) {
    throw contractError('MANUAL_PRICE_REQUIRED', 'manual_per_call requires a positive call price');
  }
  if (kind !== 'free' && !normalized.effectiveAt) {
    throw contractError('MANUAL_PRICE_DATE_REQUIRED', 'manual pricing requires an effectiveAt timestamp');
  }
  if (tier === 'paid_cloud' && kind === 'free') throw contractError('PAID_PRICE_REQUIRED', 'paid_cloud target pricing cannot be free');
  if (tier === 'free_cloud' && kind !== 'free') throw contractError('FREE_PRICE_CONFLICT', 'free_cloud target pricing must be free');
  return normalized;
}

function isoTimestamp(value, name) {
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) throw contractError('INVALID_TIMESTAMP', `${name} must be an ISO-compatible timestamp`);
  return parsed.toISOString();
}

function targetUnsigned(target) {
  const unsigned = { ...target };
  delete unsigned.fingerprint;
  return unsigned;
}

function normalizeBenchmarkTarget(rawValue, options = {}) {
  const raw = object(rawValue, 'target');
  if (raw.schema != null && raw.schema !== BENCHMARK_TARGET_SCHEMA) {
    throw contractError('UNSUPPORTED_SCHEMA', `target.schema must be ${BENCHMARK_TARGET_SCHEMA}`);
  }
  if (raw.schemaVersion != null && Number(raw.schemaVersion) !== SCHEMA_VERSION) {
    throw contractError('UNSUPPORTED_SCHEMA_VERSION', `target.schemaVersion must be ${SCHEMA_VERSION}`);
  }
  const executionKind = enumValue(raw.executionKind, 'target.executionKind', EXECUTION_KINDS);
  const mode = enumValue(raw.mode, 'target.mode', EXECUTION_MODES);
  const tier = enumValue(raw.tier, 'target.tier', TIERS);
  if (executionKind === 'ollama' && (mode !== 'direct_model' || tier !== 'local')) {
    throw contractError('TARGET_KIND_CONFLICT', 'ollama targets must use direct_model and local');
  }
  if (executionKind === 'harness' && mode === 'direct_model') {
    throw contractError('TARGET_KIND_CONFLICT', 'harness targets must use isolated_model or native_agent');
  }
  // A harness may isolate either a local model or a cloud provider. Strict
  // Benchmark Trust campaigns require the Worker envelope/receipt boundary,
  // even when the actual provider is an operator-owned local Ollama host.
  const capabilitiesRaw = raw.capabilities && typeof raw.capabilities === 'object' ? raw.capabilities : {};
  const target = {
    schema: BENCHMARK_TARGET_SCHEMA,
    schemaVersion: SCHEMA_VERSION,
    id: identifier(raw.id, 'target.id', 180),
    label: text(raw.label || raw.model, 'target.label', 240),
    executionKind,
    mode,
    tier,
    provider: identifier(raw.provider, 'target.provider', 120),
    model: identifier(raw.model, 'target.model', 240, { model: true }),
    modelVersion: identifier(raw.modelVersion || 'unknown', 'target.modelVersion', 160),
    host: executionKind === 'ollama' ? text(raw.host, 'target.host', 500) : null,
    harness: normalizeVersionedIdentity(raw.harness, 'target.harness', { optional: executionKind === 'ollama' }),
    adapter: normalizeVersionedIdentity(raw.adapter, 'target.adapter', { optional: executionKind === 'ollama' }),
    profile: executionKind === 'harness' ? {
      id: identifier(raw.profile?.id, 'target.profile.id', 180),
      version: identifier(raw.profile?.version, 'target.profile.version', 160),
      fingerprint: fingerprintValue(raw.profile?.fingerprint, 'target.profile.fingerprint'),
    } : null,
    nativePolicy: normalizeNativePolicy(raw.nativePolicy, mode),
    api: normalizeVersionedIdentity(raw.api || { name: executionKind === 'ollama' ? 'ollama' : 'unknown', version: 'unknown' }, 'target.api'),
    contextWindow: safeInteger(raw.contextWindow, 'target.contextWindow', { min: 1, max: 100_000_000, nullable: true }),
    capabilities: {
      candidate: capabilitiesRaw.candidate !== false,
      judge: mode !== 'native_agent' && capabilitiesRaw.judge !== false,
      nativeAgent: mode === 'native_agent',
    },
    pricing: normalizePricing(raw.pricing, tier),
    available: raw.available !== false,
    observedAt: raw.observedAt == null ? null : isoTimestamp(raw.observedAt, 'target.observedAt'),
    catalogFingerprint: fingerprintValue(raw.catalogFingerprint, 'target.catalogFingerprint', executionKind === 'ollama' || options.allowMissingCatalogFingerprint === true),
  };
  const computed = fingerprint(targetUnsigned(target));
  if (raw.fingerprint && fingerprintValue(raw.fingerprint, 'target.fingerprint') !== computed) {
    throw contractError('TARGET_FINGERPRINT_MISMATCH', 'target fingerprint does not match normalized contents');
  }
  return { ...target, fingerprint: computed };
}

function buildOllamaTarget(host, model) {
  const normalizedHost = text(host, 'host', 500).replace(/\/$/, '');
  const normalizedModel = identifier(model, 'model', 240, { model: true });
  return normalizeBenchmarkTarget({
    id: `ollama:${fingerprint(normalizedHost).slice(0, 16)}:${fingerprint(normalizedModel).slice(0, 16)}`,
    label: normalizedModel,
    executionKind: 'ollama',
    mode: 'direct_model',
    tier: 'local',
    provider: 'ollama',
    model: normalizedModel,
    modelVersion: 'installed-tag',
    host: normalizedHost,
    api: { name: 'ollama', version: 'v1' },
    capabilities: { candidate: true, judge: true },
    available: true,
  }, { allowMissingCatalogFingerprint: true });
}

function normalizeBatchTargets({ host, models, targets } = {}) {
  const rawTargets = Array.isArray(targets) && targets.length > 0
    ? targets
    : (Array.isArray(models) ? models.map((model) => buildOllamaTarget(host, model)) : []);
  if (rawTargets.length === 0) throw contractError('TARGETS_REQUIRED', 'at least one benchmark target is required');
  const normalized = rawTargets.map((target) => target?.schema === BENCHMARK_TARGET_SCHEMA || target?.executionKind
    ? normalizeBenchmarkTarget(target, { allowMissingCatalogFingerprint: target?.executionKind === 'ollama' })
    : buildOllamaTarget(target.host || host, target.model || target));
  const ids = normalized.map((target) => target.id);
  if (new Set(ids).size !== ids.length) throw contractError('DUPLICATE_TARGET', 'benchmark target ids must be unique');
  return normalized;
}

function executionHost(target) {
  return target.executionKind === 'ollama' ? target.host : `harness:${target.harness.name}`;
}

function buildQualityCohortFingerprint({ prompts, scorerVersion, judgeTarget, executionConfig, profileContract = 'isolated-model-v1' }) {
  const promptRows = (Array.isArray(prompts) ? prompts : []).map((prompt) => ({
    id: String(prompt?._id || prompt?.id || prompt?.name || ''),
    name: String(prompt?.name || ''),
    level: Number(prompt?.level) || null,
    category: String(prompt?.category || ''),
    contentFingerprint: fingerprint({
      prompt: String(prompt?.prompt || ''),
      expectedAnswer: prompt?.expected_answer ?? prompt?.expectedAnswer ?? null,
      referenceAnswer: prompt?.reference_answer ?? prompt?.referenceAnswer ?? null,
      scoringCriteria: prompt?.scoring_criteria ?? prompt?.scoringCriteria ?? null,
      expectedFormat: prompt?.expected_format ?? prompt?.expectedFormat ?? null,
    }),
  })).sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
  const normalizedJudge = judgeTarget
    ? normalizeBenchmarkTarget(judgeTarget, { allowMissingCatalogFingerprint: judgeTarget.executionKind === 'ollama' })
    : null;
  const judgeIdentity = normalizedJudge ? {
    executionKind: normalizedJudge.executionKind,
    mode: normalizedJudge.mode,
    provider: normalizedJudge.provider,
    model: normalizedJudge.model,
    modelVersion: normalizedJudge.modelVersion,
    harness: normalizedJudge.harness,
    adapter: normalizedJudge.adapter,
    profile: normalizedJudge.profile,
    api: normalizedJudge.api,
  } : null;
  return fingerprint({
    prompts: promptRows,
    scorerVersion: String(scorerVersion || ''),
    judgeIdentity,
    generation: {
      responseMaxTokens: Number(executionConfig?.response_max_tokens) || null,
      temperature: Number.isFinite(Number(executionConfig?.temperature)) ? Number(executionConfig.temperature) : null,
      topP: Number.isFinite(Number(executionConfig?.top_p)) ? Number(executionConfig.top_p) : null,
      seed: Number.isFinite(Number(executionConfig?.seed)) ? Number(executionConfig.seed) : null,
      think: executionConfig?.think ?? null,
    },
    profileContract,
  });
}

function normalizeHarnessExecutionResponse(rawValue, { envelope, target } = {}) {
  const raw = object(rawValue, 'execution');
  if (raw.schema !== HARNESS_EXECUTION_SCHEMA || Number(raw.schemaVersion) !== SCHEMA_VERSION) {
    throw contractError('UNSUPPORTED_SCHEMA', `execution response must be ${HARNESS_EXECUTION_SCHEMA}`);
  }
  const normalizedTarget = normalizeBenchmarkTarget(target, { allowMissingCatalogFingerprint: false });
  const normalizedEnvelope = normalizeWorkerEnvelope(envelope);
  const receipt = normalizeWorkerReceipt(raw.receipt, { envelope: normalizedEnvelope });
  if (raw.fallbackUsed !== false) throw contractError('HARNESS_FALLBACK_USED', 'harness execution used or did not disprove fallback', 409);
  if (receipt.finalState !== 'succeeded') throw contractError('HARNESS_EXECUTION_FAILED', `harness execution ended as ${receipt.finalState}`, 502);
  if (receipt.identity.harness.name !== normalizedTarget.harness.name
    || receipt.identity.harness.version !== normalizedTarget.harness.version
    || receipt.identity.provider.name !== normalizedTarget.provider
    || receipt.identity.model.name !== normalizedTarget.model
    || receipt.identity.model.version !== normalizedTarget.modelVersion) {
    throw contractError('HARNESS_IDENTITY_DRIFT', 'harness receipt identity differs from the selected target', 409);
  }
  const output = String(raw.output == null ? '' : raw.output);
  if (Buffer.byteLength(output, 'utf8') > 2_000_000) throw contractError('HARNESS_OUTPUT_TOO_LARGE', 'harness output exceeded 2000000 bytes', 502);
  const outputFingerprint = fingerprint(output);
  if (receipt.result.fingerprint && receipt.result.fingerprint !== outputFingerprint) {
    throw contractError('HARNESS_OUTPUT_FINGERPRINT_MISMATCH', 'harness output does not match its receipt', 409);
  }
  return {
    schema: HARNESS_EXECUTION_SCHEMA,
    schemaVersion: SCHEMA_VERSION,
    output,
    thinking: optionalText(raw.thinking, 'execution.thinking', 2_000_000),
    finishReason: optionalIdentifier(raw.finishReason, 'execution.finishReason', 80),
    fallbackUsed: false,
    receipt,
    publicReceipt: projectWorkerReceiptPublic(receipt, { envelope: normalizedEnvelope }),
    outputFingerprint,
  };
}

module.exports = {
  BENCHMARK_TARGET_SCHEMA,
  HARNESS_EXECUTION_SCHEMA,
  SCHEMA_VERSION,
  EXECUTION_KINDS,
  EXECUTION_MODES,
  TIERS,
  buildOllamaTarget,
  buildQualityCohortFingerprint,
  contractError,
  executionHost,
  normalizeBatchTargets,
  normalizeBenchmarkTarget,
  normalizeHarnessExecutionResponse,
};
