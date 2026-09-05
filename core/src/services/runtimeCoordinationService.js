'use strict';

const crypto = require('crypto');
const RuntimeCoordination = require('../../models/RuntimeCoordination');
const { hostUrlKey } = require('../../../shared/ollamaHostConfig');

const MIN_TTL_MS = 15_000;
const MAX_TTL_MS = 30 * 60_000;
const DEFAULT_TTL_MS = 120_000;

function clean(value, max = 160) {
  const text = typeof value === 'string' ? value.trim() : '';
  return text ? text.slice(0, max) : null;
}

function ttlMs(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_TTL_MS;
  return Math.max(MIN_TTL_MS, Math.min(MAX_TTL_MS, Math.round(parsed)));
}

function secret() {
  return crypto.randomUUID();
}

function canonicalHost(value) {
  const raw = clean(value, 500);
  return raw ? hostUrlKey(raw) : null;
}

function normalizedHosts(values) {
  return [...new Set((Array.isArray(values) ? values : [])
    .map(canonicalHost)
    .filter(Boolean))].sort();
}

const RESIDENCY_OPTION_KEYS = Object.freeze([
  'num_ctx',
  'num_batch',
  'num_gpu',
  'main_gpu',
  'low_vram',
  'num_thread',
  'numa',
  'use_mmap',
  'use_mlock',
  'vocab_only',
  'adapters'
]);

function canonicalResidencyValue(value) {
  if (Array.isArray(value)) return value.map(item => canonicalResidencyValue(item));
  if (value === null) return null;
  if (typeof value === 'boolean' || typeof value === 'number' || typeof value === 'string') return value;
  return String(value);
}

function classifyKeepAlive(value, supplied) {
  if (!supplied || value === undefined) return 'default';
  const numeric = typeof value === 'number' ? value : Number(String(value).trim());
  if (Number.isFinite(numeric)) {
    if (numeric < 0) return 'persistent';
    if (numeric === 0) return 'unload';
    return 'finite';
  }
  const text = String(value || '').trim().toLowerCase();
  if (!text) return 'explicit-empty';
  if (['infinite', 'infinity', 'always'].includes(text)) return 'persistent';
  return 'finite';
}

function buildInferenceResidencySpec({ model, runtimeOptions, keepAlive, keepAliveSupplied } = {}) {
  const source = runtimeOptions && typeof runtimeOptions === 'object' && !Array.isArray(runtimeOptions)
    ? runtimeOptions
    : {};
  const runner = {};
  for (const key of RESIDENCY_OPTION_KEYS) {
    if (Object.prototype.hasOwnProperty.call(source, key)) {
      runner[key] = canonicalResidencyValue(source[key]);
    }
  }
  return {
    version: 1,
    model: clean(model, 500),
    runner,
    keepAliveClass: classifyKeepAlive(keepAlive, keepAliveSupplied)
  };
}

function buildInferenceResidencyKey(input) {
  const spec = buildInferenceResidencySpec(input);
  return `sha256:${crypto.createHash('sha256').update(JSON.stringify(spec)).digest('hex')}`;
}

function sameMaintenanceIntent(existing, { scope }) {
  return existing?.scope === scope;
}

function sameWorkloadIntent(existing, { workloadId, kind, batchId, hosts }) {
  const existingHosts = normalizedHosts(existing?.hosts);
  const requestedHosts = normalizedHosts(hosts);
  return existing?.workloadId === workloadId
    && existing?.kind === kind
    && (existing?.batchId || null) === (batchId || null)
    && JSON.stringify(existingHosts) === JSON.stringify(requestedHosts);
}

async function ensureDocument() {
  try {
    await RuntimeCoordination.updateOne(
      { _id: 'runtime' },
      { $setOnInsert: { maintenance: null, workloads: [], inferences: [], releaseReceipts: [] } },
      { upsert: true }
    );
  } catch (error) {
    // Two first-ever callers can race the singleton upsert. The unique _id is
    // the authority boundary, so the losing E11000 means the document now
    // exists and is safe to read; every other persistence failure is fatal.
    if (error?.code !== 11000) throw error;
  }
}

async function reapExpired(now = new Date()) {
  await ensureDocument();
  // Workloads are born with a durable recovery identity. Expiry therefore
  // means the owner outcome is unknown; it never proves that an external
  // database or Ollama effect stopped. Preserve the admission and force an
  // adopted recovery generation to reconcile it.
  await RuntimeCoordination.updateOne(
    {
      _id: 'runtime',
      workloads: { $elemMatch: {
        recoveryRequired: true,
        recoveryState: { $in: ['PREPARED', 'MUTATING'] },
        expiresAt: { $lte: now }
      } }
    },
    {
      $set: {
        'workloads.$[entry].recoveryState': 'UNKNOWN',
        'workloads.$[entry].recoveryReceipt': {
          contract: 'agentx.workload-recovery/v1',
          event: 'workload-heartbeat-expired'
        }
      }
    },
    { arrayFilters: [{
      'entry.recoveryRequired': true,
      'entry.recoveryState': { $in: ['PREPARED', 'MUTATING'] },
      'entry.expiresAt': { $lte: now }
    }] }
  );
  // Never infer that an Ollama request terminated merely because its Core
  // process stopped heartbeating. Preserve a non-expiring quarantine so
  // maintenance and exclusive benchmark ownership remain fail-closed.
  await RuntimeCoordination.updateOne(
    { _id: 'runtime', inferences: { $elemMatch: { state: 'ACTIVE', expiresAt: { $lte: now } } } },
    {
      $set: {
        'inferences.$[entry].state': 'UNKNOWN',
        'inferences.$[entry].unknownAt': now
      }
    },
    { arrayFilters: [{ 'entry.state': 'ACTIVE', 'entry.expiresAt': { $lte: now } }] }
  );
  // Maintenance may have dispatched mutations whose server-side lifetime
  // exceeds the caller connection. Expiry is not a terminal receipt: retain a
  // durable quarantine until an authenticated operator verifies or rolls back
  // every side effect.
  await RuntimeCoordination.updateOne(
    {
      _id: 'runtime',
      'maintenance.state': { $in: ['ACTIVE', null] },
      'maintenance.expiresAt': { $lte: now }
    },
    { $set: {
      'maintenance.state': 'UNKNOWN',
      'maintenance.unknownAt': now,
      'maintenance.unknownReason': 'maintenance heartbeat expired without a terminal receipt'
    } }
  );
}

async function acquireMaintenance({ principal, requestId, scope, ttl } = {}) {
  principal = clean(principal);
  requestId = clean(requestId);
  scope = clean(scope) || 'runtime-deploy';
  if (!principal || !requestId) return { acquired: false, reason: 'principal and requestId required' };
  await reapExpired();
  const current = await RuntimeCoordination.findById('runtime').lean();
  if (current?.maintenance?.requestId === requestId && current.maintenance.principal === principal) {
    if (!sameMaintenanceIntent(current.maintenance, { scope })) {
      return { acquired: false, reason: 'idempotency key already binds a different maintenance intent' };
    }
    if ((current.maintenance.state || 'ACTIVE') !== 'ACTIVE'
      || new Date(current.maintenance.expiresAt).getTime() <= Date.now()) {
      return { acquired: false, recoveryRequired: true, reason: 'maintenance lease requires operator reconciliation' };
    }
    return { acquired: true, ...current.maintenance, idempotent: true };
  }
  const now = new Date();
  const duration = ttlMs(ttl);
  const lease = {
    leaseId: secret(),
    generation: secret(),
    principal,
    requestId,
    scope,
    acquiredAt: now,
    heartbeatAt: now,
    expiresAt: new Date(now.getTime() + duration),
    state: 'ACTIVE',
    unknownAt: null,
    unknownReason: null
  };
  const updated = await RuntimeCoordination.findOneAndUpdate(
    {
      _id: 'runtime',
      maintenance: null,
      'workloads.0': { $exists: false },
      'inferences.0': { $exists: false }
    },
    { $set: { maintenance: lease } },
    { new: true }
  ).lean();
  if (updated) return { acquired: true, ...updated.maintenance };
  // A concurrent retry with the same idempotency key may have won the CAS
  // between our read and update. Return only that principal's Core-minted
  // proof; never translate a different owner's lease into capability.
  const raced = await RuntimeCoordination.findById('runtime').lean();
  if (raced?.maintenance?.requestId === requestId
    && raced.maintenance.principal === principal) {
    if (!sameMaintenanceIntent(raced.maintenance, { scope })) {
      return { acquired: false, reason: 'idempotency key already binds a different maintenance intent' };
    }
    if ((raced.maintenance.state || 'ACTIVE') !== 'ACTIVE'
      || new Date(raced.maintenance.expiresAt).getTime() <= Date.now()) {
      return { acquired: false, recoveryRequired: true, reason: 'maintenance lease requires operator reconciliation' };
    }
    return { acquired: true, ...raced.maintenance, idempotent: true };
  }
  return { acquired: false, reason: 'active workload, inference admission, or maintenance lease blocks maintenance' };
}

function sameInferenceIntent(existing, {
  host, model, residencyKey, kind, mode, workloadAdmissionId, workloadGeneration
}) {
  return existing?.host === host
    && existing?.model === model
    && existing?.residencyKey === residencyKey
    && existing?.kind === kind
    && (existing?.mode || 'shared') === mode
    && (existing?.workloadAdmissionId || null) === (workloadAdmissionId || null)
    && (existing?.workloadGeneration || null) === (workloadGeneration || null);
}

async function acquireInference({
  principal,
  requestId,
  host,
  model,
  kind = 'inference',
  mode = 'shared',
  workloadAdmissionId = null,
  workloadGeneration = null,
  runtimeOptions = null,
  keepAlive,
  ttl
} = {}) {
  principal = clean(principal);
  requestId = clean(requestId);
  host = canonicalHost(host);
  model = clean(model, 500);
  kind = clean(kind) || 'inference';
  mode = mode === 'exclusive' ? 'exclusive' : 'shared';
  workloadAdmissionId = clean(workloadAdmissionId);
  workloadGeneration = clean(workloadGeneration);
  if (!principal || !requestId || !host || !model) {
    return { acquired: false, reason: 'principal, requestId, host, and model are required' };
  }
  if (Boolean(workloadAdmissionId) !== Boolean(workloadGeneration)) {
    return { acquired: false, reason: 'workload admission id and generation must be supplied together' };
  }
  const keepAliveSupplied = keepAlive !== undefined;
  const residencySpec = buildInferenceResidencySpec({ model, runtimeOptions, keepAlive, keepAliveSupplied });
  const residencyKey = buildInferenceResidencyKey({ model, runtimeOptions, keepAlive, keepAliveSupplied });
  await reapExpired();
  const current = await RuntimeCoordination.findById('runtime').lean();
  const existing = (current?.inferences || []).find(item =>
    item.requestId === requestId && item.principal === principal);
  if (existing) {
    if (!sameInferenceIntent(existing, {
      host, model, residencyKey, kind, mode, workloadAdmissionId, workloadGeneration
    })) {
      return { acquired: false, reason: 'idempotency key already binds a different inference intent' };
    }
    if (existing.state !== 'ACTIVE' || new Date(existing.expiresAt).getTime() <= Date.now()) {
      return { acquired: false, recoveryRequired: true, reason: 'inference requires operator runtime recovery' };
    }
    return { acquired: true, ...existing, idempotent: true };
  }

  const now = new Date();
  const duration = ttlMs(ttl);
  const admission = {
    admissionId: secret(),
    generation: secret(),
    principal,
    requestId,
    host,
    model,
    residencyKey,
    residencySpec,
    kind,
    mode,
    workloadAdmissionId,
    workloadGeneration,
    acquiredAt: now,
    heartbeatAt: now,
    expiresAt: new Date(now.getTime() + duration),
    state: 'ACTIVE',
    unknownAt: null
  };

  const incompatibleInference = {
    host,
    $or: [
      { state: 'UNKNOWN' },
      { mode: 'exclusive' },
      ...(mode === 'exclusive' ? [{}] : [{ residencyKey: { $ne: residencyKey } }])
    ]
  };
  const ordinaryFilter = {
    _id: 'runtime',
    maintenance: null,
    inferences: { $not: { $elemMatch: {
      $or: [
        { requestId, principal },
        incompatibleInference
      ]
    } } },
    workloads: { $not: { $elemMatch: { hosts: host } } }
  };
  const workloadFilter = {
    _id: 'runtime',
    maintenance: null,
    inferences: { $not: { $elemMatch: {
      $or: [
        { requestId, principal },
        incompatibleInference
      ]
    } } },
    workloads: { $elemMatch: {
      admissionId: workloadAdmissionId,
      generation: workloadGeneration,
      principal,
      hosts: host,
      expiresAt: { $gt: now }
    } }
  };
  const updated = await RuntimeCoordination.findOneAndUpdate(
    workloadAdmissionId ? workloadFilter : ordinaryFilter,
    { $push: { inferences: admission } },
    { new: true }
  ).lean();
  if (updated) return { acquired: true, ...admission };
  return {
    acquired: false,
    reason: workloadAdmissionId
      ? 'exact workload proof is absent/expired, or a conflicting inference residency blocks this host'
      : 'maintenance, workload, UNKNOWN inference, or incompatible residency blocks inference on this host'
  };
}

async function heartbeatInference({ id, generation, principal, ttl } = {}) {
  id = clean(id);
  generation = clean(generation);
  principal = clean(principal);
  if (!id || !generation || !principal) return { heartbeat: false, reason: 'exact inference proof required' };
  const now = new Date();
  const expiresAt = new Date(now.getTime() + ttlMs(ttl));
  const updated = await RuntimeCoordination.findOneAndUpdate(
    {
      _id: 'runtime',
      inferences: { $elemMatch: {
        admissionId: id,
        generation,
        principal,
        state: 'ACTIVE',
        expiresAt: { $gt: now }
      } }
    },
    { $set: { 'inferences.$.heartbeatAt': now, 'inferences.$.expiresAt': expiresAt } },
    { new: true }
  ).lean();
  if (!updated) return { heartbeat: false, reason: 'inference proof no longer owns active coordination state' };
  const owned = updated.inferences.find(item => item.admissionId === id && item.generation === generation);
  return { heartbeat: true, ...owned };
}

async function releaseInference({ id, generation, principal } = {}) {
  id = clean(id);
  generation = clean(generation);
  principal = clean(principal);
  if (!id || !generation || !principal) return { released: false, reason: 'exact inference proof required' };
  const now = new Date();
  await reapExpired(now);
  const current = await RuntimeCoordination.findById('runtime').select('+releaseReceipts').lean();
  const priorReceipt = [...(current?.releaseReceipts || [])].reverse().find(item => (
    item?.coordinationKind === 'inference'
    && item?.admissionId === id
    && item?.generation === generation
    && item?.principal === principal
  ));
  if (priorReceipt) return { ...priorReceipt, idempotent: true };
  const owned = (current?.inferences || []).find(item => (
    item?.admissionId === id
    && item?.generation === generation
    && item?.principal === principal
    && item?.state === 'ACTIVE'
  ));
  const releasedAt = new Date();
  const releaseReceipt = {
    contract: 'agentx.runtime-inference-completion/v1',
    coordinationKind: 'inference',
    released: true,
    admissionId: id,
    generation,
    principal,
    requestId: owned?.requestId || null,
    host: owned?.host || null,
    model: owned?.model || null,
    kind: owned?.kind || null,
    mode: owned?.mode || 'shared',
    residencyKey: owned?.residencyKey || null,
    residencySpec: owned?.residencySpec || null,
    acquiredAt: owned?.acquiredAt || null,
    heartbeatAt: owned?.heartbeatAt || null,
    releasedAt
  };
  const released = await RuntimeCoordination.findOneAndUpdate(
    {
      _id: 'runtime',
      inferences: { $elemMatch: {
        admissionId: id, generation, principal, state: 'ACTIVE', expiresAt: { $gt: releasedAt }
      } }
    },
    {
      $pull: { inferences: { admissionId: id, generation, principal, state: 'ACTIVE' } },
      $push: { releaseReceipts: { $each: [releaseReceipt], $slice: -100 } }
    },
    { new: false }
  ).lean();
  return released
    ? releaseReceipt
    : { released: false, reason: 'inference proof is absent or quarantined' };
}

async function markInferenceUnknown({ id, generation, principal, reason = null } = {}) {
  id = clean(id);
  generation = clean(generation);
  principal = clean(principal);
  if (!id || !generation || !principal) return { quarantined: false, reason: 'exact inference proof required' };
  const now = new Date();
  const updated = await RuntimeCoordination.findOneAndUpdate(
    {
      _id: 'runtime',
      inferences: { $elemMatch: { admissionId: id, generation, principal, state: 'ACTIVE' } }
    },
    { $set: {
      'inferences.$.state': 'UNKNOWN',
      'inferences.$.unknownAt': now,
      'inferences.$.unknownReason': clean(reason, 500)
    } },
    { new: true }
  ).lean();
  const owned = updated?.inferences?.find(item => item.admissionId === id && item.generation === generation);
  if (owned) {
    return {
      contract: 'agentx.runtime-inference-quarantine/v1',
      quarantined: true,
      admissionId: id,
      generation,
      principal,
      requestId: owned.requestId || null,
      host: owned.host,
      model: owned.model,
      kind: owned.kind,
      mode: owned.mode || 'shared',
      residencyKey: owned.residencyKey,
      residencySpec: owned.residencySpec,
      acquiredAt: owned.acquiredAt,
      heartbeatAt: owned.heartbeatAt,
      expiresAt: owned.expiresAt,
      unknownAt: owned.unknownAt,
      reason: owned.unknownReason || null
    };
  }
  const existing = await RuntimeCoordination.findOne({
    _id: 'runtime',
    inferences: { $elemMatch: { admissionId: id, generation, principal, state: 'UNKNOWN' } }
  }).lean();
  const quarantined = existing?.inferences?.find(item => item.admissionId === id && item.generation === generation);
  return quarantined
    ? {
      contract: 'agentx.runtime-inference-quarantine/v1',
      quarantined: true,
      admissionId: id,
      generation,
      principal,
      requestId: quarantined.requestId || null,
      host: quarantined.host,
      model: quarantined.model,
      kind: quarantined.kind,
      mode: quarantined.mode || 'shared',
      residencyKey: quarantined.residencyKey,
      residencySpec: quarantined.residencySpec,
      acquiredAt: quarantined.acquiredAt,
      heartbeatAt: quarantined.heartbeatAt,
      expiresAt: quarantined.expiresAt,
      unknownAt: quarantined.unknownAt,
      reason: quarantined.unknownReason || null,
      idempotent: true
    }
    : { quarantined: false, reason: 'inference proof no longer owns active coordination state' };
}

async function recoverInferenceAfterRuntimeRestart({ id, generation, principal, receipt } = {}) {
  id = clean(id);
  generation = clean(generation);
  principal = clean(principal);
  const restartedAt = new Date(receipt?.restartedAt || '');
  const exactReceipt = receipt?.contract === 'agentx.ollama-runtime-restart/v1'
    && receipt?.runtimeRestarted === true
    && receipt?.confirmation === 'OLLAMA_RUNTIME_RESTARTED_AND_PRIOR_REQUESTS_TERMINATED'
    && typeof receipt?.restartedAt === 'string'
    && Number.isFinite(restartedAt.getTime())
    && restartedAt.getTime() <= Date.now() + 5 * 60_000;
  if (!id || !generation || !exactReceipt) {
    return { recovered: false, reason: 'exact inference proof and runtime restart receipt required' };
  }
  const exactInference = {
    admissionId: id,
    generation,
    state: 'UNKNOWN',
    unknownAt: { $lte: restartedAt },
    ...(principal && { principal })
  };
  const recovered = await RuntimeCoordination.findOneAndUpdate(
    {
      _id: 'runtime',
      inferences: { $elemMatch: exactInference }
    },
    { $pull: { inferences: { admissionId: id, generation, state: 'UNKNOWN', ...(principal && { principal }) } } },
    { new: false }
  ).lean();
  const inference = recovered?.inferences?.find((entry) => entry.admissionId === id
    && entry.generation === generation
    && entry.state === 'UNKNOWN'
    && (!principal || entry.principal === principal));
  return inference
    ? { recovered: true, admissionId: id, generation, principal: inference.principal, receipt }
    : { recovered: false, reason: 'matching quarantined inference was not found' };
}

async function markMaintenanceUnknown({ id, generation, principal, reason = null } = {}) {
  id = clean(id);
  generation = clean(generation);
  principal = clean(principal);
  const boundedReason = clean(reason, 500) || 'maintenance terminal state is unknown';
  if (!id || !generation || !principal) {
    return { quarantined: false, reason: 'exact maintenance proof required' };
  }
  const now = new Date();
  const updated = await RuntimeCoordination.findOneAndUpdate(
    {
      _id: 'runtime',
      'maintenance.leaseId': id,
      'maintenance.generation': generation,
      'maintenance.principal': principal,
      'maintenance.state': { $in: ['ACTIVE', null] }
    },
    { $set: {
      'maintenance.state': 'UNKNOWN',
      'maintenance.unknownAt': now,
      'maintenance.unknownReason': boundedReason
    } },
    { new: true }
  ).lean();
  const owned = updated?.maintenance;
  if (owned?.leaseId === id && owned?.generation === generation && owned?.principal === principal) {
    return {
      contract: 'agentx.maintenance-quarantine/v1',
      coordinationKind: 'maintenance',
      quarantined: true,
      leaseId: owned.leaseId,
      generation: owned.generation,
      principal: owned.principal,
      requestId: owned.requestId,
      scope: owned.scope,
      state: 'UNKNOWN',
      unknownAt: owned.unknownAt,
      reason: owned.unknownReason
    };
  }
  const existing = await RuntimeCoordination.findById('runtime').lean();
  const quarantined = existing?.maintenance;
  return quarantined?.leaseId === id
    && quarantined?.generation === generation
    && quarantined?.principal === principal
    && quarantined?.state === 'UNKNOWN'
    ? {
      contract: 'agentx.maintenance-quarantine/v1',
      coordinationKind: 'maintenance',
      quarantined: true,
      leaseId: quarantined.leaseId,
      generation: quarantined.generation,
      principal: quarantined.principal,
      requestId: quarantined.requestId,
      scope: quarantined.scope,
      state: 'UNKNOWN',
      unknownAt: quarantined.unknownAt,
      reason: quarantined.unknownReason,
      idempotent: true
    }
    : { quarantined: false, reason: 'maintenance proof no longer owns active coordination state' };
}

async function recoverMaintenanceAfterOperatorReconciliation({ id, generation, principal, receipt } = {}) {
  id = clean(id);
  generation = clean(generation);
  principal = clean(principal);
  const exactReceipt = receipt?.contract === 'agentx.maintenance-recovery/v1'
    && receipt?.maintenanceReconciled === true
    && receipt?.confirmation === 'MAINTENANCE_SIDE_EFFECTS_VERIFIED_OR_ROLLED_BACK'
    && typeof receipt?.reconciledAt === 'string'
    && Number.isFinite(Date.parse(receipt.reconciledAt));
  if (!id || !generation || !principal || !exactReceipt) {
    return { recovered: false, reason: 'exact maintenance proof and operator reconciliation receipt required' };
  }
  const recoveredAt = new Date();
  const recoveryReceipt = {
    coordinationKind: 'maintenance-recovery',
    recovered: true,
    released: true,
    leaseId: id,
    generation,
    principal,
    receipt,
    recoveredAt
  };
  const recovered = await RuntimeCoordination.findOneAndUpdate(
    {
      _id: 'runtime',
      'maintenance.leaseId': id,
      'maintenance.generation': generation,
      'maintenance.principal': principal,
      'maintenance.state': 'UNKNOWN'
    },
    {
      $set: { maintenance: null },
      $push: { releaseReceipts: { $each: [recoveryReceipt], $slice: -100 } }
    },
    { new: false }
  ).lean();
  return recovered
    ? recoveryReceipt
    : { recovered: false, reason: 'matching quarantined maintenance lease was not found' };
}

async function hostHasActiveInferences(host) {
  host = canonicalHost(host);
  if (!host) return false;
  await reapExpired();
  return Boolean(await RuntimeCoordination.exists({
    _id: 'runtime',
    inferences: { $elemMatch: { host } }
  }));
}

async function acquireWorkload({ principal, requestId, workloadId, kind, batchId, hosts, recoveryRequestId, ttl } = {}) {
  principal = clean(principal);
  requestId = clean(requestId);
  workloadId = clean(workloadId);
  kind = clean(kind) || 'benchmark';
  batchId = clean(batchId);
  recoveryRequestId = clean(recoveryRequestId) || (requestId ? `recovery:${requestId}` : null);
  hosts = normalizedHosts(hosts);
  if (!principal || !requestId || !workloadId) {
    return { acquired: false, reason: 'principal, requestId, and workloadId required' };
  }
  await reapExpired();
  const current = await RuntimeCoordination.findById('runtime').lean();
  const existing = (current?.workloads || []).find(item =>
    item.requestId === requestId && item.principal === principal);
  if (existing) {
    if (!sameWorkloadIntent(existing, { workloadId, kind, batchId, hosts })) {
      return { acquired: false, reason: 'idempotency key already binds a different workload intent' };
    }
    if (existing.recoveryRequired === true
      && new Date(existing.expiresAt).getTime() <= Date.now()) {
      return { acquired: false, recoveryRequired: true, reason: 'expired workload requires fenced recovery adoption' };
    }
    return { acquired: true, ...existing, idempotent: true };
  }
  const now = new Date();
  const duration = ttlMs(ttl);
  const recoveryId = secret();
  const recoveryGeneration = secret();
  const admission = {
    admissionId: secret(),
    generation: secret(),
    principal,
    requestId,
    workloadId,
    kind,
    batchId,
    hosts,
    acquiredAt: now,
    heartbeatAt: now,
    expiresAt: new Date(now.getTime() + duration),
    recoveryRequired: true,
    recoveryId,
    recoveryGeneration,
    recoveryRequestId,
    recoveryOwnerId: null,
    recoveryArmedAt: now,
    recoveryAdoptedAt: null,
    recoveryHeartbeatAt: null,
    recoveryExpiresAt: null,
    recoveryState: 'PREPARED',
    recoveryVersion: 0,
    recoveryReceipt: null
  };
  const updated = await RuntimeCoordination.findOneAndUpdate(
    {
      _id: 'runtime',
      maintenance: null,
      // Workload admission is exclusive for every requested host. This veto
      // lives in the same CAS as the workload insert so inference/workload
      // acquisition is linearizable in both directions. UNKNOWN inference
      // entries deliberately continue to block.
      ...(hosts.length > 0
        ? { inferences: { $not: { $elemMatch: { host: { $in: hosts } } } } }
        : { 'inferences.0': { $exists: false } }),
      workloads: { $not: { $elemMatch: {
        $or: [
          { requestId, principal },
          ...(hosts.length > 0 ? [{ hosts: { $in: hosts } }] : [])
        ]
      } } }
    },
    { $push: { workloads: admission } },
    { new: true }
  ).lean();
  if (updated) return { acquired: true, ...admission };
  const raced = await RuntimeCoordination.findById('runtime').lean();
  const racedAdmission = (raced?.workloads || []).find(item =>
    item.requestId === requestId && item.principal === principal);
  if (racedAdmission) {
    if (!sameWorkloadIntent(racedAdmission, { workloadId, kind, batchId, hosts })) {
      return { acquired: false, reason: 'idempotency key already binds a different workload intent' };
    }
    if (racedAdmission.recoveryRequired === true
      && new Date(racedAdmission.expiresAt).getTime() <= Date.now()) {
      return { acquired: false, recoveryRequired: true, reason: 'expired workload requires fenced recovery adoption' };
    }
    return { acquired: true, ...racedAdmission, idempotent: true };
  }
  return {
    acquired: false,
    reason: 'active maintenance lease, inference admission, or conflicting workload blocks workload admission'
  };
}

async function heartbeat(kind, { id, generation, principal, ttl } = {}) {
  id = clean(id);
  generation = clean(generation);
  principal = clean(principal);
  if (!id || !generation || !principal) return { heartbeat: false, reason: 'exact lease proof required' };
  const now = new Date();
  const expiresAt = new Date(now.getTime() + ttlMs(ttl));
  const isMaintenance = kind === 'maintenance';
  const filter = isMaintenance
    ? {
      _id: 'runtime',
      'maintenance.leaseId': id,
      'maintenance.generation': generation,
      'maintenance.principal': principal,
      'maintenance.state': { $in: ['ACTIVE', null] },
      'maintenance.expiresAt': { $gt: now }
    }
    : { _id: 'runtime', workloads: { $elemMatch: { admissionId: id, generation, principal, expiresAt: { $gt: now } } } };
  const set = isMaintenance
    ? { 'maintenance.heartbeatAt': now, 'maintenance.expiresAt': expiresAt }
    : { 'workloads.$.heartbeatAt': now, 'workloads.$.expiresAt': expiresAt };
  const updated = await RuntimeCoordination.findOneAndUpdate(filter, { $set: set }, { new: true }).lean();
  if (!updated) return { heartbeat: false, reason: 'lease proof no longer owns coordination state' };
  const owned = isMaintenance
    ? updated.maintenance
    : updated.workloads.find(item => item.admissionId === id && item.generation === generation);
  return isMaintenance ? {
    heartbeat: true,
    leaseId: owned.leaseId,
    generation: owned.generation,
    principal: owned.principal,
    requestId: owned.requestId,
    scope: owned.scope,
    heartbeatAt: owned.heartbeatAt,
    expiresAt: owned.expiresAt
  } : {
    heartbeat: true,
    admissionId: owned.admissionId,
    generation: owned.generation,
    principal: owned.principal,
    requestId: owned.requestId,
    workloadId: owned.workloadId,
    kind: owned.kind,
    batchId: owned.batchId,
    hosts: normalizedHosts(owned.hosts),
    recoveryRequired: owned.recoveryRequired === true,
    recoveryId: owned.recoveryId || null,
    recoveryGeneration: owned.recoveryGeneration || null,
    recoveryState: owned.recoveryState || null,
    recoveryVersion: Number.isInteger(owned.recoveryVersion) ? owned.recoveryVersion : null,
    heartbeatAt: owned.heartbeatAt,
    expiresAt: owned.expiresAt
  };
}

async function armWorkloadRecovery({ id, generation, principal, recoveryRequestId } = {}) {
  id = clean(id);
  generation = clean(generation);
  principal = clean(principal);
  recoveryRequestId = clean(recoveryRequestId);
  if (!id || !generation || !principal || !recoveryRequestId) {
    return { armed: false, reason: 'exact workload proof and recoveryRequestId required' };
  }
  await ensureDocument();
  const current = await RuntimeCoordination.findById('runtime').lean();
  const existing = (current?.workloads || []).find(item => item.admissionId === id && item.generation === generation);
  if (existing?.principal === principal && existing.recoveryRequired === true) {
    if (existing.recoveryRequestId !== recoveryRequestId) {
      return { armed: false, reason: 'workload already binds a different recovery intent' };
    }
    return {
      armed: true,
      admissionId: existing.admissionId,
      generation: existing.generation,
      principal: existing.principal,
      requestId: existing.requestId,
      workloadId: existing.workloadId,
      kind: existing.kind,
      batchId: existing.batchId,
      hosts: normalizedHosts(existing.hosts),
      recoveryRequired: true,
      recoveryId: existing.recoveryId,
      recoveryGeneration: existing.recoveryGeneration,
      recoveryRequestId: existing.recoveryRequestId,
      recoveryArmedAt: existing.recoveryArmedAt,
      recoveryState: existing.recoveryState,
      recoveryVersion: existing.recoveryVersion,
      idempotent: true
    };
  }
  const now = new Date();
  const recoveryId = secret();
  const recoveryGeneration = secret();
  const updated = await RuntimeCoordination.findOneAndUpdate(
    {
      _id: 'runtime',
      workloads: { $elemMatch: {
        admissionId: id,
        generation,
        principal,
        expiresAt: { $gt: now },
        recoveryRequired: { $ne: true }
      } }
    },
    {
      $set: {
        'workloads.$.recoveryRequired': true,
        'workloads.$.recoveryId': recoveryId,
        'workloads.$.recoveryGeneration': recoveryGeneration,
        'workloads.$.recoveryRequestId': recoveryRequestId,
        'workloads.$.recoveryOwnerId': null,
        'workloads.$.recoveryArmedAt': now,
        'workloads.$.recoveryAdoptedAt': null,
        'workloads.$.recoveryState': 'PREPARED',
        'workloads.$.recoveryVersion': 0,
        'workloads.$.recoveryReceipt': null
      }
    },
    { new: true }
  ).lean();
  if (!updated) return { armed: false, reason: 'workload proof no longer owns coordination state' };
  const owned = updated.workloads.find(item => item.admissionId === id && item.generation === generation);
  return {
    armed: true,
    admissionId: owned.admissionId,
    generation: owned.generation,
    principal: owned.principal,
    requestId: owned.requestId,
    workloadId: owned.workloadId,
    kind: owned.kind,
    batchId: owned.batchId,
    hosts: normalizedHosts(owned.hosts),
    recoveryRequired: true,
    recoveryId: owned.recoveryId,
    recoveryGeneration: owned.recoveryGeneration,
    recoveryRequestId: owned.recoveryRequestId,
    recoveryArmedAt: owned.recoveryArmedAt,
    recoveryState: owned.recoveryState,
    recoveryVersion: owned.recoveryVersion
  };
}

async function adoptWorkloadRecovery({ recoveryId, principal, recoveryRequestId, ownerId, ttl } = {}) {
  recoveryId = clean(recoveryId);
  principal = clean(principal);
  recoveryRequestId = clean(recoveryRequestId);
  ownerId = clean(ownerId);
  if (!recoveryId || !principal || !recoveryRequestId || !ownerId) {
    return { adopted: false, reason: 'exact recovery identity and ownerId required' };
  }
  await ensureDocument();
  const current = await RuntimeCoordination.findById('runtime').lean();
  const existing = (current?.workloads || []).find(item => item.recoveryId === recoveryId);
  if (!existing || existing.principal !== principal || existing.recoveryRequestId !== recoveryRequestId) {
    return { adopted: false, reason: 'recovery identity no longer owns coordination state' };
  }
  const adoptedAt = new Date();
  const ownerExpiresAt = existing.recoveryExpiresAt
    ? new Date(existing.recoveryExpiresAt)
    : null;
  if (existing.recoveryOwnerId === ownerId
    && ownerExpiresAt
    && ownerExpiresAt.getTime() > adoptedAt.getTime()) {
    return {
      adopted: true,
      admissionId: existing.admissionId,
      generation: existing.generation,
      principal: existing.principal,
      requestId: existing.requestId,
      workloadId: existing.workloadId,
      kind: existing.kind,
      batchId: existing.batchId,
      hosts: normalizedHosts(existing.hosts),
      recoveryRequired: true,
      recoveryId: existing.recoveryId,
      recoveryGeneration: existing.recoveryGeneration,
      recoveryRequestId: existing.recoveryRequestId,
      recoveryOwnerId: existing.recoveryOwnerId,
      recoveryHeartbeatAt: existing.recoveryHeartbeatAt,
      recoveryExpiresAt: existing.recoveryExpiresAt,
      recoveryState: existing.recoveryState,
      recoveryVersion: existing.recoveryVersion,
      idempotent: true
    };
  }
  if (new Date(existing.expiresAt).getTime() > adoptedAt.getTime()) {
    return { adopted: false, retryable: true, reason: 'original workload owner remains live' };
  }
  if (existing.recoveryOwnerId
    && ownerExpiresAt
    && ownerExpiresAt.getTime() > adoptedAt.getTime()) {
    return { adopted: false, retryable: true, reason: 'recovery owner lease remains live' };
  }
  const nextGeneration = secret();
  const recoveryExpiresAt = new Date(adoptedAt.getTime() + ttlMs(ttl));
  const updated = await RuntimeCoordination.findOneAndUpdate(
    {
      _id: 'runtime',
      workloads: { $elemMatch: {
        admissionId: existing.admissionId,
        generation: existing.generation,
        principal,
        recoveryRequired: true,
        recoveryId,
        recoveryGeneration: existing.recoveryGeneration,
        recoveryRequestId,
        expiresAt: { $lte: adoptedAt },
        $or: [
          { recoveryOwnerId: null },
          { recoveryOwnerId: { $exists: false } },
          { recoveryExpiresAt: null },
          { recoveryExpiresAt: { $exists: false } },
          { recoveryExpiresAt: { $lte: adoptedAt } }
        ]
      } }
    },
    {
      $set: {
        'workloads.$.recoveryGeneration': nextGeneration,
        'workloads.$.recoveryOwnerId': ownerId,
        'workloads.$.recoveryAdoptedAt': adoptedAt,
        'workloads.$.recoveryHeartbeatAt': adoptedAt,
        'workloads.$.recoveryExpiresAt': recoveryExpiresAt
      }
    },
    { new: true }
  ).lean();
  if (!updated) return { adopted: false, retryable: true, reason: 'recovery ownership changed concurrently' };
  const owned = updated.workloads.find(item => item.recoveryId === recoveryId);
  return {
    adopted: true,
    admissionId: owned.admissionId,
    generation: owned.generation,
    principal: owned.principal,
    requestId: owned.requestId,
    workloadId: owned.workloadId,
    kind: owned.kind,
    batchId: owned.batchId,
    hosts: normalizedHosts(owned.hosts),
    recoveryRequired: true,
    recoveryId: owned.recoveryId,
    recoveryGeneration: owned.recoveryGeneration,
    recoveryRequestId: owned.recoveryRequestId,
    recoveryOwnerId: owned.recoveryOwnerId,
    recoveryAdoptedAt: owned.recoveryAdoptedAt,
    recoveryHeartbeatAt: owned.recoveryHeartbeatAt,
    recoveryExpiresAt: owned.recoveryExpiresAt,
    recoveryState: owned.recoveryState,
    recoveryVersion: owned.recoveryVersion
  };
}

async function heartbeatWorkloadRecovery({ recoveryId, recoveryGeneration, principal, ownerId, ttl } = {}) {
  recoveryId = clean(recoveryId);
  recoveryGeneration = clean(recoveryGeneration);
  principal = clean(principal);
  ownerId = clean(ownerId);
  if (!recoveryId || !recoveryGeneration || !principal || !ownerId) {
    return { heartbeat: false, reason: 'exact recovery proof and ownerId required' };
  }
  const now = new Date();
  const recoveryExpiresAt = new Date(now.getTime() + ttlMs(ttl));
  const updated = await RuntimeCoordination.findOneAndUpdate(
    {
      _id: 'runtime',
      workloads: { $elemMatch: {
        recoveryRequired: true,
        recoveryId,
        recoveryGeneration,
        principal,
        recoveryOwnerId: ownerId,
        recoveryExpiresAt: { $gt: now }
      } }
    },
    {
      $set: {
        'workloads.$.recoveryHeartbeatAt': now,
        'workloads.$.recoveryExpiresAt': recoveryExpiresAt
      }
    },
    { new: true }
  ).lean();
  if (!updated) return { heartbeat: false, reason: 'recovery owner lease no longer owns quarantine' };
  const owned = updated.workloads.find(item => item.recoveryId === recoveryId);
  return {
    heartbeat: true,
    recoveryId: owned.recoveryId,
    recoveryGeneration: owned.recoveryGeneration,
    recoveryOwnerId: owned.recoveryOwnerId,
    recoveryHeartbeatAt: owned.recoveryHeartbeatAt,
    recoveryExpiresAt: owned.recoveryExpiresAt,
    recoveryState: owned.recoveryState,
    recoveryVersion: owned.recoveryVersion
  };
}

const RECOVERY_TRANSITIONS = Object.freeze({
  PREPARED: new Set(['MUTATING', 'UNKNOWN']),
  MUTATING: new Set(['UNKNOWN', 'VERIFIED']),
  UNKNOWN: new Set(['VERIFIED']),
  VERIFIED: new Set(['RESTORED']),
  RESTORED: new Set()
});

async function transitionWorkloadRecovery({
  recoveryId,
  recoveryGeneration,
  principal,
  ownerId = null,
  expectedVersion,
  state,
  receipt = null
} = {}) {
  recoveryId = clean(recoveryId);
  recoveryGeneration = clean(recoveryGeneration);
  principal = clean(principal);
  ownerId = clean(ownerId);
  state = clean(state, 32)?.toUpperCase() || null;
  const version = Number(expectedVersion);
  if (!recoveryId || !recoveryGeneration || !principal || !Number.isInteger(version) || version < 0 || !state) {
    return { transitioned: false, reason: 'exact recovery proof, expectedVersion, and state required' };
  }
  const current = await RuntimeCoordination.findById('runtime').lean();
  const existing = (current?.workloads || []).find(item => item.recoveryId === recoveryId);
  const now = new Date();
  const ownerLeaseLive = existing?.recoveryOwnerId
    ? ownerId === existing.recoveryOwnerId
      && existing.recoveryExpiresAt
      && new Date(existing.recoveryExpiresAt).getTime() > now.getTime()
    : existing?.expiresAt && new Date(existing.expiresAt).getTime() > now.getTime();
  if (!existing
    || existing.recoveryGeneration !== recoveryGeneration
    || existing.principal !== principal
    || !ownerLeaseLive) {
    return { transitioned: false, reason: 'recovery proof no longer owns quarantine' };
  }
  if (existing.recoveryState === state && Number(existing.recoveryVersion) === version + 1) {
    return {
      transitioned: true,
      recoveryId,
      recoveryGeneration,
      recoveryOwnerId: existing.recoveryOwnerId || null,
      recoveryState: existing.recoveryState,
      recoveryVersion: existing.recoveryVersion,
      idempotent: true
    };
  }
  const allowed = RECOVERY_TRANSITIONS[existing.recoveryState];
  if (!allowed?.has(state)) {
    return { transitioned: false, reason: `invalid recovery transition ${existing.recoveryState || 'NONE'} -> ${state}` };
  }
  const updated = await RuntimeCoordination.findOneAndUpdate(
    {
      _id: 'runtime',
      workloads: { $elemMatch: {
        recoveryRequired: true,
        recoveryId,
        recoveryGeneration,
        principal,
        recoveryVersion: version,
        recoveryState: existing.recoveryState,
        ...(existing.recoveryOwnerId
          ? { recoveryOwnerId: ownerId, recoveryExpiresAt: { $gt: now } }
          : { expiresAt: { $gt: now } }),
      } }
    },
    {
      $set: {
        'workloads.$.recoveryState': state,
        'workloads.$.recoveryVersion': version + 1,
        'workloads.$.recoveryReceipt': receipt && typeof receipt === 'object' ? receipt : null,
        ...(state === 'UNKNOWN' ? { 'workloads.$.expiresAt': new Date() } : {})
      }
    },
    { new: true }
  ).lean();
  if (!updated) return { transitioned: false, reason: 'recovery state changed concurrently' };
  const owned = updated.workloads.find(item => item.recoveryId === recoveryId);
  return {
    transitioned: true,
    recoveryId,
    recoveryGeneration,
    recoveryOwnerId: owned.recoveryOwnerId || null,
    recoveryState: owned.recoveryState,
    recoveryVersion: owned.recoveryVersion
  };
}

async function assertWorkloadRecovery({ recoveryId, recoveryGeneration, principal, ownerId = null } = {}) {
  recoveryId = clean(recoveryId);
  recoveryGeneration = clean(recoveryGeneration);
  principal = clean(principal);
  ownerId = clean(ownerId);
  if (!recoveryId || !recoveryGeneration || !principal) {
    return { owned: false, reason: 'exact recovery proof required' };
  }
  const now = new Date();
  const state = await RuntimeCoordination.findOne({
    _id: 'runtime',
    workloads: { $elemMatch: {
      recoveryRequired: true,
      recoveryId,
      recoveryGeneration,
      principal,
      ...(ownerId
        ? { recoveryOwnerId: ownerId, recoveryExpiresAt: { $gt: now } }
        : { recoveryOwnerId: null, expiresAt: { $gt: now } })
    } }
  }).lean();
  if (!state) return { owned: false, reason: 'recovery proof no longer owns quarantine' };
  const owned = state.workloads.find(item => item.recoveryId === recoveryId && item.recoveryGeneration === recoveryGeneration);
  return {
    owned: true,
    admissionId: owned.admissionId,
    generation: owned.generation,
    principal: owned.principal,
    workloadId: owned.workloadId,
    recoveryId: owned.recoveryId,
    recoveryGeneration: owned.recoveryGeneration,
    recoveryOwnerId: owned.recoveryOwnerId || null,
    recoveryHeartbeatAt: owned.recoveryHeartbeatAt || null,
    recoveryExpiresAt: owned.recoveryExpiresAt || null,
    recoveryState: owned.recoveryState,
    recoveryVersion: owned.recoveryVersion
  };
}

async function resolveWorkloadRecovery({ recoveryId, recoveryGeneration, principal, ownerId = null } = {}) {
  const ownership = await assertWorkloadRecovery({ recoveryId, recoveryGeneration, principal, ownerId });
  if (ownership.owned !== true) return { released: false, reason: ownership.reason };
  const current = await RuntimeCoordination.findById('runtime').select('+releaseReceipts').lean();
  const owned = (current?.workloads || []).find(item => item.recoveryId === recoveryId
    && item.recoveryGeneration === recoveryGeneration
    && item.principal === principal
    && (!ownerId || item.recoveryOwnerId === ownerId));
  if (!owned) return { released: false, reason: 'recovery proof no longer owns quarantine' };
  if (owned.recoveryState !== 'RESTORED' || !owned.recoveryReceipt) {
    return { released: false, reason: 'recovery quarantine is not VERIFIED and RESTORED with a receipt' };
  }
  const releasedAt = new Date();
  const releaseReceipt = {
    coordinationKind: 'workload',
    released: true,
    admissionId: owned.admissionId,
    generation: owned.generation,
    principal: owned.principal,
    requestId: owned.requestId,
    workloadId: owned.workloadId,
    kind: owned.kind,
    batchId: owned.batchId,
    hosts: normalizedHosts(owned.hosts),
    recoveryRequired: true,
    recoveryId: owned.recoveryId,
    recoveryGeneration: owned.recoveryGeneration,
    recoveryOwnerId: owned.recoveryOwnerId || null,
    recoveryState: owned.recoveryState,
    recoveryVersion: owned.recoveryVersion,
    recoveryReceipt: owned.recoveryReceipt,
    releasedAt
  };
  const prior = await RuntimeCoordination.findOneAndUpdate(
    {
      _id: 'runtime',
      workloads: { $elemMatch: {
        admissionId: owned.admissionId,
        generation: owned.generation,
        principal,
        recoveryRequired: true,
        recoveryId,
        recoveryGeneration,
        recoveryState: 'RESTORED',
        recoveryVersion: owned.recoveryVersion,
        recoveryReceipt: { $ne: null },
        ...(ownerId
          ? { recoveryOwnerId: ownerId, recoveryExpiresAt: { $gt: releasedAt } }
          : { recoveryOwnerId: null, expiresAt: { $gt: releasedAt } })
      } }
    },
    {
      $pull: { workloads: {
        admissionId: owned.admissionId,
        generation: owned.generation,
        principal,
        recoveryId,
        recoveryGeneration,
        recoveryState: 'RESTORED',
        recoveryVersion: owned.recoveryVersion,
        ...(ownerId ? { recoveryOwnerId: ownerId } : { recoveryOwnerId: null })
      } },
      $push: { releaseReceipts: { $each: [releaseReceipt], $slice: -100 } }
    },
    { new: false }
  ).lean();
  return prior ? releaseReceipt : { released: false, reason: 'recovery proof changed during release' };
}

async function isWorkloadRecoveryRequired({ id, generation, principal } = {}) {
  id = clean(id);
  generation = clean(generation);
  principal = clean(principal);
  if (!id || !generation || !principal) return false;
  const state = await RuntimeCoordination.findOne({
    _id: 'runtime',
    workloads: { $elemMatch: { admissionId: id, generation, principal, recoveryRequired: true } }
  }).lean();
  return Boolean(state);
}

async function assertWorkloadAdmission({ id, generation, principal, workloadId, host } = {}) {
  id = clean(id);
  generation = clean(generation);
  principal = clean(principal);
  workloadId = clean(workloadId);
  host = canonicalHost(host);
  if (!id || !generation || !principal || !workloadId) {
    return { admitted: false, reason: 'exact workload admission proof required' };
  }
  await reapExpired();
  const state = await RuntimeCoordination.findOne({
    _id: 'runtime',
    workloads: { $elemMatch: {
      admissionId: id,
      generation,
      principal,
      workloadId,
      expiresAt: { $gt: new Date() },
      ...(host ? { hosts: host } : {})
    } }
  }).lean();
  if (!state) return { admitted: false, reason: 'workload admission proof is absent, expired, or does not cover this host' };
  const owned = state.workloads.find(item => item.admissionId === id && item.generation === generation);
  return {
    admitted: true,
    admissionId: owned.admissionId,
    generation: owned.generation,
    principal: owned.principal,
    workloadId: owned.workloadId,
    kind: owned.kind,
    batchId: owned.batchId,
    hosts: normalizedHosts(owned.hosts),
    expiresAt: owned.expiresAt
  };
}

async function release(kind, { id, generation, principal } = {}) {
  id = clean(id);
  generation = clean(generation);
  principal = clean(principal);
  if (!id || !generation || !principal) return { released: false, reason: 'exact lease proof required' };
  const isMaintenance = kind === 'maintenance';
  const now = new Date();
  await reapExpired(now);
  const current = await RuntimeCoordination.findById('runtime').select('+releaseReceipts').lean();
  const owned = isMaintenance
    ? current?.maintenance
    : (current?.workloads || []).find(item => item.admissionId === id && item.generation === generation);
  const exactOwner = owned
    && owned.generation === generation
    && owned.principal === principal
    && (isMaintenance ? owned.leaseId === id : owned.admissionId === id);
  if (!exactOwner) return { released: false, reason: 'lease proof no longer owns coordination state' };
  if (isMaintenance && (owned.state || 'ACTIVE') !== 'ACTIVE') {
    return {
      released: false,
      recoveryRequired: true,
      reason: 'maintenance lease is quarantined pending operator reconciliation'
    };
  }
  if (!isMaintenance && owned.recoveryRequired === true && owned.recoveryState !== 'PREPARED') {
    return { released: false, reason: 'workload is protected by durable recovery quarantine' };
  }
  const releasedAt = new Date();
  const releaseReceipt = isMaintenance ? {
    coordinationKind: 'maintenance',
    released: true,
    leaseId: owned.leaseId,
    generation: owned.generation,
    principal: owned.principal,
    requestId: owned.requestId,
    scope: owned.scope,
    releasedAt
  } : {
    coordinationKind: 'workload',
    released: true,
    admissionId: owned.admissionId,
    generation: owned.generation,
    principal: owned.principal,
    requestId: owned.requestId,
    workloadId: owned.workloadId,
    kind: owned.kind,
    batchId: owned.batchId,
    hosts: normalizedHosts(owned.hosts),
    releasedAt
  };
  const filter = isMaintenance
    ? {
      _id: 'runtime',
      'maintenance.leaseId': id,
      'maintenance.generation': generation,
      'maintenance.principal': principal,
      'maintenance.state': { $in: ['ACTIVE', null] },
      'maintenance.expiresAt': { $gt: releasedAt }
    }
    : { _id: 'runtime', workloads: { $elemMatch: {
      admissionId: id, generation, principal, expiresAt: { $gt: releasedAt }
    } } };
  const update = {
    ...(isMaintenance
      ? { $set: { maintenance: null } }
      : { $pull: { workloads: { admissionId: id, generation, principal } } }),
    $push: { releaseReceipts: { $each: [releaseReceipt], $slice: -100 } }
  };
  const prior = await RuntimeCoordination.findOneAndUpdate(filter, update, { new: false }).lean();
  if (!prior) return { released: false, reason: 'lease proof no longer owns coordination state' };
  return isMaintenance ? {
    released: true,
    leaseId: owned.leaseId,
    generation: owned.generation,
    principal: owned.principal,
    requestId: owned.requestId,
    scope: owned.scope,
    releasedAt
  } : {
    released: true,
    admissionId: owned.admissionId,
    generation: owned.generation,
    principal: owned.principal,
    requestId: owned.requestId,
    workloadId: owned.workloadId,
    kind: owned.kind,
    batchId: owned.batchId,
    hosts: normalizedHosts(owned.hosts),
    releasedAt
  };
}

async function recoverRelease(kind, { id, generation, principal } = {}) {
  id = clean(id);
  generation = clean(generation);
  principal = clean(principal);
  if (!id || !generation || !principal) return { recovered: false, released: false, reason: 'exact lease proof required' };
  await ensureDocument();
  const isMaintenance = kind === 'maintenance';
  const current = await RuntimeCoordination.findById('runtime').select('+releaseReceipts').lean();
  const receipt = [...(current?.releaseReceipts || [])].reverse().find(item => (
    item?.coordinationKind === kind
    && item.generation === generation
    && item.principal === principal
    && (isMaintenance ? item.leaseId === id : item.admissionId === id)
  ));
  if (receipt) return { recovered: true, ...receipt };
  const active = isMaintenance
    ? current?.maintenance
    : (current?.workloads || []).find(item => item.admissionId === id);
  if (active?.generation === generation && active?.principal === principal) {
    return isMaintenance ? {
      recovered: true,
      released: false,
      retryable: (active.state || 'ACTIVE') === 'ACTIVE',
      leaseId: active.leaseId,
      generation: active.generation,
      principal: active.principal,
      requestId: active.requestId,
      scope: active.scope,
      state: active.state || 'ACTIVE',
      recoveryRequired: active.state === 'UNKNOWN',
      reason: active.state === 'UNKNOWN'
        ? 'maintenance lease is quarantined pending operator reconciliation'
        : 'exact lease remains active'
    } : {
      recovered: true,
      released: false,
      retryable: true,
      admissionId: active.admissionId,
      generation: active.generation,
      principal: active.principal,
      requestId: active.requestId,
      workloadId: active.workloadId,
      kind: active.kind,
      batchId: active.batchId,
      hosts: normalizedHosts(active.hosts),
      recoveryRequired: active.recoveryRequired === true,
      recoveryId: active.recoveryId || null,
      recoveryGeneration: active.recoveryGeneration || null,
      recoveryOwnerId: active.recoveryOwnerId || null,
      recoveryState: active.recoveryState || null,
      recoveryVersion: active.recoveryVersion ?? null,
      reason: 'exact lease remains active'
    };
  }
  return { recovered: false, released: false, retryable: false, reason: 'no matching release receipt or active lease' };
}

async function listActive() {
  await reapExpired();
  const state = await RuntimeCoordination.findById('runtime').lean();
  return {
    maintenance: state?.maintenance ? {
      active: (state.maintenance.state || 'ACTIVE') === 'ACTIVE',
      quarantined: state.maintenance.state === 'UNKNOWN',
      leaseId: state.maintenance.leaseId,
      principal: state.maintenance.principal,
      scope: state.maintenance.scope,
      acquiredAt: state.maintenance.acquiredAt,
      heartbeatAt: state.maintenance.heartbeatAt,
      expiresAt: state.maintenance.expiresAt,
      unknownAt: state.maintenance.unknownAt || null,
      unknownReason: state.maintenance.unknownReason || null
    } : null,
    workloads: (state?.workloads || []).map(item => ({
      admissionId: item.admissionId,
      principal: item.principal,
      workloadId: item.workloadId,
      kind: item.kind,
      batchId: item.batchId,
      hosts: item.hosts,
      recoveryRequired: item.recoveryRequired === true,
      acquiredAt: item.acquiredAt,
      heartbeatAt: item.heartbeatAt,
      expiresAt: item.expiresAt
    })),
    inferences: (state?.inferences || []).map(item => ({
      active: item.state === 'ACTIVE',
      quarantined: item.state === 'UNKNOWN',
      host: item.host,
      model: item.model,
      kind: item.kind,
      mode: item.mode || 'shared',
      acquiredAt: item.acquiredAt,
      heartbeatAt: item.heartbeatAt,
      expiresAt: item.expiresAt
    }))
  };
}

module.exports = {
  acquireMaintenance,
  acquireWorkload,
  acquireInference,
  heartbeatInference,
  releaseInference,
  markInferenceUnknown,
  recoverInferenceAfterRuntimeRestart,
  markMaintenanceUnknown,
  recoverMaintenanceAfterOperatorReconciliation,
  hostHasActiveInferences,
  armWorkloadRecovery,
  adoptWorkloadRecovery,
  heartbeatWorkloadRecovery,
  assertWorkloadRecovery,
  transitionWorkloadRecovery,
  resolveWorkloadRecovery,
  isWorkloadRecoveryRequired,
  assertWorkloadAdmission,
  heartbeat,
  release,
  recoverRelease,
  listActive,
  reapExpired,
  _internal: {
    ttlMs,
    canonicalHost,
    classifyKeepAlive,
    buildInferenceResidencySpec,
    buildInferenceResidencyKey
  }
};
