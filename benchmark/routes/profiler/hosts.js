const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const hostProfileService = require('../../src/services/profiler/hostProfileService');
const modelDiscoveryService = require('../../src/services/profiler/modelDiscoveryService');
const hostFitReportService = require('../../src/services/profiler/hostFitReportService');
const { getConfiguredHosts } = require('../../src/helpers/ollamaHostConfig');
const {
  testModelOnHost,
  testAllModelsOnHost,
  testModelAcrossHosts,
  checkHost,
  getConfig
} = require('../../src/services/hostTestService');
const { probeModelContext, getProbeStatus } = require('../../src/services/contextProbeService');
const { resolveModelNumCtxDetails } = require('../../src/services/modelContextResolver');
const liveProbeService = require('../../src/services/profiler/liveProbeService');
const baselineModelService = require('../../src/services/profiler/baselineModelService');
const HostPerformanceSnapshot = require('../../models/HostPerformanceSnapshot');
const HostProfile = require('../../models/HostProfile');
const { acquireProfilerClaimLease } = require('../../src/services/profiler/profilerClaimLifecycle');
const { admitOllamaTargetResolved } = require('../../src/helpers/ollamaTargetAdmission');
const { isSameOllamaModel } = require('../../src/helpers/ollamaModelIdentity');
const { getWorkloadRecoveryIdentity } = require('../../src/clients/coreApiClient');
const { safeTokenMatch } = require('../../../shared/apiHostGuard');

const logger = require('../../config/logger');

function requireOperatorAccess(req, res, next) {
  const authorization = String(req.get?.('authorization') || '');
  const bearer = authorization.toLowerCase().startsWith('bearer ') ? authorization.slice(7).trim() : '';
  const presented = bearer || req.get?.('x-agentx-operator-token') || '';
  if (!safeTokenMatch(process.env.AGENTX_OPERATOR_TOKEN || process.env.AGENTX_ADMIN_TOKEN, presented)) {
    return res.status(403).json({
      status: 'error',
      code: 'PROFILER_OPERATOR_AUTH_REQUIRED',
      error: 'Exact Product operator authentication is required'
    });
  }
  next();
}

// ── In-memory progress tracker for run-all ──────────────────────────────────
const activeTests = new Map();
const TEST_TTL_MS = 30 * 60 * 1000;
function cleanupStale() {
  const now = Date.now();
  for (const [id, test] of activeTests) {
    if (now - test.startedAt > TEST_TTL_MS) activeTests.delete(id);
  }
}

// ── In-memory fleet-queue tracker (sequential test-all across hosts) ────────
const activeFleetQueues = new Map();
const FLEET_TTL_MS = 6 * 60 * 60 * 1000; // 6h: a full fleet sweep can take a while
function cleanupStaleFleets() {
  const now = Date.now();
  for (const [id, q] of activeFleetQueues) {
    if (now - q.startedAt > FLEET_TTL_MS) activeFleetQueues.delete(id);
  }
}
function buildBaselineFromResults(results = [], preferredModel = '') {
  const passing = results.filter(r => r?.status === 'pass');
  if (!passing.length) return null;
  const normalizeModel = n => String(n || '').trim().replace(/:latest$/i, '').toLowerCase();
  const normalizedPreferred = normalizeModel(preferredModel);
  const preferred = normalizedPreferred
    ? passing.find(r => normalizeModel(r.modelName) === normalizedPreferred)
    : null;
  const avg = (arr, key) => Number((arr.reduce((s, r) => s + (r[key] || 0), 0) / arr.length).toFixed(2));
  if (preferred) {
    const hasStreamedTtft = preferred.ttftMeasurement === 'streamed_wall_clock'
      && Number.isFinite(Number(preferred.timeToFirstTokenMs));
    return {
      referenceModel: preferred.modelName,
      tokensPerSec: preferred.tokensPerSec ?? avg(passing, 'tokensPerSec'),
      latencyMs: preferred.latencyMs ?? avg(passing, 'latencyMs'),
      ttftMs: hasStreamedTtft ? Number(preferred.timeToFirstTokenMs) : null,
      ttftMeasurement: hasStreamedTtft ? 'streamed_wall_clock' : undefined,
      testedAt: preferred.testedAt || new Date()
    };
  }
  const newest = [...passing].sort((a, b) => new Date(b.testedAt || 0) - new Date(a.testedAt || 0))[0];
  const streamedTtft = passing.filter(item => item.ttftMeasurement === 'streamed_wall_clock'
    && Number.isFinite(Number(item.timeToFirstTokenMs)));
  return {
    referenceModel: newest?.modelName || 'aggregate',
    tokensPerSec: avg(passing, 'tokensPerSec'),
    latencyMs: avg(passing, 'latencyMs'),
    ttftMs: streamedTtft.length ? avg(streamedTtft, 'timeToFirstTokenMs') : null,
    ttftMeasurement: streamedTtft.length ? 'streamed_wall_clock' : undefined,
    testedAt: newest?.testedAt || new Date()
  };
}

async function updateBaselineUnderLease(hostId, baseline, lease) {
  lease.assertActive();
  const prior = await hostProfileService.getById(hostId);
  lease.assertActive();
  const persistenceReceipt = crypto.randomUUID();
  try {
    const updated = await hostProfileService.updateBaseline(hostId, {
      ...baseline,
      persistenceReceipt
    }, {
      signal: lease.signal,
      assertAuthorityActive: lease.assertActive
    });
    lease.assertActive();
    return updated;
  } catch (error) {
    // Fence the preallocated receipt before restoring the prior value. A late
    // Mongo acknowledgement can no longer republish this unauthorized
    // baseline, and the receipt predicate cannot clobber a newer valid write.
    try {
      await hostProfileService.invalidateBaselineReceipt(
        hostId,
        persistenceReceipt,
        prior?.baseline || null
      );
      error.authorityCompensated = true;
    } catch (compensationError) {
      error.compensationError = compensationError;
      error.retainAdmission = true;
      error.code = 'HOST_BASELINE_RECONCILIATION_PENDING';
      logger.error('Host baseline compensation failed', {
        hostId,
        error: compensationError.message
      });
    }
    if (error.compensationError && typeof lease.abandon === 'function') {
      await lease.abandon(error.compensationError);
    }
    throw error;
  }
}

// ═══ HOST PROFILE — Static routes (MUST come before /:hostId params) ════════

router.get('/', async (req, res) => {
  try { res.json({ status: 'success', data: await hostProfileService.getAll() }); }
  catch (err) { res.status(500).json({ status: 'error', error: err.message }); }
});

/** POST /discover — seed HostProfile docs from env-configured hosts */
router.post('/discover', async (req, res) => {
  try {
    const configured = getConfiguredHosts();
    const results = [];
    for (const h of configured) {
      const status = await hostProfileService.checkStatus(h.url);
      const models = status.models || [];
      const profile = await hostProfileService.upsert({
        hostId: h.id,
        hostUrl: h.url,
        displayName: h.name,
        gpu: { vramTotalMiB: h.vramMb },
        status: status.status,
        lastSeenAt: status.status === 'online' ? new Date() : undefined,
        modelCount: models.length,
        dedicated: status.dedicated || null,
      });
      // Detect CPU cores for local hosts
      const cpuCores = await hostProfileService.detectCpuCores(h.url);
      if (cpuCores) {
        await hostProfileService.upsert({ hostId: h.id, cpu: { cores: cpuCores } });
      }
      results.push(profile);
    }
    res.json({ status: 'success', data: results });
  } catch (err) { res.status(500).json({ status: 'error', error: err.message }); }
});

// ═══ HOST TEST CONFIG (static /test/* — before /:hostId) ════════════════════

/** GET /test/config — baseline model + test parameters */
router.get('/test/config', async (_req, res) => {
  try {
    const svcConfig = getConfig();
    res.json({ status: 'success', data: {
      baselineModel: await baselineModelService.getBaselineModel(),
      timeoutMs: svcConfig.timeoutMs,
      numPredict: svcConfig.numPredict,
      contextFillPct: svcConfig.contextFillPct,
      warmup: svcConfig.warmup,
    }});
  } catch (_) {
    res.status(500).json({ status: 'error', message: 'Unable to resolve profiler baseline configuration' });
  }
});

/** PUT /test/config — save baseline model to DB */
router.put('/test/config', async (req, res) => {
  try {
    const { baselineModel } = req.body;
    const saved = await baselineModelService.setBaselineModel(baselineModel);
    res.json({ status: 'success', data: { baselineModel: saved } });
  } catch (err) { res.status(err.statusCode || 500).json({ status: 'error', error: err.message, message: err.message }); }
});

// ═══ HOST TESTING ═════════════════════════════════════════════════════════���═

/** GET /test/hosts-status — all configured hosts with live connectivity */
router.get('/test/hosts-status', async (_req, res) => {
  try {
    const configured = getConfiguredHosts();
    const results = await Promise.all(
      configured.map(async (host) => {
        const check = await checkHost(host.url);
        return {
          ...host,
          available: check.available,
          latency: check.latency,
          modelCount: check.models.length,
          models: check.models,
          error: check.error || null
        };
      })
    );
    res.json({
      status: 'success',
      data: { hosts: results, total: results.length, available: results.filter(h => h.available).length }
    });
  } catch (err) {
    logger.error('Failed to get hosts status', { error: err.message });
    res.status(500).json({ status: 'error', error: err.message });
  }
});

/** POST /test/ensure-baseline — pull the configured baseline when absent. */
router.post('/test/ensure-baseline', async (req, res) => {
  let lease;
  try {
    const target = baselineModelService.resolveConfiguredHost(req.body?.hostId);
    const operationId = `profiler-baseline-${crypto.randomBytes(8).toString('hex')}`;
    lease = await acquireProfilerClaimLease([target.url], operationId, 30 * 60 * 1000);
    const data = await baselineModelService.ensureBaselineModel(req.body?.hostId, {
      signal: lease.signal,
      assertClaimActive: lease.assertActive,
      operationId
    });
    lease.assertActive();
    await lease.finalize(data.pulled ? {
      beforeWorkloadRelease: () => baselineModelService.resolveBaselineReconciliation(
        req.body?.hostId,
        data.reconciliation,
        { assertClaimActive: lease.assertActive }
      )
    } : {});
    lease = null;
    res.json({
      status: 'success',
      data,
      message: data.pulled
        ? `Pulled ${data.modelName} to ${data.hostName}.`
        : `${data.modelName} is already installed on ${data.hostName}.`
    });
  } catch (err) {
    if (lease && err.retainAdmission === true) {
      await lease.abandon(err);
      lease = null;
    }
    logger.error('Baseline model preparation failed', { hostId: req.body?.hostId, error: err.message });
    res.status(err.statusCode || 502).json({ status: 'error', message: err.message, code: err.code || null });
  } finally {
    if (lease) await lease.finalize().catch(error => logger.error('Baseline lease finalization failed', { error: error.message }));
  }
});

/** POST /test/detect-host — detect an ad-hoc Ollama host and persist it as a HostProfile */
router.post('/test/detect-host', async (req, res) => {
  try {
    const data = await liveProbeService.detectOllamaHost(req.body || {});
    res.json({ status: 'success', data });
  } catch (err) {
    logger.warn('Profiler host detection failed', {
      error: err.message,
      targetProvided: typeof req.body?.hostUrl === 'string' && Boolean(req.body.hostUrl.trim()),
      displayNameProvided: typeof req.body?.displayName === 'string' && Boolean(req.body.displayName.trim())
    });
    res.status(err.statusCode || 500).json({
      status: 'error',
      message: err.message,
      data: err.data || null
    });
  }
});

/** GET /test/live-probes/status — validate live probe readiness for all HostProfiles */
router.get('/test/live-probes/status', async (_req, res) => {
  try {
    const data = await liveProbeService.getLiveProbeStatus();
    res.json({ status: 'success', data });
  } catch (err) {
    logger.error('Live probe status failed', { error: err.message });
    res.status(err.statusCode || 500).json({ status: 'error', message: err.message });
  }
});

/** GET /test/live-probes/:hostId/status — validate live probe readiness for one host */
router.get('/test/live-probes/:hostId/status', async (req, res) => {
  try {
    const data = await liveProbeService.getLiveProbeStatus(req.params.hostId);
    res.json({ status: 'success', data });
  } catch (err) {
    logger.error('Live probe status failed', { hostId: req.params.hostId, error: err.message });
    res.status(err.statusCode || 500).json({ status: 'error', message: err.message });
  }
});

/** POST /test/run — single model test on a host */
router.post('/test/run', async (req, res) => {
  let lease;
  let operationId = null;
  try {
    const { modelName, hostId } = req.body;
    if (!modelName || !hostId) {
      return res.status(400).json({ status: 'error', message: 'modelName and hostId are required' });
    }
    const configuredHost = baselineModelService.resolveConfiguredHost(hostId);
    const baselineModel = await baselineModelService.getBaselineModel();
    const isBaseline = String(modelName).trim().replace(/:latest$/i, '').toLowerCase()
      === String(baselineModel).trim().replace(/:latest$/i, '').toLowerCase();
    operationId = `profiler-host-test-${crypto.randomBytes(8).toString('hex')}`;
    lease = await acquireProfilerClaimLease([configuredHost.url], operationId, 30 * 60 * 1000);
    const preparation = isBaseline && hostId
      ? await baselineModelService.ensureBaselineModel(hostId, {
        signal: lease.signal,
        assertClaimActive: lease.assertActive,
        operationId
      })
      : null;
    const targetHostUrl = preparation?.hostUrl || configuredHost.url;
    const snapshot = await testModelOnHost(modelName, targetHostUrl, {
      hostId,
      benchmarkClaim: lease.identityFor(targetHostUrl),
      assertClaimActive: lease.assertActive,
      signal: lease.signal
    });
    lease.assertActive();
    if (isBaseline && snapshot?.status === 'pass') {
      lease.assertActive();
      await updateBaselineUnderLease(hostId, {
        referenceModel: modelName,
        tokensPerSec: snapshot.tokensPerSec,
        latencyMs: snapshot.latencyMs,
        ttftMs: snapshot.timeToFirstTokenMs,
        ttftMeasurement: snapshot.ttftMeasurement || undefined,
        testedAt: snapshot.testedAt
      }, lease);
    }
    await lease.finalize();
    lease = null;
    res.json({ status: 'success', data: { ...snapshot, preparation } });
  } catch (err) {
    if (lease && err.retainAdmission === true) {
      await lease.abandon(err);
      lease = null;
    }
    logger.error('Host test run failed', { error: err.message, body: req.body });
    const code = err.statusCode || (err.message.includes('not found') ? 422
      : err.message.includes('unreachable') ? 503 : 500);
    res.status(code).json({ status: 'error', message: err.message, code: err.code || null });
  } finally {
    if (lease) {
      await lease.finalize().catch(error => logger.error('Host test lease finalization failed', { error: error.message }));
    }
  }
});

/** POST /test/run-all — test all models on a host (background) */
router.post('/test/run-all', async (req, res) => {
  try {
    const { hostId } = req.body;
    if (!hostId) return res.status(400).json({ status: 'error', message: 'hostId is required' });
    const hostUrl = baselineModelService.resolveConfiguredHost(hostId).url;
    const hostCheck = await checkHost(hostUrl);
    if (!hostCheck.available) return res.status(503).json({ status: 'error', message: `Host unreachable: ${hostCheck.error}` });
    const baselineModel = await baselineModelService.getBaselineModel();
    cleanupStale();
    const testId = crypto.randomBytes(8).toString('hex');
    const tracker = { status: 'running', total: hostCheck.models.length, completed: 0, failed: 0, currentModel: hostCheck.models[0] || null, results: [], startedAt: Date.now() };
    const lease = await acquireProfilerClaimLease([hostUrl], `profiler-host-all-${testId}`, Math.max(10 * 60 * 1000, hostCheck.models.length * 5 * 60 * 1000), {
      onFatal: err => { tracker.status = 'failed'; tracker.error = err.message; }
    });
    activeTests.set(testId, tracker);
    testAllModelsOnHost(hostUrl, {
      hostId,
      benchmarkClaim: lease.identityFor(hostUrl),
      assertClaimActive: lease.assertActive,
      signal: lease.signal,
      shouldAbort: () => lease.lost,
      onProgress: (modelName, result, index, total) => {
        tracker.completed = index + 1;
        tracker.currentModel = index + 1 < total ? hostCheck.models[index + 1] : null;
        if (result.status !== 'pass') tracker.failed++;
        tracker.results.push({ modelName, ...result });
      }
    }).then(async ({ summary }) => {
      lease.assertActive();
      tracker.status = 'completed'; tracker.summary = summary; tracker.currentModel = null;
      const baseline = buildBaselineFromResults(tracker.results, baselineModel);
      if (hostId && baseline) {
        lease.assertActive();
        await updateBaselineUnderLease(hostId, baseline, lease);
      }
    }).catch(err => { tracker.status = 'failed'; tracker.error = err.message; })
      .finally(async () => {
        try {
          await lease.finalize();
        } catch (error) {
          tracker.status = 'failed';
          tracker.error = error.message;
        }
      });
    res.json({ status: 'success', data: { testId, totalModels: hostCheck.models.length, models: hostCheck.models } });
  } catch (err) { res.status(err.statusCode || 500).json({ status: 'error', message: err.message }); }
});

/** GET /test/run-all/:testId/progress */
router.get('/test/run-all/:testId/progress', (req, res) => {
  const tracker = activeTests.get(req.params.testId);
  if (!tracker) return res.status(404).json({ status: 'error', message: 'Test not found or expired' });
  res.json({ status: 'success', data: {
    testStatus: tracker.status, total: tracker.total, completed: tracker.completed,
    failed: tracker.failed, currentModel: tracker.currentModel,
    results: tracker.results, summary: tracker.summary || null, error: tracker.error || null
  }});
});

/** POST /test/run-fleet — sequentially run-all on every selected host */
router.post('/test/run-fleet', async (req, res) => {
  try {
    const { hostIds, includeOffline } = req.body || {};
    const configured = getConfiguredHosts();

    // Resolve target hosts: caller-provided hostIds or all configured.
    let targets = configured;
    if (Array.isArray(hostIds) && hostIds.length) {
      const wanted = new Set(hostIds.map(String));
      targets = configured.filter(h => wanted.has(String(h.id)));
    }

    // Probe connectivity (skip offline unless caller insists)
    const checks = await Promise.all(targets.map(async h => {
      const c = await checkHost(h.url);
      return { host: h, available: c.available, models: c.models, error: c.error || null };
    }));
    const queueHosts = checks.filter(c => includeOffline || c.available);
    if (!queueHosts.length) {
      return res.status(503).json({ status: 'error', message: 'No reachable hosts to queue' });
    }
    const baselineModel = await baselineModelService.getBaselineModel();

    cleanupStaleFleets();
    const queueId = crypto.randomBytes(8).toString('hex');
    const tracker = {
      status: 'running',
      cancelled: false,
      currentIndex: 0,
      totalHosts: queueHosts.length,
      hosts: queueHosts.map(({ host, available, models, error }) => ({
        hostId: host.id,
        hostUrl: host.url,
        displayName: host.name,
        status: available ? 'pending' : 'offline',
        models: models.slice(),
        total: models.length,
        completed: 0,
        failed: 0,
        currentModel: available && models[0] ? models[0] : null,
        results: [],
        summary: null,
        error: available ? null : (error || 'Host unreachable'),
        startedAt: null,
        finishedAt: null
      })),
      summary: null,
      startedAt: Date.now(),
      finishedAt: null,
      error: null
    };
    const lease = await acquireProfilerClaimLease(
      queueHosts.filter(item => item.available).map(item => item.host.url),
      `profiler-fleet-${queueId}`,
      Math.max(30 * 60 * 1000, queueHosts.reduce((sum, item) => sum + item.models.length, 0) * 5 * 60 * 1000),
      { onFatal: err => { tracker.cancelled = true; tracker.error = err.message; } }
    );
    activeFleetQueues.set(queueId, tracker);

    // Fire-and-forget driver
    (async () => {
      for (let i = 0; i < tracker.hosts.length; i++) {
        if (tracker.cancelled || lease.lost) break;
        const slot = tracker.hosts[i];
        tracker.currentIndex = i;
        if (slot.status === 'offline') continue; // skip unreachable hosts
        slot.status = 'running';
        slot.startedAt = Date.now();
        slot.currentModel = slot.models[0] || null;
        try {
          const { summary } = await testAllModelsOnHost(slot.hostUrl, {
            hostId: slot.hostId,
            shouldAbort: () => tracker.cancelled || lease.lost,
            benchmarkClaim: lease.identityFor(slot.hostUrl),
            assertClaimActive: lease.assertActive,
            signal: lease.signal,
            onProgress: (modelName, result, index, total) => {
              slot.completed = index + 1;
              slot.currentModel = index + 1 < total ? slot.models[index + 1] : null;
              if (result?.status !== 'pass') slot.failed++;
              slot.results.push({ modelName, ...result });
            }
          });
          lease.assertActive();
          slot.summary = summary;
          slot.status = 'completed';
          slot.currentModel = null;
          // Update host baseline aggregate (same as /test/run-all)
          const baseline = buildBaselineFromResults(slot.results, baselineModel);
          if (slot.hostId && baseline) {
            lease.assertActive();
            await updateBaselineUnderLease(slot.hostId, baseline, lease);
          }
        } catch (err) {
          slot.status = 'failed';
          slot.error = err.message;
          logger.error('Fleet: host sweep failed', { hostUrl: slot.hostUrl, error: err.message });
        } finally {
          slot.finishedAt = Date.now();
        }
      }

      tracker.finishedAt = Date.now();
      const fleetSummary = tracker.hosts.reduce((acc, h) => {
        acc.modelsTested += h.results.length;
        acc.passed += h.results.filter(r => r.status === 'pass').length;
        acc.failed += h.failed;
        return acc;
      }, { hostsCompleted: tracker.hosts.filter(h => h.status === 'completed').length,
           hostsFailed: tracker.hosts.filter(h => h.status === 'failed').length,
           hostsSkipped: tracker.hosts.filter(h => h.status === 'offline').length,
           modelsTested: 0, passed: 0, failed: 0 });
      tracker.summary = fleetSummary;
      tracker.status = tracker.cancelled ? 'cancelled' : 'completed';
      await lease.finalize();
    })().catch(err => {
      tracker.status = 'failed';
      tracker.error = err.message;
      tracker.finishedAt = Date.now();
      logger.error('Fleet queue driver crashed', { queueId, error: err.message });
      lease.finalize().catch(releaseErr => logger.warn('Fleet claim finalization failed', { queueId, error: releaseErr.message }));
    });

    res.json({ status: 'success', data: {
      queueId,
      totalHosts: tracker.totalHosts,
      hosts: tracker.hosts.map(h => ({
        hostId: h.hostId, hostUrl: h.hostUrl, displayName: h.displayName,
        status: h.status, total: h.total, error: h.error
      }))
    }});
  } catch (err) {
    logger.error('Fleet queue start failed', { error: err.message });
    res.status(500).json({ status: 'error', message: err.message });
  }
});

/** GET /test/run-fleet/:queueId/progress */
router.get('/test/run-fleet/:queueId/progress', (req, res) => {
  const tracker = activeFleetQueues.get(req.params.queueId);
  if (!tracker) return res.status(404).json({ status: 'error', message: 'Queue not found or expired' });
  res.json({ status: 'success', data: {
    queueStatus: tracker.status,
    currentIndex: tracker.currentIndex,
    totalHosts: tracker.totalHosts,
    cancelled: tracker.cancelled,
    summary: tracker.summary,
    error: tracker.error,
    startedAt: tracker.startedAt,
    finishedAt: tracker.finishedAt,
    hosts: tracker.hosts.map(h => ({
      hostId: h.hostId,
      hostUrl: h.hostUrl,
      displayName: h.displayName,
      status: h.status,
      total: h.total,
      completed: h.completed,
      failed: h.failed,
      currentModel: h.currentModel,
      summary: h.summary,
      error: h.error,
      startedAt: h.startedAt,
      finishedAt: h.finishedAt
    }))
  }});
});

/** POST /test/run-fleet/:queueId/cancel — skip remaining hosts (current host runs to completion) */
router.post('/test/run-fleet/:queueId/cancel', (req, res) => {
  const tracker = activeFleetQueues.get(req.params.queueId);
  if (!tracker) return res.status(404).json({ status: 'error', message: 'Queue not found or expired' });
  if (tracker.status !== 'running') {
    return res.json({ status: 'success', data: { queueStatus: tracker.status, cancelled: tracker.cancelled } });
  }
  tracker.cancelled = true;
  res.json({ status: 'success', data: { queueStatus: 'running', cancelled: true } });
});

/** GET /test/run-fleet/active — currently running fleet queues (for page reloads) */
router.get('/test/run-fleet/active', (_req, res) => {
  cleanupStaleFleets();
  const active = [];
  for (const [id, q] of activeFleetQueues) {
    if (q.status === 'running') {
      active.push({
        queueId: id,
        currentIndex: q.currentIndex,
        totalHosts: q.totalHosts,
        startedAt: q.startedAt,
        elapsed: Date.now() - q.startedAt
      });
    }
  }
  res.json({ status: 'success', data: { active } });
});

/** POST /test/compare — test a model across all hosts */
router.post('/test/compare', async (req, res) => {
  let lease;
  try {
    const { modelName } = req.body;
    if (!modelName) return res.status(400).json({ status: 'error', message: 'modelName is required' });
    const checks = await Promise.all(getConfiguredHosts().map(async host => ({ host, check: await checkHost(host.url) })));
    const eligible = checks.filter(item => item.check.available && item.check.models.includes(String(modelName).replace(/:latest$/i, ''))).map(item => item.host.url);
    if (!eligible.length) return res.status(422).json({ status: 'error', message: 'Model is not installed on any reachable host' });
    lease = await acquireProfilerClaimLease(eligible, `profiler-compare-${crypto.randomBytes(8).toString('hex')}`, eligible.length * 10 * 60 * 1000);
    const data = await testModelAcrossHosts(modelName, {
      assertClaimActive: lease.assertActive,
      claimIdentityFor: hostUrl => lease.identityFor(hostUrl),
      signal: lease.signal
    });
    await lease.finalize();
    lease = null;
    res.json({ status: 'success', data });
  } catch (err) { res.status(err.statusCode || 500).json({ status: 'error', message: err.message, code: err.code || null }); }
  finally {
    if (lease) {
      await lease.finalize().catch(error => logger.error('Host comparison lease finalization failed', { error: error.message }));
    }
  }
});

// ═══ CONTEXT PROBE ══════════════════════════════════════════════════════════

/** POST /test/context-probe/run */
router.post('/test/context-probe/run', async (req, res) => {
  let lease;
  try {
    const {
      modelName,
      hostUrl,
      timeoutMs,
      minCtx,
      maxCtx,
      contextProbeFillPct,
      promptFillPct,
      force,
      acknowledgeMaintenance
    } = req.body || {};
    if (!modelName) return res.status(400).json({ status: 'error', message: 'modelName is required' });
    if (!hostUrl) return res.status(400).json({ status: 'error', message: 'hostUrl is required for a claimed context probe' });
    if (acknowledgeMaintenance !== true) {
      return res.status(400).json({
        status: 'error',
        message: 'acknowledgeMaintenance:true is required — probe evicts KV cache and breaks live traffic on the target host'
      });
    }
    const admittedHostUrl = await admitOllamaTargetResolved(hostUrl, { configuredHosts: getConfiguredHosts() });
    lease = await acquireProfilerClaimLease([admittedHostUrl], `profiler-context-${crypto.randomBytes(8).toString('hex')}`, 45 * 60 * 1000);
    const data = await probeModelContext(modelName, {
      hostUrl: admittedHostUrl,
      timeoutMs,
      minCtx,
      maxCtx,
      contextProbeFillPct: contextProbeFillPct ?? promptFillPct,
      force: !!force,
      acknowledgeMaintenance: true,
      assertClaimActive: lease.assertActive,
      signal: lease.signal
    });
    lease.assertActive();
    await lease.finalize();
    lease = null;
    res.json({ status: 'success', data });
  } catch (err) { res.status(err.statusCode || 500).json({ status: 'error', message: err.message, code: err.code || null }); }
  finally {
    if (lease) {
      await lease.finalize().catch(error => logger.error('Context probe lease finalization failed', { error: error.message }));
    }
  }
});

/** GET /test/context-probe/status/:modelName */
router.get('/test/context-probe/status/:modelName', async (req, res) => {
  try {
    res.json({ status: 'success', data: await getProbeStatus(req.params.modelName, { hostUrl: req.query.hostUrl }) });
  } catch (err) { res.status(500).json({ status: 'error', message: err.message }); }
});

/** GET /test/context-probe/resolve/:modelName */
router.get('/test/context-probe/resolve/:modelName', async (req, res) => {
  try {
    res.json({ status: 'success', data: await resolveModelNumCtxDetails(req.params.modelName, { targetHost: req.query.hostUrl, fallback: req.query.fallback }) });
  } catch (err) { res.status(500).json({ status: 'error', message: err.message }); }
});

// ═══ PERFORMANCE RESULTS ════════════════════════════════════════════════════

/**
 * Explicit recovery for an Ollama request whose client connection ended
 * without a terminal server response. Silence is never accepted as proof.
 * An operator may attest a controlled runtime restart, which terminates every
 * request from the prior runtime instance; the durable worker then performs
 * exact host restoration before releasing Core quarantine.
 */
router.post('/test/recovery/:hostId/confirm-runtime-restart', requireOperatorAccess, async (req, res) => {
  try {
    const operationId = String(req.body?.operationId || '');
    const runtimeInstanceId = String(req.body?.runtimeInstanceId || '');
    const restartedAt = new Date(req.body?.restartedAt);
    if (req.body?.confirmation !== 'RUNTIME_RESTARTED_AND_OLLAMA_REQUESTS_TERMINATED'
      || !operationId
      || !runtimeInstanceId
      || !Number.isFinite(restartedAt.getTime())) {
      return res.status(400).json({
        status: 'error',
        code: 'PROFILER_RUNTIME_RESTART_RECEIPT_INVALID',
        error: 'Exact operationId, runtimeInstanceId, restartedAt and typed confirmation are required'
      });
    }
    const current = await HostProfile.findOne({
      hostId: req.params.hostId,
      'reconciliation.operationId': operationId,
      'reconciliation.state': { $in: ['prepared', 'mutating', 'unknown', 'pending_reconciliation'] },
      'reconciliation.serverTerminalObserved': { $ne: true }
    }).lean();
    if (!current) {
      return res.status(409).json({ status: 'error', code: 'PROFILER_RECOVERY_INTENT_NOT_FOUND', error: 'No matching unresolved recovery intent' });
    }
    const receipt = {
      contract: 'agentx.ollama-runtime-restart/v1',
      operationId,
      runtimeInstanceId,
      restartedAt,
      confirmedAt: new Date()
    };
    const updated = await HostProfile.findOneAndUpdate(
      {
        _id: current._id,
        'reconciliation.operationId': operationId,
        'reconciliation.serverTerminalObserved': { $ne: true }
      },
      { $set: {
        'reconciliation.state': 'unknown',
        'reconciliation.serverTerminalObserved': true,
        'reconciliation.serverTerminalAt': restartedAt,
        'reconciliation.operatorTerminalReceipt': receipt,
        'reconciliation.reason': 'Runtime restart attested; awaiting exact fenced restoration'
      } },
      { new: true }
    ).lean();
    if (!updated) {
      return res.status(409).json({ status: 'error', code: 'PROFILER_RECOVERY_INTENT_CHANGED', error: 'Recovery intent changed concurrently' });
    }
    return res.json({ status: 'success', data: { accepted: true, hostId: updated.hostId, operationId, receipt } });
  } catch (error) {
    return res.status(500).json({ status: 'error', code: 'PROFILER_RUNTIME_RESTART_RECOVERY_FAILED', error: error.message });
  }
});

/** GET /test/results — query host performance snapshots */
router.get('/test/results', async (req, res) => {
  try {
    const { hostUrl, hostId, limit: rawLimit } = req.query;
    const limit = Math.min(parseInt(rawLimit, 10) || 100, 500);
    const filter = {
      authorityState: { $nin: ['authority_invalidated', 'pending_reconciliation'] }
    };
    if (hostUrl) filter.hostUrl = hostUrl;
    if (hostId) filter.hostId = hostId;
    const results = await HostPerformanceSnapshot.find(filter).sort({ testedAt: -1 }).limit(limit).lean();
    const passing = results.filter(r => r.status === 'pass');
    const summary = {
      modelsTested: new Set(results.map(r => r.modelName)).size,
      totalSnapshots: results.length,
      avgTps: passing.length ? Number((passing.reduce((s, r) => s + (r.tokensPerSec || 0), 0) / passing.length).toFixed(2)) : 0,
      avgLatency: passing.length ? Math.round(passing.reduce((s, r) => s + (r.latencyMs || 0), 0) / passing.length) : 0
    };
    res.json({ status: 'success', data: { results, summary } });
  } catch (err) { res.status(500).json({ status: 'error', message: err.message }); }
});

/** GET /test/results/:modelName — performance history for a model */
router.get('/test/results/:modelName', async (req, res) => {
  try {
    const snapshots = await HostPerformanceSnapshot.find({
      modelName: req.params.modelName,
      authorityState: { $nin: ['authority_invalidated', 'pending_reconciliation'] }
    }).sort({ testedAt: -1 }).lean();
    res.json({ status: 'success', data: { modelName: req.params.modelName, snapshots, total: snapshots.length } });
  } catch (err) { res.status(500).json({ status: 'error', message: err.message }); }
});

/** POST /:hostId/release — unload a pinned model from a host */
router.post('/:hostId/release', async (req, res) => {
  let lease;
  let host = null;
  let operationId = null;
  try {
    host = await hostProfileService.getById(req.params.hostId);
    if (!host) return res.status(404).json({ status: 'error', error: 'Host not found' });
    if (!host.dedicated?.model) {
      return res.status(400).json({ status: 'error', error: 'Host has no pinned model' });
    }

    operationId = `profiler-release-${crypto.randomBytes(8).toString('hex')}`;
    lease = await acquireProfilerClaimLease([host.hostUrl], operationId, 5 * 60 * 1000);
    const recovery = getWorkloadRecoveryIdentity(operationId);
    if (!recovery?.recoveryId || !recovery?.admissionId) {
      const error = new Error('Release-model requires a durable Core recovery quarantine');
      error.code = 'PROFILER_RELEASE_RECOVERY_QUARANTINE_REQUIRED';
      error.statusCode = 503;
      throw error;
    }
    lease.assertActive();
    await hostProfileService.upsert({
      hostId: req.params.hostId,
      reconciliation: {
        state: 'prepared',
        operation: 'release_model',
        operationId,
        workloadId: operationId,
        admissionId: recovery.admissionId,
        admissionGeneration: recovery.generation,
        admissionPrincipal: recovery.principal,
        recoveryId: recovery.recoveryId,
        recoveryRequestId: recovery.recoveryRequestId,
        model: host.dedicated.model,
        priorDedicated: host.dedicated,
        desiredDedicated: null,
        reason: 'awaiting fenced Core runtime restore receipt',
        startedAt: new Date()
      }
    }, {
      signal: lease.signal,
      assertAuthorityActive: lease.assertActive
    });
    lease.assertActive();
    await hostProfileService.upsert({
      hostId: req.params.hostId,
      reconciliation: {
        ...host.reconciliation,
        state: 'mutating',
        operation: 'release_model',
        operationId,
        workloadId: operationId,
        admissionId: recovery.admissionId,
        admissionGeneration: recovery.generation,
        admissionPrincipal: recovery.principal,
        recoveryId: recovery.recoveryId,
        recoveryRequestId: recovery.recoveryRequestId,
        model: host.dedicated.model,
        priorDedicated: host.dedicated,
        desiredDedicated: null,
        reason: 'Ollama unload request is in flight without a terminal server receipt',
        startedAt: new Date()
      }
    }, { signal: lease.signal, assertAuthorityActive: lease.assertActive });
    lease.assertActive();
    const result = await hostProfileService.releaseModel(host.hostUrl, host.dedicated.model, {
      signal: lease.signal,
      assertClaimActive: lease.assertActive
    });
    try {
      await hostProfileService.upsert({
        hostId: req.params.hostId,
        reconciliation: {
          state: 'verified',
          operation: 'release_model',
          operationId,
          workloadId: operationId,
          admissionId: recovery.admissionId,
          admissionGeneration: recovery.generation,
          admissionPrincipal: recovery.principal,
          recoveryId: recovery.recoveryId,
          recoveryRequestId: recovery.recoveryRequestId,
          model: host.dedicated.model,
          priorDedicated: host.dedicated,
          desiredDedicated: null,
          serverTerminalObserved: result.serverTerminalObserved === true,
          serverTerminalAt: result.serverTerminalAt || new Date(),
          reason: 'awaiting fenced Core runtime restore receipt',
          startedAt: new Date()
        }
      }, {
        signal: lease.signal,
        assertAuthorityActive: lease.assertActive
      });
    } catch (projectionError) {
      projectionError.code = 'PROFILER_RELEASE_RECONCILIATION_PENDING';
      projectionError.statusCode = 503;
      projectionError.retainAdmission = true;
      projectionError.serverTerminalObserved = true;
      throw projectionError;
    }

    const releasedModel = host.dedicated.model;
    const releaseReceipt = await lease.finalize({
      byHost: {
        [host.hostUrl]: { excludedModels: [releasedModel] }
      },
      beforeWorkloadRelease: async hostRelease => {
        const status = await hostProfileService.checkStatus(host.hostUrl);
        if (status.dedicated?.model && isSameOllamaModel(status.dedicated.model, releasedModel)) {
          const error = new Error('Released model became resident again before projection commit');
          error.code = 'PROFILER_RELEASE_NOT_STABLE';
          error.statusCode = 409;
          throw error;
        }
        await hostProfileService.upsert({
          hostId: req.params.hostId,
          status: status.status,
          dedicated: null,
          reconciliation: {
            state: 'resolved',
            operation: 'release_model',
            operationId,
            workloadId: operationId,
            admissionId: recovery.admissionId,
            admissionGeneration: recovery.generation,
            admissionPrincipal: recovery.principal,
            recoveryId: recovery.recoveryId,
            recoveryRequestId: recovery.recoveryRequestId,
            model: releasedModel,
            priorDedicated: host.dedicated,
            desiredDedicated: null,
            releaseReceipt: hostRelease.details?.[0]?.releaseReceipt || null,
            reason: null,
            startedAt: new Date(),
            resolvedAt: new Date()
          }
        }, {
          signal: lease.signal,
          assertAuthorityActive: lease.assertActive
        });
      }
    });
    lease = null;
    const runtimeRestore = releaseReceipt.details?.[0]?.runtimeRestore;
    if (runtimeRestore?.verified !== true) {
      const error = new Error('Core did not verify the requested model remained unloaded');
      error.code = 'PROFILER_RELEASE_NOT_VERIFIED';
      error.statusCode = 503;
      throw error;
    }
    const data = {
      success: true,
      hostId: req.params.hostId,
      releasedModel,
      dedicated: null,
      runtimeRestore
    };
    res.json({ status: 'success', data });
  } catch (err) {
    // The reconciliation marker is written before unloading. If Core restore
    // or the projection commit fails, leave it pending and keep the global
    // admission fenced for recovery; never issue an unfenced compensating
    // write after finalization.
    logger.error('Release model failed', { hostId: req.params.hostId, error: err.message });
    if (lease && err.retainAdmission === true) {
      await lease.abandon(err);
      lease = null;
    }
    res.status(err.statusCode || 500).json({ status: 'error', error: err.message, code: err.code || null });
  } finally {
    if (lease) {
      try {
        await lease.finalize();
      } catch (error) {
        logger.error('Release-model lease finalization failed; reconciliation remains pending', {
          operationId,
          error: error.message
        });
      }
    }
  }
});

// ═══ HOST PROFILE — Param routes (MUST come after /test/* static routes) ════

router.get('/:hostId', async (req, res) => {
  try {
    const host = await hostProfileService.getById(req.params.hostId);
    if (!host) return res.status(404).json({ status: 'error', error: 'Host not found' });
    res.json({ status: 'success', data: host });
  } catch (err) { res.status(500).json({ status: 'error', error: err.message }); }
});

router.get('/:hostId/status', async (req, res) => {
  try {
    const host = await hostProfileService.getById(req.params.hostId);
    if (!host) return res.status(404).json({ status: 'error', error: 'Host not found' });
    // GET is observational only. Live probes update evidence and therefore use
    // the protected POST /status/refresh action below.
    res.json({ status: 'success', data: {
      hostId: req.params.hostId,
      status: host.status || 'unknown',
      lastSeenAt: host.lastSeenAt || null,
      dedicated: host.dedicated || null
    }});
  } catch (err) { res.status(500).json({ status: 'error', error: err.message }); }
});

router.post('/:hostId/status/refresh', async (req, res) => {
  try {
    const host = await hostProfileService.getById(req.params.hostId);
    if (!host) return res.status(404).json({ status: 'error', error: 'Host not found' });
    const status = await hostProfileService.checkStatus(host.hostUrl);
    await hostProfileService.updateStatus(req.params.hostId, status.status);
    await hostProfileService.upsert({
      hostId: req.params.hostId,
      dedicated: status.dedicated || null
    });
    res.json({ status: 'success', data: { hostId: req.params.hostId, ...status } });
  } catch (err) { res.status(500).json({ status: 'error', error: err.message }); }
});

/** GET /:hostId/fit-report — measured + estimated model fit for one host */
router.get('/:hostId/fit-report', async (req, res) => {
  try {
    const data = await hostFitReportService.buildHostFitReport(req.params.hostId);
    res.json({ status: 'success', data });
  } catch (err) {
    logger.error('Host fit report failed', { hostId: req.params.hostId, error: err.message });
    res.status(err.statusCode || 500).json({ status: 'error', message: err.message });
  }
});

router.put('/:hostId', requireOperatorAccess, async (req, res) => {
  try {
    const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {};
    const allowedTopLevel = new Set(['displayName', 'cpu']);
    const rejectedTopLevel = Object.keys(body).filter(field => !allowedTopLevel.has(field));
    const cpu = body.cpu && typeof body.cpu === 'object' && !Array.isArray(body.cpu) ? body.cpu : {};
    const rejectedCpu = Object.keys(cpu).filter(field => field !== 'threadOverride');
    if (rejectedTopLevel.length || rejectedCpu.length) {
      return res.status(400).json({
        status: 'error',
        code: 'HOST_PROFILE_FIELD_NOT_WRITABLE',
        error: 'Only displayName and cpu.threadOverride may be changed through this route',
        fields: [...rejectedTopLevel, ...rejectedCpu.map(field => `cpu.${field}`)]
      });
    }
    const updates = {};
    if (Object.prototype.hasOwnProperty.call(body, 'displayName')) {
      const displayName = String(body.displayName || '').trim();
      if (!displayName) {
        return res.status(400).json({ status: 'error', code: 'HOST_PROFILE_DISPLAY_NAME_INVALID', error: 'displayName must be non-empty' });
      }
      updates.displayName = displayName;
    }
    if (Object.prototype.hasOwnProperty.call(body, 'cpu')) {
      const threadOverride = Number(cpu.threadOverride);
      if (!Number.isInteger(threadOverride) || threadOverride <= 0 || threadOverride > 1024) {
        return res.status(400).json({ status: 'error', code: 'HOST_PROFILE_THREAD_OVERRIDE_INVALID', error: 'cpu.threadOverride must be an integer from 1 to 1024' });
      }
      updates.cpu = { threadOverride };
    }
    res.json({ status: 'success', data: await hostProfileService.upsert({ ...updates, hostId: req.params.hostId }) }); }
  catch (err) { res.status(err.statusCode || 500).json({ status: 'error', error: err.message }); }
});

router.post('/:hostId/sync', async (req, res) => {
  try {
    const host = await hostProfileService.getById(req.params.hostId);
    if (!host) return res.status(404).json({ status: 'error', error: 'Host not found' });
    res.json({ status: 'success', data: await modelDiscoveryService.syncHostModels(host.hostUrl, req.params.hostId) });
  } catch (err) { res.status(500).json({ status: 'error', error: err.message }); }
});

module.exports = router;
