'use strict';

const nodeFetch = require('node-fetch');
const { createNodeFetchPeerTransport } = require('../../helpers/outboundHttpTransport');
const { createOutboundHttpExecutor } = require('../../../../shared/outboundHttpExecutor');
const {
  HARNESS_EXECUTION_SCHEMA,
  normalizeBenchmarkTarget,
  normalizeHarnessExecutionResponse,
} = require('../../../../shared/benchmarkTargetContract');
const { fingerprint, normalizeWorkerEnvelope } = require('../../../../shared/workerContract');

const CATALOG_TTL_MS = 15_000;
const MAX_CATALOG_BYTES = 1_000_000;
const MAX_EXECUTION_BYTES = 4_000_000;
const MAX_GRANT_BYTES = 100_000;
const MAX_EXECUTION_TIMEOUT_MS = 604_800_000;
let catalogCache = null;

const BROKER_OPERATIONS = Object.freeze({
  TARGETS: 'benchmark.harness-broker.targets',
  EXECUTE: 'benchmark.harness-broker.execute',
  SPEND_GRANTS: 'benchmark.harness-broker.spend-grants',
});

const BROKER_OPERATION_SPECS = Object.freeze({
  [BROKER_OPERATIONS.TARGETS]: Object.freeze({
    method: 'GET', path: '/v1/benchmark/targets', deadlineMs: 15_000,
    maxRequestBytes: 0, maxResponseBytes: MAX_CATALOG_BYTES,
  }),
  [BROKER_OPERATIONS.EXECUTE]: Object.freeze({
    method: 'POST', path: '/v1/benchmark/execute', deadlineMs: MAX_EXECUTION_TIMEOUT_MS,
    maxRequestBytes: MAX_EXECUTION_BYTES, maxResponseBytes: MAX_EXECUTION_BYTES,
  }),
  [BROKER_OPERATIONS.SPEND_GRANTS]: Object.freeze({
    method: 'POST', path: '/v1/benchmark/spend-grants', deadlineMs: 15_000,
    maxRequestBytes: 1_000_000, maxResponseBytes: MAX_GRANT_BYTES,
  }),
});

function brokerError(code, message, statusCode = 500) {
  const error = new Error(message);
  error.code = code;
  error.statusCode = statusCode;
  error.infra = true;
  return error;
}

function markHarnessContractFailure(error) {
  error.infra = true;
  error.failureClassification ||= [
    'HARNESS_FALLBACK_USED', 'HARNESS_IDENTITY_DRIFT', 'HARNESS_OUTPUT_FINGERPRINT_MISMATCH',
    'RECEIPT_ENVELOPE_MISMATCH', 'RECEIPT_FINGERPRINT_MISMATCH'
  ].includes(error.code) ? 'policy_violation' : 'invalid_result';
  return error;
}

function isHarnessBrokerEnabled() {
  return String(process.env.BENCHMARK_HARNESS_ENABLED || '').trim().toLowerCase() === 'true';
}

function brokerBaseUrl() {
  if (!isHarnessBrokerEnabled()) return null;
  const raw = String(process.env.AGENTX_BENCHMARK_HARNESS_URL || '').trim();
  if (!raw) throw brokerError('HARNESS_BROKER_NOT_CONFIGURED', 'BENCHMARK_HARNESS_ENABLED requires AGENTX_BENCHMARK_HARNESS_URL', 503);
  let parsed;
  try { parsed = new URL(raw); } catch {
    throw brokerError('HARNESS_BROKER_URL_INVALID', 'AGENTX_BENCHMARK_HARNESS_URL must be an HTTP(S) origin', 503);
  }
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password || (parsed.pathname && parsed.pathname !== '/') || parsed.search || parsed.hash) {
    throw brokerError('HARNESS_BROKER_URL_INVALID', 'AGENTX_BENCHMARK_HARNESS_URL must be a credential-free HTTP(S) origin', 503);
  }
  return parsed.origin;
}

function brokerHeaders(extra = {}) {
  const token = String(process.env.AGENTX_BENCHMARK_HARNESS_TOKEN || '').trim();
  if (!token) throw brokerError('HARNESS_BROKER_TOKEN_MISSING', 'Harness broker token is not configured', 503);
  return { ...extra, Authorization: `Bearer ${token}` };
}

function brokerOperation(path, method) {
  const normalizedMethod = String(method || 'GET').toUpperCase();
  const matches = Object.entries(BROKER_OPERATION_SPECS)
    .filter(([, spec]) => spec.method === normalizedMethod && spec.path === path);
  if (matches.length !== 1) {
    throw brokerError('HARNESS_BROKER_OPERATION_UNKNOWN', 'Harness broker operation is not registered', 500);
  }
  return matches[0][0];
}

const brokerExecutor = createOutboundHttpExecutor({
  operations: Object.fromEntries(Object.entries(BROKER_OPERATION_SPECS).map(([operationId, spec]) => [
    operationId,
    Object.freeze({
      authoritySource: 'configured',
      deadlineMs: spec.deadlineMs,
      maxRequestBytes: spec.maxRequestBytes,
      maxResponseBytes: spec.maxResponseBytes,
    }),
  ])),
  authorityAdapter: ({ sinkId, target }) => {
    const spec = BROKER_OPERATION_SPECS[sinkId];
    const requested = new URL(target);
    const expectedOrigin = brokerBaseUrl();
    if (!spec || !expectedOrigin || requested.origin !== expectedOrigin
      || requested.pathname !== spec.path || requested.search) {
      throw brokerError('HARNESS_BROKER_TARGET_REJECTED', 'Harness broker target is not registered', 503);
    }
    return { expectedOrigin };
  },
  fetchImpl: nodeFetch,
  transportAdapter: createNodeFetchPeerTransport(),
});

async function boundedJson(response, maxBytes) {
  const raw = await response.text();
  if (Buffer.byteLength(raw, 'utf8') > maxBytes) throw brokerError('HARNESS_BROKER_RESPONSE_TOO_LARGE', 'Harness broker response exceeded its byte limit', 502);
  try { return JSON.parse(raw); } catch {
    throw brokerError('HARNESS_BROKER_INVALID_JSON', 'Harness broker returned invalid JSON', 502);
  }
}

async function brokerRequest(path, { method = 'GET', body = null, signal = null, maxBytes = MAX_CATALOG_BYTES } = {}) {
  const base = brokerBaseUrl();
  if (!base) throw brokerError('HARNESS_BROKER_DISABLED', 'Harness broker is disabled', 503);
  const url = `${base}${path}`;
  const normalizedMethod = String(method || 'GET').toUpperCase();
  const operationId = brokerOperation(path, normalizedMethod);
  const options = {
    method: normalizedMethod,
    headers: brokerHeaders(body == null ? {} : { 'Content-Type': 'application/json' }),
    ...(body == null ? {} : { body: JSON.stringify(body) }),
    ...(signal ? { signal } : {}),
  };
  let response;
  try {
    const admission = await brokerExecutor.admitTarget(operationId, url, { signal });
    response = await brokerExecutor.request(admission, options);
  } catch (error) {
    if (signal?.aborted) throw error;
    const wrapped = brokerError(
      'HARNESS_BROKER_UNAVAILABLE',
      `Harness broker unavailable: ${error.message}${error.cause?.code ? ` (${error.cause.code})` : ''}`,
      503
    );
    wrapped.cause = error;
    throw wrapped;
  }
  const payload = await boundedJson(response, maxBytes);
  if (!response.ok) {
    const error = brokerError(payload.code || 'HARNESS_BROKER_REJECTED', payload.error || `Harness broker HTTP ${response.status}`, response.status);
    error.failureClassification = payload.failure?.classification || null;
    throw error;
  }
  return payload?.data ?? payload;
}

async function getHarnessTargets({ force = false } = {}) {
  if (!isHarnessBrokerEnabled()) return { enabled: false, targets: [], observedAt: null, expiresAt: null, broker: null };
  if (!force && catalogCache && (Date.now() - catalogCache.cachedAt) < CATALOG_TTL_MS) return catalogCache.value;
  const payload = await brokerRequest('/v1/benchmark/targets');
  const rawTargets = Array.isArray(payload?.targets) ? payload.targets : [];
  const targets = rawTargets.map((target) => normalizeBenchmarkTarget(target));
  const ids = targets.map((target) => target.id);
  if (new Set(ids).size !== ids.length) throw brokerError('HARNESS_CATALOG_DUPLICATE_TARGET', 'Harness broker returned duplicate target ids', 502);
  const observedAtMs = Date.parse(payload?.observedAt);
  const expiresAtMs = Date.parse(payload?.expiresAt);
  if (targets.some((target) => target.available)
    && (!Number.isFinite(observedAtMs) || !Number.isFinite(expiresAtMs)
      || observedAtMs > Date.now() + 300_000 || expiresAtMs <= Date.now() || expiresAtMs <= observedAtMs)) {
    throw brokerError('HARNESS_CATALOG_STALE', 'Harness broker catalog is missing a valid freshness window or has expired', 409);
  }
  const value = {
    enabled: true,
    targets,
    observedAt: payload.observedAt || new Date().toISOString(),
    expiresAt: payload.expiresAt || null,
    broker: payload.broker || null,
  };
  catalogCache = { cachedAt: Date.now(), value };
  return value;
}

async function resolveHarnessTarget(rawTarget, { force = false } = {}) {
  const requested = normalizeBenchmarkTarget(rawTarget);
  if (requested.executionKind !== 'harness') return requested;
  const catalog = await getHarnessTargets({ force });
  const current = catalog.targets.find((target) => target.id === requested.id);
  if (!current || !current.available) throw brokerError('HARNESS_TARGET_UNAVAILABLE', `Harness target ${requested.id} is not currently available`, 409);
  if (current.fingerprint !== requested.fingerprint || current.catalogFingerprint !== requested.catalogFingerprint) {
    throw brokerError('HARNESS_TARGET_DRIFT', `Harness target ${requested.id} changed since selection`, 409);
  }
  return current;
}

function normalizeHarnessInvocationParameters(parameters = {}, {
  timeoutMs = null,
  maxTokens = null,
  role = 'candidate'
} = {}) {
  const finiteOrNull = (value) => (
    value === null || value === undefined || value === ''
      ? null
      : (Number.isFinite(Number(value)) ? Number(value) : null)
  );
  const normalizedMaxTokens = Math.max(1, Math.round(Number(
    parameters.maxTokens ?? parameters.num_predict ?? maxTokens
  ) || 32_000));
  const normalizedTimeoutMs = Math.max(1, Math.round(Number(
    parameters.timeoutMs ?? timeoutMs
  ) || 600_000));
  const seedValue = finiteOrNull(parameters.seed);
  return {
    temperature: finiteOrNull(parameters.temperature),
    topP: finiteOrNull(parameters.topP),
    seed: seedValue === null ? null : Math.round(seedValue),
    maxTokens: normalizedMaxTokens,
    timeoutMs: normalizedTimeoutMs,
    responseFormat: role === 'judge' ? 'json' : 'text'
  };
}

function buildTrustJudgeCellId({ trust_candidate_id, trust_prompt_id, repeat_index }) {
  if (!/^candidate_[0-9a-f]{32}$/.test(String(trust_candidate_id || ''))
    || !/^prompt_[0-9a-f]{32}$/.test(String(trust_prompt_id || ''))
    || !Number.isSafeInteger(repeat_index)
    || repeat_index < 0) {
    throw brokerError(
      'BENCHMARK_TRUST_JUDGE_CELL_ID_INVALID',
      'strict judge execution requires an exact Trust candidate/prompt/repeat identity',
      409
    );
  }
  return `trust-judge:${trust_candidate_id}:${trust_prompt_id}:${repeat_index}`;
}

function buildHarnessEnvelope({
  batchId,
  cellId,
  target,
  promptText,
  parameters = {},
  timeoutMs,
  maxTokens,
  maxCostNanodollars = 0,
  role = 'candidate'
}) {
  const targetIdentity = normalizeBenchmarkTarget(target);
  const isNative = targetIdentity.mode === 'native_agent';
  const nativePolicy = targetIdentity.nativePolicy;
  const promptFingerprint = fingerprint(String(promptText || ''));
  const invocationParameters = normalizeHarnessInvocationParameters(parameters, {
    timeoutMs,
    maxTokens,
    role
  });
  const invocationFingerprint = fingerprint({
    schema: 'agentx.benchmark-harness-invocation/v1',
    parameters: invocationParameters
  });
  const estimatedInputTokens = Math.max(1, Math.ceil(Buffer.byteLength(String(promptText || ''), 'utf8') / 3));
  const totalTokenBudget = Math.min(1_000_000_000, estimatedInputTokens + invocationParameters.maxTokens);
  return normalizeWorkerEnvelope({
    schema: 'agentx.worker-envelope/v1',
    schemaVersion: 1,
    task: {
      id: `benchmark-${fingerprint(String(cellId || '')).slice(0, 24)}`,
      correlationId: `batch-${fingerprint(String(batchId || '')).slice(0, 24)}`,
    },
    work: { description: null, reference: `benchmark.${role}.cell` },
    workspace: { id: `ephemeral-${fingerprint(`${batchId}:${cellId}`).slice(0, 24)}`, kind: 'ephemeral' },
    dataClassification: 'internal',
    executionProfile: isNative ? 'native-ceiling' : 'portable',
    selection: {
      harness: { id: targetIdentity.harness.name, version: targetIdentity.harness.version, constraints: [] },
      model: {
        provider: targetIdentity.provider,
        id: targetIdentity.model,
        version: targetIdentity.modelVersion,
        digest: null,
        constraints: targetIdentity.mode === 'isolated_model'
          ? ['isolated-model', 'no-fallback', `inference-contract:${invocationFingerprint}`]
          : ['native-agent', `inference-contract:${invocationFingerprint}`],
      },
    },
    prompt: { reference: `benchmark.${role}.prompt`, fingerprint: promptFingerprint },
    tools: { allowed: isNative ? nativePolicy.tools : [] },
    budgets: {
      maxDurationMs: Math.max(1, Math.min(604_800_000, invocationParameters.timeoutMs)),
      maxTokens: totalTokenBudget,
      maxCostNanodollars: Math.max(0, Number(maxCostNanodollars) || 0),
      maxTurns: isNative ? nativePolicy.maxTurns : 1,
      maxToolCalls: isNative ? nativePolicy.maxToolCalls : 0,
    },
    policies: {
      filesystem: {
        mode: isNative ? nativePolicy.filesystemMode : 'none',
        workspaceOnly: true,
        allowedOperations: isNative ? nativePolicy.allowedOperations : []
      },
      network: {
        mode: 'allowlist',
        allowedDestinations: isNative
          ? [...new Set([targetIdentity.provider, ...nativePolicy.networkDestinations])]
          : [targetIdentity.provider]
      },
      output: { mode: 'result_only', maxBytes: 2_000_000, publicProjection: 'allowlist_only' },
    },
    resultContract: { format: role === 'judge' ? 'json' : 'text', schemaFingerprint: null, requiredEvidence: [] },
  });
}

async function executeHarnessTarget({ batchId, batchFingerprint, cellId, target, promptText, parameters = {}, spendGrant = null, role = 'candidate', signal = null }) {
  if (!/^[a-f0-9]{64}$/.test(String(batchFingerprint || '').toLowerCase())) {
    throw brokerError('BATCH_FINGERPRINT_REQUIRED', 'Harness execution requires the frozen batch contract fingerprint', 422);
  }
  const currentTarget = await resolveHarnessTarget(target, { force: true });
  if (role === 'judge' && (!currentTarget.capabilities.judge || currentTarget.mode !== 'isolated_model')) {
    throw brokerError('HARNESS_JUDGE_NOT_ALLOWED', 'Only isolated_model harness targets may judge', 422);
  }
  const invocationParameters = normalizeHarnessInvocationParameters(parameters, { role });
  const envelope = buildHarnessEnvelope({
    batchId,
    cellId,
    target: currentTarget,
    promptText,
    parameters: invocationParameters,
    maxCostNanodollars: spendGrant?.maxCostNanodollars || 0,
    role,
  });
  const response = await brokerRequest('/v1/benchmark/execute', {
    method: 'POST',
    body: {
      schema: HARNESS_EXECUTION_SCHEMA,
      schemaVersion: 1,
      requestId: envelope.task.id,
      batchId: String(batchId),
      batchFingerprint: String(batchFingerprint || ''),
      role,
      target: currentTarget,
      envelope,
      input: { prompt: String(promptText || '') },
      parameters: invocationParameters,
      spendGrant,
    },
    signal,
    maxBytes: MAX_EXECUTION_BYTES,
  });
  try {
    return {
      ...normalizeHarnessExecutionResponse(response, { envelope, target: currentTarget }),
      envelope
    };
  } catch (error) {
    throw markHarnessContractFailure(error);
  }
}

function estimateTargetCostNanodollars(target, { calls, inputTokensPerCall, outputTokensPerCall }) {
  const normalized = normalizeBenchmarkTarget(target, { allowMissingCatalogFingerprint: target.executionKind === 'ollama' });
  if (normalized.tier !== 'paid_cloud') return 0;
  const pricing = normalized.pricing;
  const count = BigInt(calls);
  let perCall = BigInt(pricing.callNanodollars || 0);
  perCall += (BigInt(inputTokensPerCall) * BigInt(pricing.inputNanodollarsPerMillion || 0) + 999_999n) / 1_000_000n;
  perCall += (BigInt(outputTokensPerCall) * BigInt(pricing.outputNanodollarsPerMillion || 0) + 999_999n) / 1_000_000n;
  const total = perCall * count;
  if (total > BigInt(Number.MAX_SAFE_INTEGER)) throw brokerError('SPEND_ESTIMATE_OVERFLOW', 'Paid batch estimate exceeds the safe integer range', 422);
  return Number(total);
}

function buildSpendPlan({ batchId, batchFingerprint, targets, judgeTarget = null, judgeConfig = null, promptCount, repeats, executionConfig, approval }) {
  const callsPerCandidate = Math.max(1, Number(promptCount) || 1) * Math.max(1, Number(repeats) || 1);
  const paidExecutionUnits = targets
    .filter((target) => target.tier === 'paid_cloud')
    .map((target) => ({ target, calls: callsPerCandidate }));
  if (judgeTarget?.tier === 'paid_cloud') {
    const judgeAttempts = Math.max(1, Math.min(11, Number(judgeConfig?.max_retries ?? 2) + 1));
    paidExecutionUnits.push({ target: judgeTarget, calls: callsPerCandidate * targets.length * judgeAttempts });
  }
  if (paidExecutionUnits.length === 0) return null;
  if (!/^[a-f0-9]{64}$/.test(String(batchFingerprint || '').toLowerCase())) {
    throw brokerError('BATCH_FINGERPRINT_REQUIRED', 'Paid cloud execution requires the frozen batch contract fingerprint', 422);
  }
  if (approval?.confirmed !== true) throw brokerError('PAID_APPROVAL_REQUIRED', 'Paid cloud targets require explicit approval', 422);
  const maxCalls = paidExecutionUnits.reduce((sum, unit) => sum + unit.calls, 0);
  const outputTokensPerCall = Math.max(1, Number(executionConfig?.response_max_tokens) || 32_000);
  const inputTokensPerCall = Math.max(1, Number(executionConfig?.input_token_ceiling) || 32_000);
  const maxTokens = maxCalls * (inputTokensPerCall + outputTokensPerCall);
  const maxCostNanodollars = paidExecutionUnits.reduce((sum, unit) => sum + estimateTargetCostNanodollars(unit.target, {
    calls: unit.calls,
    inputTokensPerCall,
    outputTokensPerCall,
  }), 0);
  if (Number(approval.maxCalls) < maxCalls || Number(approval.maxTokens) < maxTokens || Number(approval.maxCostNanodollars) < maxCostNanodollars) {
    throw brokerError('PAID_APPROVAL_TOO_LOW', 'Paid approval ceilings do not cover the frozen worst-case batch plan', 422);
  }
  return {
    schema: 'agentx.spend-grant-request/v1',
    schemaVersion: 1,
    batchId: String(batchId),
    batchFingerprint: String(batchFingerprint).toLowerCase(),
    units: paidExecutionUnits.map(({ target, calls }) => ({
      targetId: target.id,
      targetFingerprint: target.fingerprint,
      calls,
      inputTokensPerCall,
      outputTokensPerCall,
    })),
    approval: { confirmed: true, maxCalls, maxTokens, maxCostNanodollars },
  };
}

async function createSpendGrant(options) {
  const request = buildSpendPlan(options);
  if (!request) return null;
  const grant = await brokerRequest('/v1/benchmark/spend-grants', {
    method: 'POST', body: request, maxBytes: MAX_GRANT_BYTES,
  });
  const expected = request.approval;
  if (grant?.schema !== 'agentx.spend-grant/v1'
    || Number(grant.schemaVersion) !== 1
    || !String(grant.grantId || '').trim()
    || String(grant.batchId || '') !== request.batchId
    || String(grant.batchFingerprint || '') !== request.batchFingerprint
    || !/^[a-f0-9]{64}$/.test(String(grant.signature || '').toLowerCase())
    || !/^[a-f0-9]{64}$/.test(String(grant.planFingerprint || '').toLowerCase())
    || !Array.isArray(grant.targetFingerprints)
    || fingerprint([...grant.targetFingerprints].sort()) !== fingerprint([...new Set(request.units.map((unit) => unit.targetFingerprint))].sort())
    || Number(grant.maxCalls) !== expected.maxCalls
    || Number(grant.maxTokens) !== expected.maxTokens
    || Number(grant.maxCostNanodollars) !== expected.maxCostNanodollars
    || !Number.isFinite(Date.parse(grant.expiresAt))
    || Date.parse(grant.expiresAt) <= Date.now()) {
    throw brokerError('SPEND_GRANT_INVALID', 'Harness broker returned an invalid or over-broad SpendGrant', 502);
  }
  return grant;
}

function clearHarnessCatalogCache() {
  catalogCache = null;
}

module.exports = {
  buildHarnessEnvelope,
  buildSpendPlan,
  buildTrustJudgeCellId,
  clearHarnessCatalogCache,
  createSpendGrant,
  estimateTargetCostNanodollars,
  executeHarnessTarget,
  getHarnessTargets,
  isHarnessBrokerEnabled,
  normalizeHarnessInvocationParameters,
  resolveHarnessTarget,
};
