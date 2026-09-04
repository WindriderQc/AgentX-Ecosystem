/**
 * Nerve Center — Host Preferences
 *
 * Host pin management (get / put / delete pin, restore, swap), benchmark
 * claim coordination (claim / release / list / reap), and the host-prefs
 * list endpoint with live Ollama status.
 *
 * Extracted from `routes/nerve-center.js` in task 0193 to keep that file
 * under the 700-line cap. Mounted at `/api/nerve-center` alongside the
 * original; URLs unchanged.
 */

const express = require('express');
const router = express.Router();
const logger = require('../config/logger');

const { HOSTS, TASK_MODELS } = require('../src/services/modelRouterConfig');
const hostPrefService = require('../src/services/hostPreferenceService');
const { modelsMatch } = require('../src/helpers/modelNameNormalization');
const { validateHostUrl } = require('../src/helpers/ollamaHostConfig');
const { emit: emitBuddyEvent } = require('../src/services/buddyEvents');
const { requireTypedConfirmation } = require('../src/helpers/typedConfirmation');
const { requireBenchmarkServiceAccess } = require('../src/middleware/benchmarkServiceAccess');
const { benchmarkTokenAllowed } = require('../src/services/routing/inferenceCallerAccess');
const {
  requireOperatorAccess,
  requireOperatorUiAccess,
  operatorRequestIdentity
} = require('../src/middleware/operatorAccess');
const runtimeCoordinationService = require('../src/services/runtimeCoordinationService');
const { projectHostPreferenceForRead } = require('../src/services/hostPreferencePublicProjection');

function coordinationPrincipal(req) {
  return benchmarkTokenAllowed(req) ? 'benchmark-service' : operatorRequestIdentity(req);
}

function requireBenchmarkCoordinationAccess(req, res, next) {
  if (benchmarkTokenAllowed(req)) return next();
  return res.status(403).json({
    status: 'error',
    code: 'BENCHMARK_COORDINATION_AUTH_REQUIRED',
    message: 'Exact Benchmark service authentication is required for runtime workload admission.'
  });
}

function resolveHostPreferenceUrl(req, res) {
  let rawHostUrl;
  try {
    rawHostUrl = decodeURIComponent(req.params.hostUrl);
  } catch {
    res.status(400).json({ status: 'error', message: 'hostUrl is invalid' });
    return null;
  }

  const validation = validateHostUrl(rawHostUrl);
  if (!validation.valid) {
    res.status(400).json({ status: 'error', message: validation.message });
    return null;
  }

  return validation.host || String(rawHostUrl || '').trim();
}

// ========================================
// GET /host-preferences — all host preferences with live status
// ========================================

router.get('/host-preferences', async (_req, res) => {
  try {
    const prefs = await hostPrefService.getAll();
    const hostIdentityDrift = hostPrefService.detectHostPreferenceIdentityDrift(prefs);
    const normalizedPrefs = prefs.map((pref) => projectHostPreferenceForRead(
      hostPrefService.normalizeHostPreferenceIdentity(pref)
    ));

    // Build set of models referenced by TASK_MODELS per host key, then map to URLs
    const taskRoutedByUrl = new Map();
    for (const entry of Object.values(TASK_MODELS)) {
      const hostUrl = HOSTS[entry.host];
      if (!hostUrl || !entry.model) continue;
      if (!taskRoutedByUrl.has(hostUrl)) taskRoutedByUrl.set(hostUrl, new Set());
      taskRoutedByUrl.get(hostUrl).add(entry.model);
    }

    // Merge live Ollama status from each host. `pinnedModels` is the only
    // canonical surface — legacy emit (defaultModels / pinnedModel / flat
    // keepAlive / contextSize / autoRestore) was retired in task 0158.
    const data = await Promise.all(normalizedPrefs.map(async (pref) => {
      const observedAt = new Date().toISOString();
      const validation = validateHostUrl(pref.hostUrl);
      if (!validation.valid) {
        return {
          ...pref,
          pinnedModels: hostPrefService.getPinnedEntries(pref),
          driftModels: [],
          live: {
            online: false,
            runningModels: [],
            pinnedLoaded: null,
            anyPinnedLoaded: false,
            blockedByAllowlist: true,
            observedAt
          }
        };
      }

      const safeHostUrl = validation.host || pref.hostUrl;
      const pinnedEntries = hostPrefService.getPinnedEntries(pref);
      const pinnedNames = pinnedEntries.map(e => e.model);
      const primaryPin = pinnedNames[0] || null;
      // Drift: pinned models not referenced by any task on this host
      const routedModels = taskRoutedByUrl.get(safeHostUrl) || new Set();
      const driftModels = pinnedNames.filter(m => !routedModels.has(m));

      try {
        const psResponse = await fetch(`${safeHostUrl}/api/ps`, {
          signal: AbortSignal.timeout(3_000)
        });
        const psData = psResponse.ok ? await psResponse.json() : { models: [] };
        const runningModels = (psData.models || []).map(m => {
          const matchedPinned = pinnedNames.find(p => modelsMatch(m.name, p)) || null;
          return {
            name: m.name,
            size: m.size,
            sizeVram: m.size_vram,
            expiresAt: m.expires_at,
            matchedPinned
          };
        });
        const anyPinnedLoaded = runningModels.some(rm => rm.matchedPinned !== null);
        return {
          ...pref,
          pinnedModels: pinnedEntries,
          driftModels,
          live: {
            online: true,
            runningModels,
            pinnedLoaded: primaryPin
              ? runningModels.some(rm => modelsMatch(rm.name, primaryPin))
              : null,
            anyPinnedLoaded,
            observedAt
          }
        };
      } catch {
        return {
          ...pref,
          pinnedModels: pinnedEntries,
          driftModels,
          live: { online: false, runningModels: [], pinnedLoaded: null, anyPinnedLoaded: false, observedAt }
        };
      }
    }));
    res.json({
      status: 'success',
      data,
      healthCheckIntervalMs: hostPrefService.getHealthCheckIntervalMs(),
      hostIdentityDrift
    });
  } catch (err) {
    logger.error('[NerveCenter] host preferences fetch failed', { error: err.message });
    res.status(500).json({ status: 'error', message: err.message });
  }
});

// ========================================
// PUT /host-preferences/health-check-interval — update health check interval
// ========================================

router.put('/host-preferences/health-check-interval', (req, res) => {
  try {
    const { intervalMs } = req.body || {};
    const parsed = parseInt(intervalMs, 10);
    if (!Number.isFinite(parsed) || parsed < 10_000) {
      return res.status(400).json({ status: 'error', message: 'intervalMs must be >= 10000' });
    }
    hostPrefService.setHealthCheckIntervalMs(parsed);
    logger.info('[NerveCenter] Health check interval updated', { intervalMs: parsed });
    res.json({ status: 'success', data: { intervalMs: parsed } });
  } catch (err) {
    logger.error('[NerveCenter] health check interval update failed', { error: err.message });
    res.status(500).json({ status: 'error', message: err.message });
  }
});

// ========================================
// Pin Management: GET/PUT/DELETE pin, POST restore, POST swap
// (Must be registered BEFORE the general PUT /:hostUrl(*) catch-all)
// ========================================

router.get('/host-preferences/:hostUrl(*)/pin', async (req, res) => {
  try {
    const hostUrl = resolveHostPreferenceUrl(req, res);
    if (!hostUrl) return;
    const data = await hostPrefService.getPinStatus(hostUrl);
    res.json({ status: 'success', data });
  } catch (err) {
    logger.error('[NerveCenter] pin status fetch failed', { error: err.message });
    res.status(500).json({ status: 'error', message: err.message });
  }
});

router.put('/host-preferences/:hostUrl(*)/pin', async (req, res) => {
  try {
    const hostUrl = resolveHostPreferenceUrl(req, res);
    if (!hostUrl) return;
    const { model } = req.body || {};
    if (!model) {
      return res.status(400).json({ status: 'error', message: 'model is required' });
    }
    const pref = await hostPrefService.setPinnedModel(hostUrl, model);
    if (!pref) {
      return res.status(404).json({ status: 'error', message: 'Host preference not found. Configure the host first.' });
    }
    if (pref.status === 'restoring') {
      hostPrefService.restorePinnedModels(hostUrl).catch(err => {
        logger.warn(`[NerveCenter] Background pin warmup failed: ${err.message}`);
      });
    }
    emitBuddyEvent('model_pinned', 'infrastructure', `Pinned ${model} on ${pref.displayName || hostUrl}`, 'normal');
    logger.info('[NerveCenter] Model pinned', { hostUrl, model });
    res.json({ status: 'success', data: { pinnedModels: pref.pinnedModels || [], status: pref.status } });
  } catch (err) {
    logger.error('[NerveCenter] pin set failed', { error: err.message });
    res.status(500).json({ status: 'error', message: err.message });
  }
});

router.delete('/host-preferences/:hostUrl(*)/pin', async (req, res) => {
  try {
    const hostUrl = resolveHostPreferenceUrl(req, res);
    if (!hostUrl) return;
    if (!requireTypedConfirmation(req, res, 'CLEAR HOST PIN', hostUrl)) return;
    const pref = await hostPrefService.clearPinnedModel(hostUrl);
    if (!pref) {
      return res.status(404).json({ status: 'error', message: 'Host preference not found' });
    }
    emitBuddyEvent('model_unpinned', 'infrastructure', `Unpinned model on ${pref.displayName || hostUrl}`, 'normal');
    logger.info('[NerveCenter] Model unpinned', { hostUrl });
    res.json({ status: 'success', data: { pinnedModels: [], status: pref.status } });
  } catch (err) {
    logger.error('[NerveCenter] pin clear failed', { error: err.message });
    res.status(500).json({ status: 'error', message: err.message });
  }
});

router.post('/host-preferences/:hostUrl(*)/restore', async (req, res) => {
  try {
    const hostUrl = resolveHostPreferenceUrl(req, res);
    if (!hostUrl) return;
    const result = await hostPrefService.restorePinnedModels(hostUrl);
    if (result.status === 'error') {
      return res.status(400).json({ status: 'error', message: result.error });
    }
    const primaryPin = result.pinnedModels?.[0] || null;
    emitBuddyEvent('model_restoring', 'infrastructure', `Restoring ${primaryPin} on ${hostUrl}`, 'normal');
    logger.info('[NerveCenter] Pin restore triggered', { hostUrl, pinnedModels: result.pinnedModels });
    res.json({ status: 'success', data: result });
  } catch (err) {
    logger.error('[NerveCenter] pin restore failed', { error: err.message });
    res.status(500).json({ status: 'error', message: err.message });
  }
});

router.post('/host-preferences/:hostUrl(*)/swap', async (req, res) => {
  try {
    const hostUrl = resolveHostPreferenceUrl(req, res);
    if (!hostUrl) return;
    const { model } = req.body || {};
    if (!model) {
      return res.status(400).json({ status: 'error', message: 'model is required' });
    }
    const result = await hostPrefService.swapModel(hostUrl, model);
    emitBuddyEvent('model_swapping', 'infrastructure', `Swapping to ${model} on ${hostUrl}`, 'normal');
    logger.info('[NerveCenter] Model swap triggered', { hostUrl, model });
    res.json({ status: 'success', data: result });
  } catch (err) {
    logger.error('[NerveCenter] model swap failed', { error: err.message });
    res.status(500).json({ status: 'error', message: err.message });
  }
});

// ========================================
// Benchmark Coordination
//
// Announce that a benchmark batch has taken over a host, or release the
// announcement when the batch is done. Sets HostPreference.status to
// 'benchmarking' so other consumers can route around the host.
// ========================================

router.post('/host-preferences/:hostUrl(*)/benchmark-claim', requireBenchmarkCoordinationAccess, async (req, res) => {
  try {
    const hostUrl = resolveHostPreferenceUrl(req, res);
    if (!hostUrl) return;
    const { batchId, claimGeneration, admissionId, admissionGeneration, estimatedDurationMs, source, owner, note, heartbeatTtlMs } = req.body || {};
    if (!batchId || !claimGeneration) {
      return res.status(400).json({ status: 'error', message: 'batchId and claimGeneration are required' });
    }
    const admission = await runtimeCoordinationService.assertWorkloadAdmission({
      id: admissionId,
      generation: admissionGeneration,
      principal: coordinationPrincipal(req),
      workloadId: batchId,
      host: hostUrl
    });
    if (!admission.admitted) {
      return res.status(409).json({ status: 'error', code: 'WORKLOAD_ADMISSION_REQUIRED', message: admission.reason });
    }
    const claimOptions = {
      claimGeneration,
      admissionId: admission.admissionId,
      admissionGeneration: admission.generation,
      admissionPrincipal: admission.principal
    };
    if (source !== undefined) claimOptions.source = source;
    if (owner !== undefined) claimOptions.owner = owner;
    if (note !== undefined) claimOptions.note = note;
    if (heartbeatTtlMs !== undefined) claimOptions.heartbeatTtlMs = heartbeatTtlMs;
    const result = await hostPrefService.claimBenchmark(hostUrl, batchId, estimatedDurationMs, claimOptions);
    if (!result.claimed) {
      return res.status(409).json({ status: 'error', message: result.reason, data: result });
    }
    logger.info('[NerveCenter] Benchmark claim acquired', { hostUrl, batchId, estimatedDurationMs, source });
    res.json({ status: 'success', data: result });
  } catch (err) {
    logger.error('[NerveCenter] benchmark claim failed', { error: err.message });
    res.status(500).json({ status: 'error', message: err.message });
  }
});

router.post('/host-preferences/:hostUrl(*)/benchmark-claim/:batchId/heartbeat', requireBenchmarkCoordinationAccess, async (req, res) => {
  try {
    const hostUrl = resolveHostPreferenceUrl(req, res);
    if (!hostUrl) return;
    const batchId = req.params.batchId;
    const { claimGeneration, admissionId, admissionGeneration, estimatedDurationMs, source, owner, note, heartbeatTtlMs } = req.body || {};
    const admission = await runtimeCoordinationService.assertWorkloadAdmission({
      id: admissionId,
      generation: admissionGeneration,
      principal: coordinationPrincipal(req),
      workloadId: batchId,
      host: hostUrl
    });
    if (!admission.admitted) {
      return res.status(409).json({ status: 'error', code: 'WORKLOAD_ADMISSION_REQUIRED', message: admission.reason });
    }
    const result = await hostPrefService.heartbeatBenchmarkClaim(hostUrl, batchId, {
      claimGeneration,
      admissionId: admission.admissionId,
      admissionGeneration: admission.generation,
      admissionPrincipal: admission.principal,
      requireAdmissionProof: true,
      estimatedDurationMs,
      source,
      owner,
      note,
      heartbeatTtlMs
    });
    if (!result.heartbeat) {
      return res.status(409).json({ status: 'error', message: result.reason, data: result });
    }
    logger.debug('[NerveCenter] Benchmark claim heartbeat', { hostUrl, batchId, source });
    res.json({ status: 'success', data: result });
  } catch (err) {
    logger.error('[NerveCenter] benchmark claim heartbeat failed', { error: err.message });
    res.status(500).json({ status: 'error', message: err.message });
  }
});

router.post('/host-preferences/:hostUrl(*)/benchmark-claim/:batchId/release-receipt', requireBenchmarkCoordinationAccess, async (req, res) => {
  try {
    const hostUrl = resolveHostPreferenceUrl(req, res);
    if (!hostUrl) return;
    const batchId = req.params.batchId;
    const { claimGeneration, admissionId, admissionGeneration } = req.body || {};
    const admission = await runtimeCoordinationService.assertWorkloadAdmission({
      id: admissionId,
      generation: admissionGeneration,
      principal: coordinationPrincipal(req),
      workloadId: batchId,
      host: hostUrl
    });
    if (!admission.admitted) {
      return res.status(409).json({ status: 'error', code: 'WORKLOAD_ADMISSION_REQUIRED', message: admission.reason });
    }
    const result = await hostPrefService.recoverBenchmarkClaimRelease(hostUrl, batchId, { claimGeneration });
    return res.json({ status: 'success', data: result });
  } catch (err) {
    logger.error('[NerveCenter] benchmark claim release receipt recovery failed', { error: err.message });
    return res.status(500).json({ status: 'error', code: 'BENCHMARK_RELEASE_RECOVERY_FAILED', message: err.message });
  }
});

router.delete('/host-preferences/:hostUrl(*)/benchmark-claim/:batchId', requireBenchmarkCoordinationAccess, async (req, res) => {
  try {
    const hostUrl = resolveHostPreferenceUrl(req, res);
    if (!hostUrl) return;
    const batchId = req.params.batchId;
    const { claimGeneration, admissionId, admissionGeneration, excludedModels } = req.body || {};
    const admission = await runtimeCoordinationService.assertWorkloadAdmission({
      id: admissionId,
      generation: admissionGeneration,
      principal: coordinationPrincipal(req),
      workloadId: batchId,
      host: hostUrl
    });
    if (!admission.admitted) {
      return res.status(409).json({ status: 'error', code: 'WORKLOAD_ADMISSION_REQUIRED', message: admission.reason });
    }
    const result = await hostPrefService.releaseBenchmarkClaim(hostUrl, batchId, {
      claimGeneration,
      admissionId: admission.admissionId,
      admissionGeneration: admission.generation,
      admissionPrincipal: admission.principal,
      requireAdmissionProof: true,
      excludedModels
    });
    if (!result.released) {
      // Still 200 — release is idempotent; caller just learns the reason
      return res.json({ status: 'success', data: result });
    }
    logger.info('[NerveCenter] Benchmark claim released', { hostUrl, batchId });
    res.json({ status: 'success', data: result });
  } catch (err) {
    logger.error('[NerveCenter] benchmark claim release failed', { error: err.message });
    res.status(500).json({ status: 'error', message: err.message });
  }
});

router.get('/host-preferences/benchmark-claims/active', async (_req, res) => {
  try {
    const claims = await hostPrefService.listBenchmarkClaims();
    // Claim generations are bearer capabilities for the direct inference
    // lane. This operator/status projection must never disclose them.
    const publicClaims = claims.map(({
      claimGeneration: _claimSecret,
      admissionId: _admissionId,
      admissionGeneration: _admissionSecret,
      preClaimRuntime: _runtimeSecret,
      finalizeToken: _finalizerSecret,
      ...claim
    }) => claim);
    res.json({ status: 'success', data: { claims: publicClaims, count: publicClaims.length } });
  } catch (err) {
    logger.error('[NerveCenter] listing benchmark claims failed', { error: err.message });
    res.status(500).json({ status: 'error', message: err.message });
  }
});

// Runtime-wide maintenance/workload exclusion. Generations are minted only by
// Core and are returned solely to the authenticated acquiring principal.
router.post('/maintenance-leases', requireOperatorAccess, async (req, res) => {
  try {
    const result = await runtimeCoordinationService.acquireMaintenance({
      principal: operatorRequestIdentity(req),
      requestId: req.body?.requestId || req.body?.idempotencyKey,
      scope: req.body?.scope,
      ttl: req.body?.ttlMs
    });
    return res.status(result.acquired ? 200 : 409).json({ status: result.acquired ? 'success' : 'error', data: result });
  } catch (error) {
    return res.status(500).json({ status: 'error', code: 'MAINTENANCE_LEASE_FAILED', message: error.message });
  }
});

router.post('/maintenance-leases/:leaseId/heartbeat', requireOperatorAccess, async (req, res) => {
  try {
    const result = await runtimeCoordinationService.heartbeat('maintenance', {
      id: req.params.leaseId,
      generation: req.body?.generation,
      principal: operatorRequestIdentity(req),
      ttl: req.body?.ttlMs
    });
    return res.status(result.heartbeat ? 200 : 409).json({ status: result.heartbeat ? 'success' : 'error', data: result });
  } catch (error) {
    return res.status(500).json({ status: 'error', code: 'MAINTENANCE_HEARTBEAT_FAILED', message: error.message });
  }
});

router.delete('/maintenance-leases/:leaseId', requireOperatorAccess, async (req, res) => {
  try {
    const result = await runtimeCoordinationService.release('maintenance', {
      id: req.params.leaseId,
      generation: req.body?.generation,
      principal: operatorRequestIdentity(req)
    });
    return res.status(result.released ? 200 : 409).json({ status: result.released ? 'success' : 'error', data: result });
  } catch (error) {
    return res.status(500).json({ status: 'error', code: 'MAINTENANCE_RELEASE_FAILED', message: error.message });
  }
});

router.post('/maintenance-leases/:leaseId/release-receipt', requireOperatorAccess, async (req, res) => {
  try {
    const result = await runtimeCoordinationService.recoverRelease('maintenance', {
      id: req.params.leaseId,
      generation: req.body?.generation,
      principal: operatorRequestIdentity(req)
    });
    return res.status(result.recovered ? 200 : 409).json({
      status: result.recovered ? 'success' : 'error',
      data: result
    });
  } catch (error) {
    return res.status(500).json({
      status: 'error',
      code: 'MAINTENANCE_RELEASE_RECOVERY_FAILED',
      message: error.message
    });
  }
});

router.post('/workload-admissions', requireBenchmarkCoordinationAccess, async (req, res) => {
  try {
    const result = await runtimeCoordinationService.acquireWorkload({
      principal: coordinationPrincipal(req),
      requestId: req.body?.requestId || req.body?.idempotencyKey,
      workloadId: req.body?.workloadId,
      kind: req.body?.kind,
      batchId: req.body?.batchId,
      hosts: req.body?.hosts,
      ttl: req.body?.ttlMs
    });
    return res.status(result.acquired ? 200 : 409).json({ status: result.acquired ? 'success' : 'error', data: result });
  } catch (error) {
    return res.status(500).json({ status: 'error', code: 'WORKLOAD_ADMISSION_FAILED', message: error.message });
  }
});

router.post('/workload-admissions/:admissionId/heartbeat', requireBenchmarkCoordinationAccess, async (req, res) => {
  try {
    const result = await runtimeCoordinationService.heartbeat('workload', {
      id: req.params.admissionId,
      generation: req.body?.generation,
      principal: coordinationPrincipal(req),
      ttl: req.body?.ttlMs
    });
    return res.status(result.heartbeat ? 200 : 409).json({ status: result.heartbeat ? 'success' : 'error', data: result });
  } catch (error) {
    return res.status(500).json({ status: 'error', code: 'WORKLOAD_HEARTBEAT_FAILED', message: error.message });
  }
});

router.delete('/workload-admissions/:admissionId', requireBenchmarkCoordinationAccess, async (req, res) => {
  try {
    const result = await runtimeCoordinationService.release('workload', {
      id: req.params.admissionId,
      generation: req.body?.generation,
      principal: coordinationPrincipal(req)
    });
    return res.status(result.released ? 200 : 409).json({ status: result.released ? 'success' : 'error', data: result });
  } catch (error) {
    return res.status(500).json({ status: 'error', code: 'WORKLOAD_RELEASE_FAILED', message: error.message });
  }
});

router.post('/workload-admissions/:admissionId/release-receipt', requireBenchmarkCoordinationAccess, async (req, res) => {
  try {
    const result = await runtimeCoordinationService.recoverRelease('workload', {
      id: req.params.admissionId,
      generation: req.body?.generation,
      principal: coordinationPrincipal(req)
    });
    return res.status(result.recovered ? 200 : 409).json({
      status: result.recovered ? 'success' : 'error',
      data: result
    });
  } catch (error) {
    return res.status(500).json({
      status: 'error',
      code: 'WORKLOAD_RELEASE_RECOVERY_FAILED',
      message: error.message
    });
  }
});

router.get('/runtime-coordination/active', requireOperatorAccess, async (_req, res) => {
  try {
    const data = await runtimeCoordinationService.listActive();
    return res.json({ status: 'success', data });
  } catch (error) {
    return res.status(500).json({ status: 'error', code: 'RUNTIME_COORDINATION_STATUS_FAILED', message: error.message });
  }
});

/**
 * POST /host-preferences/benchmark-claims/reap
 * Manually trigger the stale-claim reaper. Normally runs every 5 min via
 * server.js; this endpoint is for operator-initiated recovery.
 * Optional body: { graceFactor, hardCapMs }
 */
router.post('/host-preferences/benchmark-claims/reap', requireOperatorAccess, async (req, res) => {
  try {
    const result = await hostPrefService.reapStaleBenchmarkClaims(req.body || {});
    res.json({ status: 'success', data: result });
  } catch (err) {
    logger.error('[NerveCenter] benchmark claim reap failed', { error: err.message });
    res.status(err.code === 'BENCHMARK_REAPER_OPTIONS_INVALID' ? 400 : 500).json({
      status: 'error',
      code: err.code || 'BENCHMARK_CLAIM_REAP_FAILED',
      message: err.message
    });
  }
});

// ========================================
// PUT /host-preferences/:hostUrl — update host preference
// ========================================

router.put('/host-preferences/:hostUrl(*)', requireOperatorUiAccess, async (req, res) => {
  try {
    const hostUrl = resolveHostPreferenceUrl(req, res);
    if (!hostUrl) return;
    const updates = req.body || {};

    // Reject pre-0158 legacy-shape payloads. The back-compat translation
    // layer (defaultModels / pinnedModel / flat keepAlive / contextSize /
    // autoRestore) was retired when the hostpreferences migration completed
    // and the schema flipped to strict:true. Clients must now PUT
    // `pinnedModels: [{ model, keepAlive, contextSize, autoRestore }, ...]`.
    const legacyKeys = ['defaultModels', 'pinnedModel', 'keepAlive', 'contextSize', 'autoRestore'];
    const foundLegacy = legacyKeys.filter(k => updates[k] !== undefined);
    if (foundLegacy.length > 0) {
      return res.status(400).json({
        status: 'error',
        message: `Legacy host-preference fields are no longer accepted: ${foundLegacy.join(', ')}. Send pinnedModels: [{ model, keepAlive, contextSize, autoRestore }, ...] instead.`
      });
    }

    const allowed = ['hostKey', 'displayName', 'pinnedModels', 'maxConcurrentModels', 'vramTotalMiB', 'vramReservedMiB', 'gpu', 'tags'];
    const filtered = {};
    for (const key of allowed) {
      if (updates[key] !== undefined) filtered[key] = updates[key];
    }

    const data = await hostPrefService.updatePreference(hostUrl, filtered);
    emitBuddyEvent('host_preference_updated', 'infrastructure', `Host preference updated: ${data.displayName || hostUrl}`, 'normal');
    logger.info('[NerveCenter] Host preference updated', { hostUrl, updates: Object.keys(filtered) });
    res.json({ status: 'success', data: projectHostPreferenceForRead(data) });
  } catch (err) {
    logger.error('[NerveCenter] host preference update failed', { error: err.message });
    res.status(500).json({ status: 'error', message: err.message });
  }
});

// ========================================
// POST /host-preferences/:hostUrl/reload — reload default models on host
// ========================================

router.post('/host-preferences/:hostUrl(*)/reload', requireBenchmarkServiceAccess, async (req, res) => {
  try {
    const hostUrl = resolveHostPreferenceUrl(req, res);
    if (!hostUrl) return;
    const pref = await hostPrefService.getByHost(hostUrl);
    const entries = hostPrefService.getPinnedEntries(pref);
    if (!entries.length) {
      return res.status(400).json({ status: 'error', message: 'No pinned models configured for this host' });
    }
    const results = await hostPrefService.warmHost(hostUrl);
    emitBuddyEvent('host_defaults_reloaded', 'infrastructure', `Reloaded pins on ${pref.displayName || hostUrl}`, 'normal');
    logger.info('[NerveCenter] Host pinned models reloaded', { hostUrl, results });
    res.json({ status: 'success', data: results });
  } catch (err) {
    logger.error('[NerveCenter] host preference reload failed', { error: err.message });
    res.status(500).json({ status: 'error', message: err.message });
  }
});

module.exports = router;
