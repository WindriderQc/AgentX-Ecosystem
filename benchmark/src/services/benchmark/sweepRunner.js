'use strict';

/**
 * Sweep run driver (Phase 2 of the per-host optimization plan).
 *
 * Turns the read-only `/sweeps/plan` planner into a GUARDED executor:
 *   build plan → lock checks → (optionally profile + poll) → preflight → start batch.
 *
 * Hard guarantees (master-optimization-plan Track A item 2):
 *  - Requires explicit `execute: true`; otherwise returns a dry-run plan.
 *  - Rejects if any benchmark batch is active (global single-batch enforcement).
 *  - Rejects if the target host already has an active profile queue.
 *  - One host per request (the planner is single-host).
 *  - Never mutates routing truth.
 *  - Never bypasses benchmark preflight.
 *
 * Fully dependency-injected so the orchestration is unit-testable without DB,
 * HTTP, or real long-running jobs. The route wires the real implementations.
 *
 * `startProfileQueue` is OPTIONAL: when omitted, profiling is DEFERRED — the
 * driver returns `phase: 'needs_profile'` with the ready-to-POST payload instead
 * of auto-driving the profiler. When provided (tests, or once the profiler
 * queue-start is extracted from routes/profiler/pipeline.js), the driver
 * auto-profiles, polls to terminal state, rebuilds the plan, then benchmarks.
 */

const TERMINAL_OK = 'completed';
const TERMINAL_BAD = new Set(['failed', 'cancelled']);
const DEFAULT_POLL_INTERVAL_MS = 5000;
const DEFAULT_MAX_WAIT_MS = 15 * 60 * 1000; // 15 min ceiling on in-request polling

function err(message, code = 400) {
  const e = new Error(message);
  e.statusCode = code;
  return e;
}

function benchmarkPayloadToStartArgs(payload) {
  return {
    host: payload.host,
    models: payload.models,
    levels: payload.levels,
    prompt_ids: payload.prompt_ids || null,
    run_name: payload.run_name,
    judge_config: payload.judge_config || {},
    execution_config: payload.execution_config || {},
    tags: payload.tags || [],
    description: payload.description || '',
    execution_mode: payload.execution_mode || 'latency',
    depth_config: payload.depth_config || null
  };
}

function preflightTargets(payload) {
  return (payload.models || []).map((model) => ({ host: payload.host, model }));
}

/**
 * @param {object} input - same body as /sweeps/plan, plus `execute`, `maxWaitMs`, `pollIntervalMs`.
 * @param {object} deps
 * @param {function} deps.buildSweepPlan  async (input) => plan
 * @param {function} deps.getActiveBatches async () => Array (active batches; non-empty ⇒ locked)
 * @param {function} deps.findActiveProfilingForHost ({hostUrl}) => Array (non-empty ⇒ locked)
 * @param {function} deps.runPreflight   async ({targets, judgeConfig, levels, prompt_ids, executionConfig}) => {ready, issues}
 * @param {function} deps.startBatch     async (startArgs) => {batch_id, total_tests, plan}
 * @param {function} [deps.startProfileQueue] async (profilePayload) => {queueId}  (optional ⇒ defer profiling)
 * @param {function} [deps.getQueueStatus]    async (queueId) => {status}
 * @param {function} [deps.sleep]              async (ms) => void
 * @returns {Promise<object>} result with a `phase` discriminator.
 */
async function runSweep(input = {}, deps = {}) {
  const {
    buildSweepPlan,
    getActiveBatches,
    findActiveProfilingForHost,
    runPreflight,
    startBatch,
    startProfileQueue,
    getQueueStatus,
    sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  } = deps;

  if (typeof buildSweepPlan !== 'function') throw err('buildSweepPlan dependency is required', 500);

  const execute = input.execute === true;
  const pollIntervalMs = Number(input.pollIntervalMs) > 0 ? Number(input.pollIntervalMs) : DEFAULT_POLL_INTERVAL_MS;
  const maxWaitMs = Number(input.maxWaitMs) >= 0 ? Number(input.maxWaitMs) : DEFAULT_MAX_WAIT_MS;

  // 1. Build the plan (single-host; throws on bad input / unreachable host).
  let plan = await buildSweepPlan(input);

  // 2. Dry-run unless explicitly told to execute.
  if (!execute) {
    return {
      phase: 'dry_run',
      executed: false,
      hint: 'pass execute:true to run',
      wouldStart: {
        profile: !!plan.payloads.profileQueue,
        benchmark: !!plan.payloads.benchmark,
        benchmarkModels: plan.payloads.benchmark?.models || []
      },
      plan
    };
  }

  // 3. Lock checks (fail closed).
  const activeBatches = await getActiveBatches();
  if (Array.isArray(activeBatches) && activeBatches.length > 0) {
    throw err(`A benchmark batch is already active (${activeBatches[0]?.batch_id || activeBatches[0]?._id || 'unknown'}). Sweeps run one batch at a time.`, 409);
  }
  const activeProfiling = await findActiveProfilingForHost({ hostUrl: plan.host.hostUrl });
  if (Array.isArray(activeProfiling) && activeProfiling.length > 0) {
    throw err(`Host ${plan.host.hostUrl} already has an active profile queue. Wait for it to finish before running a sweep.`, 409);
  }

  // 4. Profiling phase (only if the plan needs it).
  if (plan.payloads.profileQueue) {
    if (typeof startProfileQueue !== 'function') {
      // Deferred mode: hand back the ready-to-POST payload instead of auto-driving.
      return {
        phase: 'needs_profile',
        executed: false,
        reason: 'candidates need profiling/adaptation before benchmarking; profiling is deferred in this driver version',
        profilePayload: plan.payloads.profileQueue,
        plan
      };
    }

    const started = await startProfileQueue(plan.payloads.profileQueue);
    const queueId = started?.queueId;
    if (!queueId) throw err('startProfileQueue did not return a queueId', 500);

    const waited = await pollToTerminal({ queueId, getQueueStatus, sleep, pollIntervalMs, maxWaitMs });
    if (waited.status !== TERMINAL_OK) {
      if (waited.pending) {
        return { phase: 'profiling', executed: true, pending: true, queueId, waitedMs: waited.waitedMs, plan };
      }
      return { phase: 'profile_failed', executed: true, queueId, status: waited.status, plan };
    }

    // Re-plan after profiling/adaptation so readiness reflects new artifacts.
    plan = await buildSweepPlan(input);
  }

  // 5. Benchmark phase — only ready models, never bypassing preflight.
  if (!plan.payloads.benchmark) {
    return { phase: 'noop', executed: true, reason: 'no benchmark-ready models after planning', plan };
  }

  // Re-check the batch lock right before launch (race guard).
  const activeBatches2 = await getActiveBatches();
  if (Array.isArray(activeBatches2) && activeBatches2.length > 0) {
    throw err('A benchmark batch became active during the sweep; aborting before launch.', 409);
  }

  const preflight = await runPreflight({
    targets: preflightTargets(plan.payloads.benchmark),
    judgeConfig: plan.payloads.benchmark.judge_config || {},
    levels: plan.payloads.benchmark.levels,
    prompt_ids: plan.payloads.benchmark.prompt_ids || null,
    executionConfig: plan.payloads.benchmark.execution_config || null
  });
  if (!preflight || preflight.ready !== true) {
    return { phase: 'preflight_failed', executed: true, issues: preflight?.issues || [], plan };
  }

  const batch = await startBatch(benchmarkPayloadToStartArgs(plan.payloads.benchmark));
  return {
    phase: 'benchmarking',
    executed: true,
    batchId: batch?.batch_id || null,
    totalTests: batch?.total_tests ?? null,
    models: plan.payloads.benchmark.models,
    plan
  };
}

/**
 * Poll a profile queue until it reaches a terminal state or maxWaitMs elapses.
 * Returns { status, pending, waitedMs }. `pending: true` means it was still
 * running when the in-request wait ceiling was hit (caller can re-invoke/poll).
 */
async function pollToTerminal({ queueId, getQueueStatus, sleep, pollIntervalMs, maxWaitMs }) {
  if (typeof getQueueStatus !== 'function') throw err('getQueueStatus dependency is required to poll profiling', 500);
  let waitedMs = 0;
  // Always check at least once before sleeping.
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const snap = await getQueueStatus(queueId);
    const status = snap?.status || snap?.queueStatus;
    if (status === TERMINAL_OK) return { status, pending: false, waitedMs };
    if (TERMINAL_BAD.has(status)) return { status, pending: false, waitedMs };
    if (waitedMs >= maxWaitMs) return { status: status || 'running', pending: true, waitedMs };
    await sleep(pollIntervalMs);
    waitedMs += pollIntervalMs;
  }
}

module.exports = {
  runSweep,
  _internal: { pollToTerminal, benchmarkPayloadToStartArgs, preflightTargets, TERMINAL_OK, TERMINAL_BAD }
};
