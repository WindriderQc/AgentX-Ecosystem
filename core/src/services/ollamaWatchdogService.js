/**
 * Ollama Watchdog Service
 *
 * Detects inference queue jams on Ollama hosts and auto-recovers by unloading
 * the stuck model. This fixes a known issue where any client
 * aborts a timed-out request on its side, but Ollama keeps processing the
 * inference. New requests queue behind the stuck one, creating a permanent jam.
 *
 * Detection: Send a tiny generation probe with a tight timeout.
 * If the probe times out but /api/ps still responds → inference queue is jammed.
 * Recovery: Unload the model (keep_alive:0) to clear the queue, then optionally
 * reload it so it's warm for the next real request.
 *
 * Lifecycle: start() is called from server.js during startup. stop() for cleanup.
 */
const logger = require('../../config/logger');
const { getConfiguredHosts } = require('../helpers/ollamaHostConfig');
const hostGate = require('./hostGate');

let _fetch = null;
async function getFetch() {
  if (!_fetch) _fetch = (await import('node-fetch')).default;
  return _fetch;
}
function _setFetch(fn) { _fetch = fn; }

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
 * Probe a single host by sending a minimal generate request.
 * Returns { ok: true } or { ok: false, reason: string }.
 */
async function probeHost(host) {
  const fetchFn = await getFetch();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);

  try {
    const res = await fetchFn(`${host.url}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: '_',   // intentionally invalid — we just need to know if Ollama can accept requests
        prompt: 'ok',
        stream: false,
        options: { num_predict: 1 }
      }),
      signal: controller.signal
    });

    // Any response (even 404 "model not found") means the inference queue is NOT jammed
    // A jammed Ollama will hang and never respond
    return { ok: true, status: res.status };
  } catch (err) {
    if (err.name === 'AbortError' || err.type === 'aborted') {
      return { ok: false, reason: 'timeout' };
    }
    return { ok: false, reason: err.message };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Check if a host's metadata endpoint still works (/api/ps).
 * If metadata works but inference doesn't → queue is jammed (not a network issue).
 */
async function checkMeta(host) {
  const fetchFn = await getFetch();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), META_TIMEOUT_MS);

  try {
    const res = await fetchFn(`${host.url}/api/ps`, { signal: controller.signal });
    if (!res.ok) return { ok: false, models: [] };
    const data = await res.json();
    const models = (data.models || []).map(m => m.name || m.model);
    return { ok: true, models };
  } catch {
    return { ok: false, models: [] };
  } finally {
    clearTimeout(timer);
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
async function unjamHost(host, models) {
  const fetchFn = await getFetch();
  const unloaded = [];
  const errors = [];
  const skipped = [];

  for (const model of models) {
    if (hostGate.inFlightFor(host.url, model) > 0) {
      skipped.push(model);
      logger.info(`[Watchdog] Skipping unload of ${model} on ${host.name} — active inference in hostGate`);
      continue;
    }

    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 30_000); // 30s for unload

      const res = await fetchFn(`${host.url}/api/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model, keep_alive: 0 }),
        signal: controller.signal
      });
      clearTimeout(timer);

      if (res.ok || res.status < 500) {
        unloaded.push(model);
      } else {
        errors.push(`${model}: HTTP ${res.status}`);
      }
    } catch (err) {
      errors.push(`${model}: ${err.message}`);
    }
  }

  return { success: unloaded.length > 0, unloaded, errors, skipped };
}

/**
 * Reload a model on a host (warm it back up after unjam).
 */
async function reloadModel(host, model) {
  const fetchFn = await getFetch();
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 300_000); // 5min for cold load

    await fetchFn(`${host.url}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        prompt: 'warmup',
        stream: false,
        options: { num_predict: 1 }
      }),
      signal: controller.signal
    });
    clearTimeout(timer);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
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
    _stats.probesSent++;
    const result = await probeHost(host);

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

    // Probe timed out — verify metadata endpoint works
    const meta = await checkMeta(host);
    if (!meta.ok) {
      // Both failed — host is down/overloaded, not a queue jam
      _stats.probesFailed++;
      _consecutiveFails.set(host.url, 0);
      logger.debug(`[Watchdog] ${host.name} unreachable (metadata also failed)`);
      continue;
    }

    // INFERENCE TIMED OUT but METADATA WORKS → likely a queue jam
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
            logger.info(`[Watchdog] Restoring pinned model ${primaryPin} on ${host.name}`);
            await hostPrefService.restorePin(host.url);
            recordEvent('pin_restore_triggered', host, { model: primaryPin });
            pinRestored = true;
          }
        } catch {
          // hostPreferenceService not available — fall through to legacy reload
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
      // Every model the probe found had active in-flight inference. The jam
      // probe uses an invalid model name so a true stuck model wouldn't show
      // inFlight>0 in hostGate unless the caller is still actively awaiting.
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
      const { getAlertService } = require('./alertService');
      const alertService = getAlertService();
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
        await hostPrefService.restorePin(host.url);
        recordEvent('pin_restore_triggered', host, { model: primaryPin });
        pinRestored = true;
      }
    } catch {
      // Fall through to legacy reload
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

module.exports = { start, stop, getStats, runNow, forceUnjam, probeHost, checkMeta, _setFetch };
