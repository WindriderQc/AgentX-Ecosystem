const express = require('express');
const crypto = require('crypto');
const router = express.Router();
const orchestrator = require('../../src/services/profiler/profilerOrchestrator');
const hostProfileService = require('../../src/services/profiler/hostProfileService');
const modelProfileService = require('../../src/services/profiler/modelProfileService');
const { checkHost } = require('../../src/services/hostTestService');
const {
  activeProfiles,
  activeProfileQueues,
  cleanupStaleProfiles,
  cleanupStaleProfileQueues,
  listActiveProfiles,
  listActiveProfileQueues
} = require('../../src/services/profiler/activeProfileState');
const {
  getDedicationStatuses,
  resolveHostKey,
  restoreDedication,
  claimHostForBenchmark,
  releaseBenchmarkClaim
} = require('../../src/clients/coreApiClient');
const logger = require('../../config/logger');

const STEPS_BY_DEPTH = {
  quick:    ['warmup', 'throughput', 'spill_detection', 'thinking_behavior', 'saving'],
  standard: ['warmup', 'throughput', 'spill_detection', 'thinking_behavior', 'context_probe', 'saving'],
  full:     ['warmup', 'throughput', 'spill_detection', 'thinking_behavior', 'context_probe', 'throughput_curve', 'generation_stability', 'load_timing', 'saving']
};

// Rough upper bound on how long a profile run can take — used by the
// host-preference claim so core's scheduler doesn't reap our claim mid-run.
const ESTIMATED_DURATION_MS_BY_DEPTH = {
  quick:    5  * 60 * 1000,
  standard: 30 * 60 * 1000,
  full:     45 * 60 * 1000
};

async function _restoreDedicationForHost(hostUrl) {
  try {
    const statuses = await getDedicationStatuses();
    const normalized = hostUrl.replace(/\/+$/, '');
    const match = statuses.find(s => s.host?.replace(/\/+$/, '') === normalized);
    if (!match?.pinnedModels?.length) return;
    const hostKey = await resolveHostKey(hostUrl);
    if (!hostKey) return;
    await restoreDedication(hostKey);
    logger.info('Dedication restored after profiling', { host: hostUrl, hostKey });
  } catch (err) {
    logger.debug('Dedication restore skipped', { host: hostUrl, error: err.message });
  }
}

router.post('/scout', async (req, res) => {
  try {
    const { modelName, hosts } = req.body;
    if (!modelName || !hosts?.length) return res.status(400).json({ status: 'error', error: 'modelName and hosts[] required' });
    res.json({ status: 'success', data: await orchestrator.scout(modelName, hosts) });
  } catch (err) { res.status(500).json({ status: 'error', error: err.message }); }
});

router.post('/profile', async (req, res) => {
  try {
    const { modelName, hostId, depth } = req.body;
    if (!modelName || !hostId) return res.status(400).json({ status: 'error', error: 'modelName and hostId required' });
    const host = await hostProfileService.getById(hostId);
    if (!host) return res.status(404).json({ status: 'error', error: 'Host not found' });

    cleanupStaleProfiles();

    // Guard: reject concurrent profile jobs on the same host
    for (const [existingId, job] of activeProfiles) {
      if (job.hostId === hostId && job.status === 'running') {
        return res.status(409).json({
          status: 'error',
          error: `Host ${hostId} already has an active profile job (${job.modelName}, id=${existingId}). Wait for it to complete or check /pipeline/profile/active.`
        });
      }
    }

    const profileId = crypto.randomBytes(8).toString('hex');
    const steps = STEPS_BY_DEPTH[depth] || STEPS_BY_DEPTH.standard;
    const claimBatchId = `profile-${profileId}`;
    const estimatedDurationMs = ESTIMATED_DURATION_MS_BY_DEPTH[depth] || ESTIMATED_DURATION_MS_BY_DEPTH.standard;

    // Register the tracker BEFORE the first await so a concurrent POST for the
    // same host hits the guard above instead of racing past it (the guard and
    // this set must happen in the same synchronous slice).
    const tracker = {
      status: 'running',
      modelName,
      hostId,
      hostUrl: host.hostUrl,
      depth: depth || 'standard',
      currentStep: steps[0],
      statusMessage: 'Claiming host…',
      stepsCompleted: 0,
      stepsTotal: steps.length,
      steps,
      metrics: {},
      startedAt: Date.now(),
      result: null,
      error: null
    };
    // Reserve the slot NOW, synchronously — no await sits between the
    // concurrent-profile guard above and this set, so two simultaneous
    // /profile requests for the same host can no longer both pass the guard
    // (TOCTOU: previously the claim await sat between check and set).
    activeProfiles.set(profileId, tracker);

    // Claim the host before we touch it. Without this, core's scheduler keeps
    // restoring the pinned default model in parallel with the profiler's
    // unload/load sequence — the warm-up generate gets queued behind a pinned
    // reload and times out. Claim flips host status to "benchmarking", which
    // the scheduler treats as hands-off until we release it.
    //
    // A REJECTED claim means someone else (usually a benchmark batch) holds
    // the host. Profiling anyway would unload the batch's working set and
    // corrupt its results, so it is a hard abort. A claim CALL failure means
    // core is unreachable — no scheduler is restoring pins and no batch can
    // hold a claim, so standalone profiling may proceed.
    try {
      const claim = await claimHostForBenchmark(host.hostUrl, claimBatchId, estimatedDurationMs);
      if (!claim.claimed) {
        activeProfiles.delete(profileId);
        logger.warn('Profile: host claim rejected — aborting', {
          hostUrl: host.hostUrl, reason: claim.reason
        });
        return res.status(409).json({
          status: 'error',
          error: `Host ${hostId} is reserved (${claim.reason || 'claimed by another job'}). ` +
            'A benchmark or another profiler run holds this host — wait for it to finish and retry.',
          reason: claim.reason || null,
          conflict: 'host_claimed'
        });
      }
    } catch (err) {
      logger.warn('Profile: host claim call failed (core unreachable) — proceeding unclaimed', {
        hostUrl: host.hostUrl, error: err.message
      });
    }
    tracker.statusMessage = 'Starting…';

    // Fire-and-forget
    orchestrator.profile(modelName, hostId, host.hostUrl, depth || 'standard', {
      onProgress: (step, data) => {
        const idx = steps.indexOf(step);
        if (idx >= 0) tracker.stepsCompleted = idx;
        tracker.currentStep = step;
        if (data?.message) tracker.statusMessage = data.message;
        if (data) {
          const { message, ...rest } = data;
          Object.assign(tracker.metrics, rest);
        }
      }
    }).then(result => {
      tracker.status = 'completed';
      tracker.stepsCompleted = steps.length;
      tracker.currentStep = null;
      tracker.result = result;
    }).catch(err => {
      tracker.status = 'failed';
      tracker.error = err.message;
      logger.error('Profile job failed', { profileId, modelName, hostId, error: err.message });
    }).finally(async () => {
      // Release the claim first so the host returns to its prior status
      // (typically 'ready' with pinned defaults). Then call restoreDedication
      // to trigger the actual model reload on the host. Both paths run on
      // success and failure — a failed profile must not leave the host
      // stuck in 'benchmarking' status.
      try {
        await releaseBenchmarkClaim(host.hostUrl, claimBatchId);
      } catch (releaseErr) {
        logger.warn('Profile: failed to release host claim', {
          hostUrl: host.hostUrl, profileId, error: releaseErr.message
        });
      }
      _restoreDedicationForHost(host.hostUrl);
    });

    res.json({ status: 'success', data: { profileId } });
  } catch (err) { res.status(500).json({ status: 'error', error: err.message }); }
});

// List active profiles (for detecting externally-started profiles)
// Must be before :profileId param route
router.get('/profile/active', (req, res) => {
  const active = listActiveProfiles();
  res.json({ status: 'success', data: { active } });
});

router.get('/profile/:profileId/progress', (req, res) => {
  const tracker = activeProfiles.get(req.params.profileId);
  if (!tracker) return res.status(404).json({ status: 'error', error: 'Profile not found or expired' });
  res.json({ status: 'success', data: {
    profileStatus: tracker.status,
    modelName: tracker.modelName,
    hostId: tracker.hostId,
    hostUrl: tracker.hostUrl || null,
    depth: tracker.depth,
    currentStep: tracker.currentStep,
    statusMessage: tracker.statusMessage,
    stepsCompleted: tracker.stepsCompleted,
    stepsTotal: tracker.stepsTotal,
    metrics: tracker.metrics,
    startedAt: tracker.startedAt,
    elapsed: Date.now() - tracker.startedAt,
    result: tracker.result,
    error: tracker.error
  }});
});

// ── Per-host profile queue ─────────────────────────────────────────────────

/**
 * Run a single profile inside a queue, populating the same activeProfiles
 * tracker the per-model UI watches so existing frontend reattach logic works.
 * Returns the profile result (resolves on success, throws on failure).
 */
async function _queueRunSingleProfile(modelName, hostId, hostUrl, depth) {
  const profileId = crypto.randomBytes(8).toString('hex');
  const steps = STEPS_BY_DEPTH[depth] || STEPS_BY_DEPTH.standard;
  const claimBatchId = `profile-${profileId}`;
  const estimatedDurationMs = ESTIMATED_DURATION_MS_BY_DEPTH[depth] || ESTIMATED_DURATION_MS_BY_DEPTH.standard;

  // Same claim policy as POST /profile: rejection is a hard stop (the host is
  // reserved by another job and profiling would evict its models); a claim
  // call failure means core is unreachable, so proceed unclaimed.
  let claimHeld = false;
  try {
    const claim = await claimHostForBenchmark(hostUrl, claimBatchId, estimatedDurationMs);
    if (!claim.claimed) {
      logger.warn('Queue profile: host claim rejected — stopping queue', { hostUrl, reason: claim.reason });
      throw Object.assign(
        new Error(`Host is reserved (${claim.reason || 'claimed by another job'})`),
        { claimRejected: true, reason: claim.reason || null }
      );
    }
    claimHeld = true;
  } catch (err) {
    if (err.claimRejected) throw err;
    logger.warn('Queue profile: host claim call failed (core unreachable) — proceeding unclaimed', { hostUrl, error: err.message });
  }

  const tracker = {
    status: 'running',
    modelName, hostId, depth,
    hostUrl,
    currentStep: steps[0],
    statusMessage: 'Starting…',
    stepsCompleted: 0,
    stepsTotal: steps.length,
    steps,
    metrics: {},
    startedAt: Date.now(),
    result: null,
    error: null,
    queued: true
  };
  activeProfiles.set(profileId, tracker);

  try {
    const result = await orchestrator.profile(modelName, hostId, hostUrl, depth, {
      onProgress: (step, data) => {
        const idx = steps.indexOf(step);
        if (idx >= 0) tracker.stepsCompleted = idx;
        tracker.currentStep = step;
        if (data?.message) tracker.statusMessage = data.message;
        if (data) {
          const { message, ...rest } = data;
          Object.assign(tracker.metrics, rest);
        }
      }
    });
    tracker.status = 'completed';
    tracker.stepsCompleted = steps.length;
    tracker.currentStep = null;
    tracker.result = result;
    return { profileId, result };
  } catch (err) {
    tracker.status = 'failed';
    tracker.error = err.message;
    throw err;
  } finally {
    if (claimHeld) {
      try {
        await releaseBenchmarkClaim(hostUrl, claimBatchId);
      } catch (releaseErr) {
        logger.warn('Queue profile: failed to release host claim', { hostUrl, profileId, error: releaseErr.message });
      }
    }
    _restoreDedicationForHost(hostUrl);
  }
}

/**
 * POST /pipeline/profile-host
 * Body: { hostId, depth?, skipRecentDays?, modelNames? }
 *   - depth: quick | standard | full (default standard)
 *   - skipRecentDays: skip models whose readiness[hostId].profiledAt is within N days (default 7; 0 = profile all)
 *   - modelNames: optional explicit list; if omitted, uses live host inventory
 */
/**
 * Start a per-host profile queue. Extracted verbatim from the POST
 * /profile-host route body so the sweep run driver (routes/benchmark/sweeps.js)
 * can reuse the EXACT same logic. Returns the queue descriptor on success;
 * throws an Error carrying `.statusCode` (and optional `.payload`) on
 * validation/conflict failures, which the route maps to an HTTP response.
 */
async function startProfileHostQueue(body = {}) {
  const { hostId, depth, skipRecentDays, modelNames } = body;
  if (!hostId) throw Object.assign(new Error('hostId is required'), { statusCode: 400 });

  const host = await hostProfileService.getById(hostId);
  if (!host) throw Object.assign(new Error('Host not found'), { statusCode: 404 });

  cleanupStaleProfiles();
  cleanupStaleProfileQueues();

  // Reject if host already has an active profile (single or queued)
  for (const [existingId, job] of activeProfiles) {
    if (job.hostId === hostId && job.status === 'running') {
      throw Object.assign(new Error(`Host ${hostId} already has an active profile job (${job.modelName}, id=${existingId}). Wait for it to complete before queueing.`), { statusCode: 409 });
    }
  }
  for (const [existingId, q] of activeProfileQueues) {
    if (q.hostId === hostId && q.status === 'running') {
      throw Object.assign(new Error(`Host ${hostId} already has an active profile queue (id=${existingId}).`), { statusCode: 409 });
    }
  }

  // Reserve the queue slot BEFORE the first await below so a concurrent
  // start for the same host hits the guard above instead of racing past it.
  // Validation failures delete the reservation.
  const queueId = crypto.randomBytes(8).toString('hex');
  const chosenDepth = STEPS_BY_DEPTH[depth] ? depth : 'standard';
  const skipDays = Number.isFinite(Number(skipRecentDays)) ? Number(skipRecentDays) : 7;
  const tracker = {
    queueId,
    hostId,
    hostUrl: host.hostUrl,
    hostName: host.displayName || hostId,
    depth: chosenDepth,
    skipRecentDays: skipDays,
    status: 'running',
    cancelled: false,
    currentIndex: 0,
    total: 0,
    models: [],
    skippedRecent: [],
    startedAt: Date.now(),
    finishedAt: null,
    summary: null,
    error: null
  };
  activeProfileQueues.set(queueId, tracker);

  let candidates;
  let notOnHost = [];
  let skippedRecent = [];
  try {
    // Resolve model list and intersect with host inventory to drop ghosts
    const probe = await checkHost(host.hostUrl);
    if (!probe.available) throw Object.assign(new Error(`Host unreachable: ${probe.error}`), { statusCode: 503 });
    const inventory = new Set((probe.models || []).map(String));
    if (Array.isArray(modelNames) && modelNames.length) {
      const requested = modelNames.map(String);
      candidates = requested.filter(n => inventory.has(n));
      notOnHost = requested.filter(n => !inventory.has(n));
    } else {
      candidates = [...inventory];
    }
    if (!candidates.length) {
      throw Object.assign(new Error(notOnHost.length
        ? `None of the requested models are on this host (${notOnHost.length} not found)`
        : 'No models to profile on this host'), { statusCode: 400, payload: { notOnHost } });
    }

    // Skip-recent filter
    const cutoffMs = skipDays > 0 ? Date.now() - skipDays * 24 * 60 * 60 * 1000 : null;
    if (cutoffMs) {
      const profiles = await modelProfileService.getAll();
      const profileMap = new Map(profiles.map(p => [p.name, p]));
      candidates = candidates.filter(name => {
        const p = profileMap.get(name);
        const readiness = p?.readiness instanceof Map ? Object.fromEntries(p.readiness) : (p?.readiness || {});
        const profiledAt = readiness?.[hostId]?.profiledAt;
        if (profiledAt && new Date(profiledAt).getTime() >= cutoffMs) {
          skippedRecent.push(name);
          return false;
        }
        return true;
      });
    }
    if (!candidates.length) {
      throw Object.assign(new Error(`All models on this host were profiled within the last ${skipDays} days. Pass skipRecentDays:0 to force re-profiling.`), { statusCode: 400, payload: { skippedRecent } });
    }
  } catch (err) {
    activeProfileQueues.delete(queueId);
    throw err;
  }

  tracker.total = candidates.length;
  tracker.models = candidates.map(name => ({ name, status: 'pending', error: null, startedAt: null, finishedAt: null }));
  tracker.skippedRecent = skippedRecent;

  // Fire-and-forget driver
  (async () => {
    for (let i = 0; i < tracker.models.length; i++) {
      if (tracker.cancelled) break;
      const slot = tracker.models[i];
      tracker.currentIndex = i;
      slot.status = 'running';
      slot.startedAt = Date.now();
      try {
        await _queueRunSingleProfile(slot.name, hostId, host.hostUrl, chosenDepth);
        slot.status = 'completed';
      } catch (err) {
        slot.status = 'failed';
        slot.error = err.message;
        if (err.claimRejected) {
          // The host is reserved by another job; every remaining model targets
          // the same host, so stop instead of failing them one by one.
          tracker.error = err.message;
          tracker.cancelled = true;
          logger.warn('Profile queue: host claim rejected, stopping queue', { hostId, model: slot.name, reason: err.reason });
        } else {
          logger.warn('Profile queue: model failed, continuing', { hostId, model: slot.name, error: err.message });
        }
      } finally {
        slot.finishedAt = Date.now();
      }
    }
    tracker.finishedAt = Date.now();
    const completed = tracker.models.filter(m => m.status === 'completed').length;
    const failed = tracker.models.filter(m => m.status === 'failed').length;
    const skipped = tracker.models.filter(m => m.status === 'pending').length;
    tracker.summary = { total: tracker.models.length, completed, failed, skipped };
    tracker.status = tracker.cancelled ? 'cancelled' : (failed && !completed ? 'failed' : 'completed');
  })().catch(err => {
    tracker.status = 'failed';
    tracker.error = err.message;
    tracker.finishedAt = Date.now();
    logger.error('Profile queue driver crashed', { queueId, error: err.message });
  });

  return { queueId, hostId, depth: chosenDepth, total: candidates.length, models: candidates, skippedRecent, notOnHost };
}

router.post('/profile-host', async (req, res) => {
  try {
    const data = await startProfileHostQueue(req.body || {});
    res.json({ status: 'success', data });
  } catch (err) {
    const code = err.statusCode || 500;
    if (code === 500) logger.error('Profile queue start failed', { error: err.message });
    res.status(code).json({ status: 'error', error: err.message, ...(err.payload || {}) });
  }
});

/** GET /pipeline/profile-host/active — running per-host profile queues */
router.get('/profile-host/active', (_req, res) => {
  const active = listActiveProfileQueues();
  res.json({ status: 'success', data: { active } });
});

/** GET /pipeline/profile-host/:queueId/progress */
router.get('/profile-host/:queueId/progress', (req, res) => {
  const tracker = activeProfileQueues.get(req.params.queueId);
  if (!tracker) return res.status(404).json({ status: 'error', error: 'Queue not found or expired' });
  res.json({ status: 'success', data: {
    queueStatus: tracker.status,
    hostId: tracker.hostId,
    hostName: tracker.hostName,
    depth: tracker.depth,
    cancelled: tracker.cancelled,
    currentIndex: tracker.currentIndex,
    total: tracker.total,
    models: tracker.models,
    skippedRecent: tracker.skippedRecent,
    startedAt: tracker.startedAt,
    finishedAt: tracker.finishedAt,
    summary: tracker.summary,
    error: tracker.error
  }});
});

/** POST /pipeline/profile-host/:queueId/cancel — flag cancellation; current model finishes */
router.post('/profile-host/:queueId/cancel', (req, res) => {
  const tracker = activeProfileQueues.get(req.params.queueId);
  if (!tracker) return res.status(404).json({ status: 'error', error: 'Queue not found or expired' });
  if (tracker.status !== 'running') {
    return res.json({ status: 'success', data: { queueStatus: tracker.status, cancelled: tracker.cancelled } });
  }
  tracker.cancelled = true;
  res.json({ status: 'success', data: { queueStatus: 'running', cancelled: true } });
});

router.post('/adapt', async (req, res) => {
  res.status(410).json({
    status: 'error',
    error: 'Model adaptation is retired. Profile and benchmark the exact registered model artifact.'
  });
});

router.post('/full', async (req, res) => {
  try {
    const { modelName } = req.body;
    if (!modelName) return res.status(400).json({ status: 'error', error: 'modelName required' });
    const hosts = await hostProfileService.getAll();
    const onlineHosts = hosts.filter(h => h.status === 'online');
    if (!onlineHosts.length) return res.status(400).json({ status: 'error', error: 'No online hosts' });
    res.json({ status: 'success', data: await orchestrator.fullPipeline(modelName, onlineHosts) });
  } catch (err) { res.status(500).json({ status: 'error', error: err.message }); }
});

router.post('/preflight', async (req, res) => {
  try { res.json({ status: 'success', data: await orchestrator.preflight(req.body) }); }
  catch (err) { res.status(500).json({ status: 'error', error: err.message }); }
});
module.exports = router;
// Reused by the sweep run driver (routes/benchmark/sweeps.js) for auto-profiling.
module.exports.startProfileHostQueue = startProfileHostQueue;
