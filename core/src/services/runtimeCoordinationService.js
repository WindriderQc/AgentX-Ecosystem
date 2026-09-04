'use strict';

const crypto = require('crypto');
const RuntimeCoordination = require('../../models/RuntimeCoordination');

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

function normalizedHosts(values) {
  return [...new Set((Array.isArray(values) ? values : [])
    .map(value => clean(value, 500))
    .filter(Boolean))].sort();
}

function sameMaintenanceIntent(existing, { scope }) {
  return existing?.scope === scope;
}

function sameWorkloadIntent(existing, { workloadId, kind, batchId }) {
  return existing?.workloadId === workloadId
    && existing?.kind === kind
    && (existing?.batchId || null) === (batchId || null);
}

async function ensureDocument() {
  try {
    await RuntimeCoordination.updateOne(
      { _id: 'runtime' },
      { $setOnInsert: { maintenance: null, workloads: [] } },
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
  await RuntimeCoordination.updateOne(
    { _id: 'runtime' },
    { $pull: { workloads: { expiresAt: { $lte: now } } } }
  );
  const current = await RuntimeCoordination.findById('runtime').lean();
  const maintenance = current?.maintenance;
  if (maintenance?.leaseId && new Date(maintenance.expiresAt).getTime() <= now.getTime()) {
    await RuntimeCoordination.updateOne(
      {
        _id: 'runtime',
        'maintenance.leaseId': maintenance.leaseId,
        'maintenance.generation': maintenance.generation,
        'maintenance.expiresAt': maintenance.expiresAt
      },
      { $set: { maintenance: null } }
    );
  }
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
    expiresAt: new Date(now.getTime() + duration)
  };
  const updated = await RuntimeCoordination.findOneAndUpdate(
    {
      _id: 'runtime',
      maintenance: null,
      'workloads.0': { $exists: false }
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
    return { acquired: true, ...raced.maintenance, idempotent: true };
  }
  return { acquired: false, reason: 'active workload admission or maintenance lease blocks maintenance' };
}

async function acquireWorkload({ principal, requestId, workloadId, kind, batchId, hosts, ttl } = {}) {
  principal = clean(principal);
  requestId = clean(requestId);
  workloadId = clean(workloadId);
  kind = clean(kind) || 'benchmark';
  batchId = clean(batchId);
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
    return { acquired: true, ...existing, idempotent: true };
  }
  const now = new Date();
  const duration = ttlMs(ttl);
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
    expiresAt: new Date(now.getTime() + duration)
  };
  const updated = await RuntimeCoordination.findOneAndUpdate(
    {
      _id: 'runtime',
      maintenance: null,
      workloads: { $not: { $elemMatch: { requestId, principal } } }
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
    return { acquired: true, ...racedAdmission, idempotent: true };
  }
  return { acquired: false, reason: 'active maintenance lease blocks workload admission' };
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
    ? { _id: 'runtime', 'maintenance.leaseId': id, 'maintenance.generation': generation, 'maintenance.principal': principal }
    : { _id: 'runtime', workloads: { $elemMatch: { admissionId: id, generation, principal } } };
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
    heartbeatAt: owned.heartbeatAt,
    expiresAt: owned.expiresAt
  };
}

async function release(kind, { id, generation, principal } = {}) {
  id = clean(id);
  generation = clean(generation);
  principal = clean(principal);
  if (!id || !generation || !principal) return { released: false, reason: 'exact lease proof required' };
  const isMaintenance = kind === 'maintenance';
  const filter = isMaintenance
    ? { _id: 'runtime', 'maintenance.leaseId': id, 'maintenance.generation': generation, 'maintenance.principal': principal }
    : { _id: 'runtime', workloads: { $elemMatch: { admissionId: id, generation, principal } } };
  const update = isMaintenance
    ? { $set: { maintenance: null } }
    : { $pull: { workloads: { admissionId: id, generation, principal } } };
  const prior = await RuntimeCoordination.findOneAndUpdate(filter, update, { new: false }).lean();
  if (!prior) return { released: false, reason: 'lease proof no longer owns coordination state' };
  const owned = isMaintenance
    ? prior.maintenance
    : prior.workloads.find(item => item.admissionId === id && item.generation === generation);
  const releasedAt = new Date();
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
    releasedAt
  };
}

async function listActive() {
  await reapExpired();
  const state = await RuntimeCoordination.findById('runtime').lean();
  return {
    maintenance: state?.maintenance ? {
      active: true,
      leaseId: state.maintenance.leaseId,
      principal: state.maintenance.principal,
      scope: state.maintenance.scope,
      acquiredAt: state.maintenance.acquiredAt,
      heartbeatAt: state.maintenance.heartbeatAt,
      expiresAt: state.maintenance.expiresAt
    } : null,
    workloads: (state?.workloads || []).map(item => ({
      admissionId: item.admissionId,
      principal: item.principal,
      workloadId: item.workloadId,
      kind: item.kind,
      batchId: item.batchId,
      hosts: item.hosts,
      acquiredAt: item.acquiredAt,
      heartbeatAt: item.heartbeatAt,
      expiresAt: item.expiresAt
    }))
  };
}

module.exports = {
  acquireMaintenance,
  acquireWorkload,
  heartbeat,
  release,
  listActive,
  reapExpired,
  _internal: { ttlMs }
};
