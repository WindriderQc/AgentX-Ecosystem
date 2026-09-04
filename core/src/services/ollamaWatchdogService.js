'use strict';

/**
 * Ollama Watchdog Service
 *
 * Detects inference queue jams on Ollama hosts and auto-recovers by unloading
 * the stuck model. This fixes a known issue where any client
 * aborts a timed-out request on its side, but Ollama keeps processing the
 * inference. New requests queue behind the stuck one, creating a permanent jam.
 *
 * Detection: Ask /api/ps which models are loaded, then send one idle loaded
 * model a one-token generation probe with a tight timeout. If the host has no
 * loaded model, use a cheap invalid-model control-plane probe instead.
 * If a loaded-model probe times out while /api/ps responds → inference queue
 * is jammed or the resident worker is false-ready.
 * Recovery: Unload the model (keep_alive:0) to clear the queue, then optionally
 * reload it so it's warm for the next real request.
 *
 * Lifecycle: start() is called from server.js during startup. stop() for cleanup.
 */
const nodeFetch = require('node-fetch');
const logger = require('../../config/logger');
const { getConfiguredHosts } = require('../helpers/ollamaHostConfig');
const {
  OUTBOUND_ERROR_CODES,
  createOutboundHttpExecutor,
  readBoundedJson
} = require('../../../shared/outboundHttpExecutor');
const {
  peerVerifiedNodeFetchTransport
} = require('../helpers/peerVerifiedNodeFetchTransport');
const hostGate = require('./hostGate');
const { runRuntimeMutation } = require('./runtimeMutationLeaseService');

let _fetch = nodeFetch;
let _outboundExecutor = null;

// Preserve the long-standing injected-fetch test seam. The fetch still runs
// through the governed executor and whichever peer-verifying transport the
// module was constructed with; tests mock that transport at the module seam.
function _setFetch(fn) {
  if (fn !== undefined && fn !== null && typeof fn !== 'function') {
    throw new TypeError('Watchdog fetch implementation must be a function');
  }
  _fetch = fn || nodeFetch;
  _outboundExecutor = null;
}

// ── Configuration ───────────────────────────────────────────

const PROBE_INTERVAL_MS  = parseInt(process.env.WATCHDOG_INTERVAL_MS, 10) || 60_000;   // check every 60s
const PROBE_TIMEOUT_MS   = parseInt(process.env.WATCHDOG_PROBE_TIMEOUT_MS, 10) || 15_000; // 15s probe timeout
const META_TIMEOUT_MS    = 3_000;   // /api/ps must respond in 3s (metadata is always fast)
const MAX_CONSECUTIVE    = parseInt(process.env.WATCHDOG_MAX_CONSECUTIVE, 10) || 2;      // require N consecutive fails before acting
const RELOAD_AFTER_UNJAM = process.env.WATCHDOG_RELOAD !== 'false';                      // reload model after unjam?
// After a host recovers (probe transitions fail→ok), suppress unjam actions for
// this window so that cold model-load traffic doesn't trip the jam detector
// (a warming model can hold the generate queue longer than the probe timeout).
const RECOVERY_GRACE_MS  = parseInt(process.env.WATCHDOG_RECOVERY_GRACE_MS, 10) || 300_000; // 5 min

const UNJAM_TIMEOUT_MS = 30_000;
const RESTORE_TIMEOUT_MS = 300_000;
const GENERATE_MAX_REQUEST_BYTES = 64 * 1024;
const GENERATE_MAX_RESPONSE_BYTES = 64 * 1024;
const META_MAX_RESPONSE_BYTES = 1024 * 1024;

const WATCHDOG_OPERATIONS = Object.freeze({
  GENERATE_PROBE: 'core.watchdog.generate-probe',
  PS: 'core.watchdog.ps',
  UNJAM: 'core.watchdog.unjam',
  RESTORE: 'core.watchdog.restore'
});

function operation(method, pathPattern, {
  deadlineMs,
  maxRequestBytes = 0,
  maxResponseBytes,
  responseMode
}) {
  return Object.freeze({
    allowSearch: false,
    method,
    pathPattern,
    responseMode,
    policy: Object.freeze({
      authoritySource: 'configured',
      deadlineMs,
      maxRequestBytes,
      maxResponseBytes
    })
  });
}

const WATCHDOG_OPERATION_SPECS = Object.freeze({
  [WATCHDOG_OPERATIONS.GENERATE_PROBE]: operation('POST', '^/api/generate$', {
    deadlineMs: PROBE_TIMEOUT_MS,
    maxRequestBytes: GENERATE_MAX_REQUEST_BYTES,
    maxResponseBytes: GENERATE_MAX_RESPONSE_BYTES,
    responseMode: 'discard'
  }),
  [WATCHDOG_OPERATIONS.PS]: operation('GET', '^/api/ps$', {
    deadlineMs: META_TIMEOUT_MS,
    maxResponseBytes: META_MAX_RESPONSE_BYTES,
    responseMode: 'json'
  }),
  [WATCHDOG_OPERATIONS.UNJAM]: operation('POST', '^/api/generate$', {
    deadlineMs: UNJAM_TIMEOUT_MS,
    maxRequestBytes: GENERATE_MAX_REQUEST_BYTES,
    maxResponseBytes: GENERATE_MAX_RESPONSE_BYTES,
    responseMode: 'json'
  }),
  [WATCHDOG_OPERATIONS.RESTORE]: operation('POST', '^/api/generate$', {
    deadlineMs: RESTORE_TIMEOUT_MS,
    maxRequestBytes: GENERATE_MAX_REQUEST_BYTES,
    maxResponseBytes: GENERATE_MAX_RESPONSE_BYTES,
    responseMode: 'json'
  })
});

const WATCHDOG_OUTBOUND_OPERATIONS = Object.freeze(Object.fromEntries(
  Object.entries(WATCHDOG_OPERATION_SPECS)
    .map(([operationId, spec]) => [operationId, spec.policy])
));

function configuredOrigin(value) {
  let parsed;
  try {
    parsed = new URL(String(value || '').trim());
  } catch {
    throw new Error('Watchdog Ollama authority is not configured');
  }
  if ((parsed.protocol !== 'http:' && parsed.protocol !== 'https:')
    || parsed.username
    || parsed.password
    || parsed.pathname !== '/'
    || parsed.search
    || parsed.hash
    || parsed.origin === 'null') {
    throw new Error('Watchdog Ollama authority is not configured');
  }
  return parsed.origin;
}

function operationMatches(spec, method, target) {
  return Boolean(spec)
    && spec.method === method
    && new RegExp(spec.pathPattern).test(target.pathname)
    && (spec.allowSearch || !target.search)
    && !target.hash;
}

function assertRegisteredOperation(operationId, method, target) {
  const spec = WATCHDOG_OPERATION_SPECS[operationId];
  if (!operationMatches(spec, method, target)) {
    throw new Error('Watchdog outbound operation is not registered');
  }
  return spec;
}

function createConfiguredWatchdogAuthorityAdapter(configuredHosts = getConfiguredHosts) {
  if (typeof configuredHosts !== 'function') {
    throw new TypeError('Configured watchdog hosts must be provided by a function');
  }

  return ({ authoritySource, sinkId, target }) => {
    const spec = WATCHDOG_OPERATION_SPECS[sinkId];
    const requested = new URL(target);
    const allowedOrigins = new Set((configuredHosts() || []).map((host) => {
      try {
        return configuredOrigin(host?.url);
      } catch {
        return null;
      }
    }).filter(Boolean));

    if (authoritySource !== 'configured'
      || !operationMatches(spec, spec?.method, requested)
      || !allowedOrigins.has(requested.origin)) {
      throw new Error('Watchdog outbound target is not configured');
    }
    return Object.freeze({ expectedOrigin: requested.origin });
  };
}

function createWatchdogExecutor(options = {}) {
  return createOutboundHttpExecutor({
    authorityAdapter: options.authorityAdapter
      || createConfiguredWatchdogAuthorityAdapter(options.getConfiguredHosts || getConfiguredHosts),
    fetchImpl: options.fetchImpl || nodeFetch,
    operations: options.operations || WATCHDOG_OUTBOUND_OPERATIONS,
    transportAdapter: options.transportAdapter || peerVerifiedNodeFetchTransport
  });
}

function getWatchdogExecutor() {
  if (!_outboundExecutor) {
    _outboundExecutor = createWatchdogExecutor({ fetchImpl: _fetch });
  }
  return _outboundExecutor;
}

async function watchdogRequest(
  operationId,
  target,
  options = {},
  executor = getWatchdogExecutor()
) {
  let requested;
  try {
    requested = new URL(target);
  } catch {
    throw new Error('Watchdog outbound operation is not registered');
  }
  const method = String(options.method || 'GET').toUpperCase();
  assertRegisteredOperation(operationId, method, requested);
  const admission = await executor.admitTarget(operationId, requested.href, {
    signal: options.signal
  });
  return executor.request(admission, { ...options, method });
}

function hostTarget(host, pathname) {
  return new URL(pathname, `${configuredOrigin(host?.url)}/`).href;
}

function isDeadlineError(error) {
  return error?.code === OUTBOUND_ERROR_CODES.DEADLINE_EXCEEDED
    || error?.name === 'AbortError'
    || error?.type === 'aborted';
}

// ── State ───────────────────────────────────────────────────

let _interval = null;
const _consecutiveFails = new Map();  // hostUrl → count
const _lastProbeStatus = new Map();   // hostUrl → 'ok' | 'fail' (previous cycle)
const _graceWindowEndsAt = new Map(); // hostUrl → timestamp (ms since epoch)
const _stats = {
  probesSent: 0,
  probesOk: 0,
  probesFailed: 0,
  jamsDetected: 0,
  unjamsDone: 0,
  lastProbeAt: null,
  lastJamAt: null,
  history: []   // last N events (ring buffer, max 50)
};

// ── Core Logic ──────────────────────────────────────────────

/**
 * Probe a single host by sending a minimal generate request. When `model` is
 * supplied this exercises the resident worker; the invalid sentinel is only a
 * control-plane check for hosts with nothing loaded.
 * Returns { ok: true } or { ok: false, reason: string }.
 */
async function probeHost(host, model = null, executor = getWatchdogExecutor()) {
  try {
    const res = await watchdogRequest(
      WATCHDOG_OPERATIONS.GENERATE_PROBE,
      hostTarget(host, '/api/generate'),
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: model || '_',
          prompt: 'ok',
          stream: false,
          think: false,
          keep_alive: -1,
          options: { num_predict: 1 }
        })
      },
      executor
    );

    // Any completed response means the request reached the worker/control
    // plane. Model-capability errors are still useful responses; a jammed or
    // false-ready worker hangs until the bounded timeout. The body is not part
    // of this status-first result, so explicitly cancel it to close the socket
    // lifecycle without waiting on an untrusted error body.
    const status = res.status;
    await res.cancel();
    return {
      ok: true,
      status,
      mode: model ? 'loaded-model' : 'control-plane',
      model
    };
  } catch (err) {
    if (isDeadlineError(err)) {
      return { ok: false, reason: 'timeout' };
    }
    return { ok: false, reason: err.message };
  }
}

/**
 * Check if a host's metadata endpoint still works (/api/ps).
 * If metadata works but inference doesn't → queue is jammed (not a network issue).
 */
async function checkMeta(host, executor = getWatchdogExecutor()) {
  try {
    const res = await watchdogRequest(
      WATCHDOG_OPERATIONS.PS,
      hostTarget(host, '/api/ps'),
      { method: 'GET' },
      executor
    );
    if (!res.ok) {
      // Preserve the legacy status-first metadata result. A failed status must
      // not become a timeout merely because its body stalls.
      await res.cancel();
      return { ok: false, models: [] };
    }
    const data = await readBoundedJson(res);
    const models = (data.models || []).map(m => m.name || m.model);
    return { ok: true, models };
  } catch {
    return { ok: false, models: [] };
  }
}

/**
 * Unjam a host by unloading all currently loaded models.
 *
 * Skips any model that has active inference tracked by hostGate — the typical
 * probe-timeout jam is caused by a request that already aborted client-side
 * (inFlight=0 in hostGate while Ollama still processes), so healthy in-flight
 * callers like a long benchmark judge call are distinguishable from the jam
 * and should not be force-evicted mid-stream.
 *
 * @returns {{ success: boolean, unloaded: string[], errors: string[], skipped: string[] }}
 */
async function unjamHost(host, models, executor = getWatchdogExecutor()) {
  const unloaded = [];
  const errors = [];
  const skipped = [];

  try {
    await runRuntimeMutation({
      principal: 'core-watchdog',
      scope: `watchdog-unjam:${configuredOrigin(host.url)}`,
      ttlMs: Math.max(UNJAM_TIMEOUT_MS * Math.max(1, models.length), 120_000)
    }, async ({ signal, assertActive }) => {
      for (const model of models) {
        assertActive();
        if (hostGate.inFlightFor(host.url, model) > 0) {
          skipped.push(model);
          logger.info(`[Watchdog] Skipping unload of ${model} on ${host.name} — active inference in hostGate`);
          continue;
        }

        const res = await watchdogRequest(
          WATCHDOG_OPERATIONS.UNJAM,
          hostTarget(host, '/api/generate'),
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ model, keep_alive: 0 }),
            signal
          },
          executor
        );
        const terminal = await readBoundedJson(res);
        assertActive();
        if (!res.ok || terminal?.done !== true) {
          const error = new Error(!res.ok
            ? `HTTP ${res.status}`
            : 'Ollama unload ended without an exact terminal done object');
          error.code = 'WATCHDOG_UNJAM_UNVERIFIED';
          errors.push(`${model}: ${error.message}`);
          throw error;
        }
        unloaded.push(model);
      }
      assertActive();
    });
  } catch (err) {
    if (errors.length === 0) errors.push(err.message);
    return { success: false, unloaded, errors, skipped, quarantined: true };
  }

  return { success: unloaded.length > 0, unloaded, errors, skipped, quarantined: false };
}

/**
 * Reload a model on a host (warm it back up after unjam).
 */
async function reloadModel(host, model, executor = getWatchdogExecutor()) {
  try {
    await runRuntimeMutation({
      principal: 'core-watchdog',
      scope: `watchdog-restore:${configuredOrigin(host.url)}:${model}`,
      ttlMs: RESTORE_TIMEOUT_MS
    }, async ({ signal, assertActive }) => {
      assertActive();
      const res = await watchdogRequest(
        WATCHDOG_OPERATIONS.RESTORE,
        hostTarget(host, '/api/generate'),
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model,
            prompt: 'warmup',
            stream: false,
            options: { num_predict: 1 }
          }),
          signal
        },
        executor
      );
      const terminal = await readBoundedJson(res);
      assertActive();
      if (!res.ok || terminal?.done !== true) {
        const error = new Error(!res.ok
          ? `HTTP ${res.status}`
          : 'Ollama restore ended without an exact terminal done object');
        error.code = 'WATCHDOG_RESTORE_UNVERIFIED';
        throw error;
      }
    });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message, quarantined: true };
  }
}

async function restorePinnedModel(host, hostPrefService, primaryPin) {
  return runRuntimeMutation({
    principal: 'core-watchdog',
    scope: `watchdog-pin-restore:${configuredOrigin(host.url)}:${primaryPin}`,
    ttlMs: RESTORE_TIMEOUT_MS
  }, async ({ signal, assertActive }) => {
    const result = await hostPrefService.restorePinnedModels(host.url, {
      signal,
      assertAuthorityActive: assertActive
    });
    assertActive();
    if (result?.status !== 'ready' || result?.verified !== true) {
      const error = new Error(result?.error || 'Pinned model restore did not produce a verified terminal receipt');
      error.code = 'WATCHDOG_PIN_RESTORE_UNVERIFIED';
      throw error;
    }
    return result;
  });
}

/**
 * Push an event into the ring buffer history.
 */
function recordEvent(type, host, details) {
  const event = {
    type,
    hostId: host.id,
    hostName: host.name,
    hostUrl: host.url,
    timestamp: new Date().toISOString(),
    ...details
  };
  _stats.history.push(event);
  if (_stats.history.length > 50) _stats.history.shift();
  return event;
}

/**
 * Run one probe cycle across all configured hosts.
 */
async function probeCycle() {
  const hosts = getConfiguredHosts();
  if (hosts.length === 0) return;

  _stats.lastProbeAt = new Date().toISOString();

  for (const host of hosts) {
    // Metadata is both the cheap reachability check and the source of truth for
    // selecting a resident worker. Do it first so the watchdog never mistakes
    // an offline host for a jam.
    const meta = await checkMeta(host);
    let result;

    if (!meta.ok) {
      result = { ok: false, reason: 'metadata_unreachable' };
    } else {
      // Host ownership matters across model names. A caller may be waiting for
      // Ollama to evict the resident model and load a different one; probing the
      // currently loaded model during that window can repeatedly win the
      // scheduler race and starve the legitimate cold swap.
      if (hostGate.hostHasInflight(host.url)) {
        logger.debug(`[Watchdog] ${host.name} probe skipped — host has active inference`);
        continue;
      }

      const probeModel = meta.models[0] || null;

      _stats.probesSent++;
      result = await probeHost(host, probeModel);
    }

    // Track fail→ok transitions to arm the recovery grace window. A recovering
    // host may queue cold model loads that exceed the probe timeout; without
    // the grace window, the watchdog would unload those models mid-warmup and
    // cascade the reload.
    const prevStatus = _lastProbeStatus.get(host.url);
    const nowStatus = result.ok ? 'ok' : 'fail';
    if (prevStatus === 'fail' && nowStatus === 'ok') {
      _graceWindowEndsAt.set(host.url, Date.now() + RECOVERY_GRACE_MS);
      logger.info(`[Watchdog] ${host.name} recovered — grace window active for ${RECOVERY_GRACE_MS / 1000}s`);
      recordEvent('grace_window_armed', host, { expiresAt: new Date(Date.now() + RECOVERY_GRACE_MS).toISOString() });
    }
    _lastProbeStatus.set(host.url, nowStatus);

    if (result.ok) {
      // Inference responded — host is healthy
      _stats.probesOk++;
      _consecutiveFails.set(host.url, 0);
      continue;
    }

    // Probe failed — check if it's a jam or just network down
    if (result.reason !== 'timeout') {
      // Network error / host unreachable — not a jam, skip
      _stats.probesFailed++;
      _consecutiveFails.set(host.url, 0);
      logger.debug(`[Watchdog] ${host.name} probe failed (not a jam): ${result.reason}`);
      continue;
    }

    // LOADED-MODEL INFERENCE TIMED OUT but METADATA WORKS → queue jam or a
    // resident worker that is loaded according to /api/ps but emits no tokens.
    const fails = (_consecutiveFails.get(host.url) || 0) + 1;
    _consecutiveFails.set(host.url, fails);
    _stats.probesFailed++;

    logger.warn(`[Watchdog] ${host.name} inference probe timed out (${fails}/${MAX_CONSECUTIVE})`, {
      hostUrl: host.url,
      loadedModels: meta.models,
      consecutiveFails: fails
    });

    if (fails < MAX_CONSECUTIVE) {
      recordEvent('probe_timeout', host, { consecutiveFails: fails, loadedModels: meta.models });
      continue;
    }

    // ── Recovery grace window — suppress unjam after host just came back ──
    const graceEndsAt = _graceWindowEndsAt.get(host.url);
    if (graceEndsAt && Date.now() < graceEndsAt) {
      const remainingMs = graceEndsAt - Date.now();
      logger.info(`[Watchdog] ${host.name} in recovery grace window — deferring unjam`, {
        hostUrl: host.url,
        remainingSec: Math.round(remainingMs / 1000),
        loadedModels: meta.models
      });
      recordEvent('grace_skip', host, { remainingMs, loadedModels: meta.models });
      _consecutiveFails.set(host.url, 0);
      continue;
    }

    // ── JAM CONFIRMED — take action ──

    _stats.jamsDetected++;
    _stats.lastJamAt = new Date().toISOString();
    _consecutiveFails.set(host.url, 0);

    logger.error(`[Watchdog] JAM DETECTED on ${host.name} — unloading ${meta.models.length} model(s)`, {
      hostUrl: host.url,
      models: meta.models
    });

    recordEvent('jam_detected', host, { models: meta.models });

    // Unjam: unload all models
    const unjamResult = await unjamHost(host, meta.models);
    _stats.unjamsDone++;

    if (unjamResult.success) {
      logger.info(`[Watchdog] ${host.name} unjammed — unloaded: ${unjamResult.unloaded.join(', ')}`, {
        hostUrl: host.url,
        skipped: unjamResult.skipped
      });
      recordEvent('unjam_success', host, { unloaded: unjamResult.unloaded, skipped: unjamResult.skipped });

      // Optionally reload the models so they're warm
      if (RELOAD_AFTER_UNJAM && unjamResult.unloaded.length > 0) {
        // Check if host has a pinned model — restore that instead of whatever was unloaded
        let pinRestored = false;
        try {
          const hostPrefService = require('./hostPreferenceService');
          const pinStatus = await hostPrefService.getPinStatus(host.url);
          const primaryPin = pinStatus.pinnedModels?.[0]?.model || null;
          if (primaryPin) {
            pinRestored = true;
            logger.info(`[Watchdog] Restoring pinned model ${primaryPin} on ${host.name}`);
            await restorePinnedModel(host, hostPrefService, primaryPin);
            recordEvent('pin_restore_triggered', host, { model: primaryPin });
          }
        } catch (error) {
          if (pinRestored) {
            logger.warn(`[Watchdog] Failed to restore pinned model on ${host.name}: ${error.message}`);
            recordEvent('pin_restore_failed', host, { error: error.message });
          }
        }

        if (!pinRestored) {
          for (const model of unjamResult.unloaded) {
            logger.info(`[Watchdog] Reloading ${model} on ${host.name}...`);
            const reload = await reloadModel(host, model);
            if (reload.ok) {
              logger.info(`[Watchdog] ${model} reloaded on ${host.name}`);
              recordEvent('reload_success', host, { model });
            } else {
              logger.warn(`[Watchdog] Failed to reload ${model} on ${host.name}: ${reload.error}`);
              recordEvent('reload_failed', host, { model, error: reload.error });
            }
          }
        }
      }
    } else if (unjamResult.skipped.length > 0 && unjamResult.errors.length === 0) {
      // Defer unjam to the next cycle rather than killing healthy callers.
      logger.info(`[Watchdog] ${host.name} jam deferred — all loaded models have active inference`, {
        hostUrl: host.url,
        skipped: unjamResult.skipped
      });
      recordEvent('unjam_deferred', host, { skipped: unjamResult.skipped });
    } else {
      logger.error(`[Watchdog] Failed to unjam ${host.name}`, {
        errors: unjamResult.errors
      });
      recordEvent('unjam_failed', host, { errors: unjamResult.errors });
    }

    // Fire alert event (integrates with alertService if wired)
    try {
      const alertService = require('./alertService');
      if (alertService) {
        await alertService.evaluateEvent({
          type: 'ollama_jam_detected',
          data: {
            component: 'ollama',
            metric: 'inference_jam',
            currentValue: 1,
            hostId: host.id,
            hostName: host.name,
            hostUrl: host.url,
            models: meta.models,
            unjamSuccess: unjamResult.success
          }
        });
      }
    } catch {
      // Alert service not available — non-fatal
    }
  }
}

// ── Public API ──────────────────────────────────────────────

function start() {
  if (_interval) return;
  _interval = setInterval(() => {
    probeCycle().catch(err => {
      logger.warn(`[Watchdog] Probe cycle error: ${err.message}`);
    });
  }, PROBE_INTERVAL_MS);
  logger.info(`[Watchdog] Ollama inference watchdog started (interval: ${PROBE_INTERVAL_MS / 1000}s, threshold: ${MAX_CONSECUTIVE} consecutive fails)`);
}

function stop() {
  if (_interval) {
    clearInterval(_interval);
    _interval = null;
    logger.info('[Watchdog] Ollama inference watchdog stopped');
  }
}

function getStats() {
  return { ..._stats, isRunning: !!_interval, config: { probeIntervalMs: PROBE_INTERVAL_MS, probeTimeoutMs: PROBE_TIMEOUT_MS, maxConsecutive: MAX_CONSECUTIVE, reloadAfterUnjam: RELOAD_AFTER_UNJAM } };
}

/** Manual trigger: run one probe cycle right now */
async function runNow() {
  await probeCycle();
  return getStats();
}

/** Manual unjam: force-unload models on a specific host */
async function forceUnjam(hostUrl) {
  const hosts = getConfiguredHosts();
  const host = hosts.find(h => h.url === hostUrl || h.id === hostUrl || h.name === hostUrl);
  if (!host) throw new Error(`Host not found: ${hostUrl}`);

  const meta = await checkMeta(host);
  if (!meta.ok) throw new Error(`Host unreachable: ${host.url}`);
  if (meta.models.length === 0) return { message: 'No models loaded', host: host.name };

  const result = await unjamHost(host, meta.models);
  recordEvent('force_unjam', host, { models: meta.models, result });

  if (RELOAD_AFTER_UNJAM) {
    let pinRestored = false;
    try {
      const hostPrefService = require('./hostPreferenceService');
      const pinStatus = await hostPrefService.getPinStatus(host.url);
      const primaryPin = pinStatus.pinnedModels?.[0]?.model || null;
      if (primaryPin) {
        pinRestored = true;
        await restorePinnedModel(host, hostPrefService, primaryPin);
        recordEvent('pin_restore_triggered', host, { model: primaryPin });
      }
    } catch (error) {
      if (pinRestored) {
        recordEvent('pin_restore_failed', host, { error: error.message });
      }
    }

    if (!pinRestored) {
      for (const model of result.unloaded) {
        const reload = await reloadModel(host, model);
        recordEvent(reload.ok ? 'reload_success' : 'reload_failed', host, { model, error: reload.error });
      }
    }
  }

  return { host: host.name, ...result };
}

module.exports = {
  WATCHDOG_OPERATIONS,
  checkMeta,
  forceUnjam,
  getStats,
  probeHost,
  runNow,
  start,
  stop,
  _setFetch,
  _internal: {
    GENERATE_MAX_REQUEST_BYTES,
    GENERATE_MAX_RESPONSE_BYTES,
    META_MAX_RESPONSE_BYTES,
    META_TIMEOUT_MS,
    PROBE_TIMEOUT_MS,
    RESTORE_TIMEOUT_MS,
    UNJAM_TIMEOUT_MS,
    WATCHDOG_OPERATION_SPECS,
    WATCHDOG_OUTBOUND_OPERATIONS,
    configuredOrigin,
    createConfiguredWatchdogAuthorityAdapter,
    createWatchdogExecutor,
    operationMatches,
    reloadModel,
    restorePinnedModel,
    unjamHost,
    watchdogRequest
  }
};
