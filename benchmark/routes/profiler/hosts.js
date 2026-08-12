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
const { getDedicationStatuses, resolveHostKey, restoreDedication } = require('../../src/clients/coreApiClient');

const logger = require('../../config/logger');

// ── Dedication restore helper ───────────────────────────────────────────────
// After host tests or profiling, restore pinned models that may have been displaced.
async function _restoreDedicationForHost(hostUrl) {
  try {
    const statuses = await getDedicationStatuses();
    const normalized = hostUrl.replace(/\/+$/, '');
    const match = statuses.find(s => s.host?.replace(/\/+$/, '') === normalized);
    if (!match?.pinnedModels?.length) return;
    const hostKey = await resolveHostKey(hostUrl);
    if (!hostKey) return;
    await restoreDedication(hostKey);
    logger.info('Dedication restored after host test', { host: hostUrl, hostKey, pinnedModels: match.pinnedModels });
  } catch (err) {
    logger.debug('Dedication restore skipped', { host: hostUrl, error: err.message });
  }
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
    return {
      referenceModel: preferred.modelName,
      tokensPerSec: preferred.tokensPerSec ?? avg(passing, 'tokensPerSec'),
      latencyMs: preferred.latencyMs ?? avg(passing, 'latencyMs'),
      ttftMs: preferred.timeToFirstTokenMs ?? avg(passing, 'timeToFirstTokenMs'),
      testedAt: preferred.testedAt || new Date()
    };
  }
  const newest = [...passing].sort((a, b) => new Date(b.testedAt || 0) - new Date(a.testedAt || 0))[0];
  return {
    referenceModel: newest?.modelName || 'aggregate',
    tokensPerSec: avg(passing, 'tokensPerSec'),
    latencyMs: avg(passing, 'latencyMs'),
    ttftMs: avg(passing, 'timeToFirstTokenMs'),
    testedAt: newest?.testedAt || new Date()
  };
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
  try {
    const data = await baselineModelService.ensureBaselineModel(req.body?.hostId);
    res.json({
      status: 'success',
      data,
      message: data.pulled
        ? `Pulled ${data.modelName} to ${data.hostName}.`
        : `${data.modelName} is already installed on ${data.hostName}.`
    });
  } catch (err) {
    logger.error('Baseline model preparation failed', { hostId: req.body?.hostId, error: err.message });
    res.status(err.statusCode || 502).json({ status: 'error', message: err.message });
  }
});

/** POST /test/detect-host — detect an ad-hoc Ollama host and persist it as a HostProfile */
router.post('/test/detect-host', async (req, res) => {
  try {
    const data = await liveProbeService.detectOllamaHost(req.body || {});
    res.json({ status: 'success', data });
  } catch (err) {
    logger.warn('Profiler host detection failed', { error: err.message, body: req.body });
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
  try {
    const { modelName, hostId } = req.body;
    if (!modelName || !hostId) {
      return res.status(400).json({ status: 'error', message: 'modelName and hostId are required' });
    }
    const configuredHost = baselineModelService.resolveConfiguredHost(hostId);
    const baselineModel = await baselineModelService.getBaselineModel();
    const isBaseline = String(modelName).trim().replace(/:latest$/i, '').toLowerCase()
      === String(baselineModel).trim().replace(/:latest$/i, '').toLowerCase();
    const preparation = isBaseline && hostId
      ? await baselineModelService.ensureBaselineModel(hostId)
      : null;
    const targetHostUrl = preparation?.hostUrl || configuredHost.url;
    const snapshot = await testModelOnHost(modelName, targetHostUrl, { hostId });
    if (isBaseline && snapshot?.status === 'pass') {
      await hostProfileService.updateBaseline(hostId, {
        referenceModel: modelName,
        tokensPerSec: snapshot.tokensPerSec,
        latencyMs: snapshot.latencyMs,
        ttftMs: snapshot.timeToFirstTokenMs,
        testedAt: snapshot.testedAt
      }).catch(err => logger.warn('Failed to update baseline', { hostId, error: err.message }));
    }
    // Restore dedication if the host has pinned models (fire-and-forget)
    _restoreDedicationForHost(targetHostUrl);
    res.json({ status: 'success', data: { ...snapshot, preparation } });
  } catch (err) {
    logger.error('Host test run failed', { error: err.message, body: req.body });
    const code = err.statusCode || (err.message.includes('not found') ? 422
      : err.message.includes('unreachable') ? 503 : 500);
    res.status(code).json({ status: 'error', message: err.message });
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
    activeTests.set(testId, tracker);
    testAllModelsOnHost(hostUrl, {
      hostId,
      onProgress: (modelName, result, index, total) => {
        tracker.completed = index + 1;
        tracker.currentModel = index + 1 < total ? hostCheck.models[index + 1] : null;
        if (result.status !== 'pass') tracker.failed++;
        tracker.results.push({ modelName, ...result });
      }
    }).then(({ summary }) => {
      tracker.status = 'completed'; tracker.summary = summary; tracker.currentModel = null;
      const baseline = buildBaselineFromResults(tracker.results, baselineModel);
      if (hostId && baseline) {
        hostProfileService.updateBaseline(hostId, baseline)
          .catch(err => logger.warn('Failed to update baseline after run-all', { hostId, error: err.message }));
      }
    }).catch(err => { tracker.status = 'failed'; tracker.error = err.message; });
    res.json({ status: 'success', data: { testId, totalModels: hostCheck.models.length, models: hostCheck.models } });
  } catch (err) { res.status(500).json({ status: 'error', message: err.message }); }
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
    activeFleetQueues.set(queueId, tracker);

    // Fire-and-forget driver
    (async () => {
      for (let i = 0; i < tracker.hosts.length; i++) {
        if (tracker.cancelled) break;
        const slot = tracker.hosts[i];
        tracker.currentIndex = i;
        if (slot.status === 'offline') continue; // skip unreachable hosts
        slot.status = 'running';
        slot.startedAt = Date.now();
        slot.currentModel = slot.models[0] || null;
        try {
          const { summary } = await testAllModelsOnHost(slot.hostUrl, {
            hostId: slot.hostId,
            shouldAbort: () => tracker.cancelled,
            onProgress: (modelName, result, index, total) => {
              slot.completed = index + 1;
              slot.currentModel = index + 1 < total ? slot.models[index + 1] : null;
              if (result?.status !== 'pass') slot.failed++;
              slot.results.push({ modelName, ...result });
            }
          });
          slot.summary = summary;
          slot.status = 'completed';
          slot.currentModel = null;
          // Update host baseline aggregate (same as /test/run-all)
          const baseline = buildBaselineFromResults(slot.results, baselineModel);
          if (slot.hostId && baseline) {
            hostProfileService.updateBaseline(slot.hostId, baseline)
              .catch(err => logger.warn('Fleet: baseline update failed', { hostId: slot.hostId, error: err.message }));
          }
          // Restore any pinned model the sweep may have evicted
          _restoreDedicationForHost(slot.hostUrl);
        } catch (err) {
          slot.status = 'failed';
          slot.error = err.message;
          logger.error('Fleet: host sweep failed', { hostUrl: slot.hostUrl, error: err.message });
          _restoreDedicationForHost(slot.hostUrl);
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
    })().catch(err => {
      tracker.status = 'failed';
      tracker.error = err.message;
      tracker.finishedAt = Date.now();
      logger.error('Fleet queue driver crashed', { queueId, error: err.message });
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
  try {
    const { modelName } = req.body;
    if (!modelName) return res.status(400).json({ status: 'error', message: 'modelName is required' });
    res.json({ status: 'success', data: await testModelAcrossHosts(modelName) });
  } catch (err) { res.status(500).json({ status: 'error', message: err.message }); }
});

// ═══ CONTEXT PROBE ══════════════════════════════════════════════════════════

/** POST /test/context-probe/run */
router.post('/test/context-probe/run', async (req, res) => {
  try {
    const {
      modelName,
      hostUrl,
      degradationPct,
      timeoutMs,
      minCtx,
      maxCtx,
      contextProbeFillPct,
      promptFillPct,
      force,
      acknowledgeMaintenance
    } = req.body || {};
    if (!modelName) return res.status(400).json({ status: 'error', message: 'modelName is required' });
    if (acknowledgeMaintenance !== true) {
      return res.status(400).json({
        status: 'error',
        message: 'acknowledgeMaintenance:true is required — probe evicts KV cache and breaks live traffic on the target host'
      });
    }
    res.json({ status: 'success', data: await probeModelContext(modelName, {
      hostUrl,
      degradationPct,
      timeoutMs,
      minCtx,
      maxCtx,
      contextProbeFillPct: contextProbeFillPct ?? promptFillPct,
      force: !!force,
      acknowledgeMaintenance: true
    }) });
  } catch (err) { res.status(500).json({ status: 'error', message: err.message }); }
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

/** GET /test/results — query host performance snapshots */
router.get('/test/results', async (req, res) => {
  try {
    const { hostUrl, hostId, limit: rawLimit } = req.query;
    const limit = Math.min(parseInt(rawLimit, 10) || 100, 500);
    const filter = {};
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
    const snapshots = await HostPerformanceSnapshot.find({ modelName: req.params.modelName }).sort({ testedAt: -1 }).lean();
    res.json({ status: 'success', data: { modelName: req.params.modelName, snapshots, total: snapshots.length } });
  } catch (err) { res.status(500).json({ status: 'error', message: err.message }); }
});

/** POST /:hostId/release — unload a pinned model from a host */
router.post('/:hostId/release', async (req, res) => {
  try {
    const host = await hostProfileService.getById(req.params.hostId);
    if (!host) return res.status(404).json({ status: 'error', error: 'Host not found' });
    if (!host.dedicated?.model) {
      return res.status(400).json({ status: 'error', error: 'Host has no pinned model' });
    }

    const result = await hostProfileService.releaseModel(host.hostUrl, host.dedicated.model);
    if (!result.success) {
      return res.status(502).json({ error: `Failed to release model: ${result.error}` });
    }

    // Clear dedicated state
    await hostProfileService.upsert({ hostId: req.params.hostId, dedicated: null });

    // Re-check status to confirm
    const status = await hostProfileService.checkStatus(host.hostUrl);
    await hostProfileService.updateStatus(req.params.hostId, status.status);
    await hostProfileService.upsert({ hostId: req.params.hostId, dedicated: status.dedicated || null });

    res.json({ status: 'success', data: {
      success: true,
      hostId: req.params.hostId,
      releasedModel: host.dedicated.model,
      dedicated: status.dedicated || null
    }});
  } catch (err) {
    logger.error('Release model failed', { hostId: req.params.hostId, error: err.message });
    res.status(500).json({ status: 'error', error: err.message });
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

router.put('/:hostId', async (req, res) => {
  try {
    res.json({ status: 'success', data: await hostProfileService.upsert({ ...req.body, hostId: req.params.hostId }) }); }
  catch (err) { res.status(500).json({ status: 'error', error: err.message }); }
});

router.post('/:hostId/sync', async (req, res) => {
  try {
    const host = await hostProfileService.getById(req.params.hostId);
    if (!host) return res.status(404).json({ status: 'error', error: 'Host not found' });
    res.json({ status: 'success', data: await modelDiscoveryService.syncHostModels(host.hostUrl, req.params.hostId) });
  } catch (err) { res.status(500).json({ status: 'error', error: err.message }); }
});

module.exports = router;
