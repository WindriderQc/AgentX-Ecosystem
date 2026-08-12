#!/usr/bin/env node
/**
 * nestor-toolcall-smoke.js — post-deploy regression check for Nestor's
 * tool-calling on the secretary lane.
 *
 * Why this exists: a fluent model will reply "I've added that to your list"
 * while calling no tool at all — or the WRONG tool (create_todo instead of
 * add_personal_task, the exact failure behind tasks 0464/0472/0474). Adding
 * new tools can silently break existing tool selection, and no reply ever
 * reveals it. The only honest acceptance test is the side effect.
 *
 * What it does:
 *   1. Sends one canary errand through POST /api/nestor/turn
 *      ("Add '<canary>' to my personal list") using the product-facing Auto
 *      lane, which must select Complete before any tool can run.
 *   2. Polls the independent side effect: GET /api/secretary/tasks.
 *   3. Classifies the outcome:
 *        PASS            canary present as a clean personal task
 *        FAIL_MISROUTE   canary present but carries the dev TODO template
 *                        (create_todo path — stale prompt / bad triage)
 *        FAIL_NO_EFFECT  canary never appeared (reply-without-action,
 *                        turn error, or tool call failed)
 *   4. Cleans up: completes the canary via POST /api/secretary/tasks/complete
 *      (works for both the clean and misrouted paths — service stays
 *      'personal' either way), so repeated runs never pollute the queue.
 *
 * The turn is verified by side effect, so the 15s MCP-style client timeouts
 * do not matter: even if the HTTP turn call times out, polling still catches
 * the tool call landing.
 *
 * Usage:
 *   node core/scripts/nestor-toolcall-smoke.js
 *   node core/scripts/nestor-toolcall-smoke.js --base http://192.0.2.99:3080
 *   node core/scripts/nestor-toolcall-smoke.js --json          # machine output
 *   node core/scripts/nestor-toolcall-smoke.js --keep          # skip cleanup
 *
 * Options:
 *   --base <url>     Core base URL (default env AGENTX_CORE_URL, then
 *                    http://127.0.0.1:3080)
 *   --deadline <s>   Max seconds to wait for the side effect (default 90)
 *   --json           Machine-readable single-line JSON result
 *   --keep           Leave the canary task in place (debugging)
 *
 * Exit codes: 0 = PASS, 1 = FAIL_MISROUTE or FAIL_NO_EFFECT, 2 = transport /
 * environment error (core unreachable, unexpected response shape).
 */

const BASE = argValue('--base') || process.env.AGENTX_CORE_URL || 'http://127.0.0.1:3080';
const DEADLINE_S = Number(argValue('--deadline') || 90);
const JSON_OUT = process.argv.includes('--json');
const KEEP = process.argv.includes('--keep');
const POLL_INTERVAL_MS = 5000;
const CALLER = 'nestor-toolcall-smoke';

// Markers of the dev TODO template that create_todo stamps into `note`.
// A clean add_personal_task capture has an empty or short free-text note.
const MISROUTE_MARKERS = [
  '## Acceptance Criteria',
  'MCP skill bus (`create_todo`)',
  '/heartbeat` current while you work'
];

function argValue(flag) {
  const i = process.argv.indexOf(flag);
  return i !== -1 ? process.argv[i + 1] : null;
}

async function api(method, path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      'content-type': 'application/json',
      'x-service-caller': CALLER
    },
    body: body ? JSON.stringify(body) : undefined
  });
  let payload = null;
  try { payload = await res.json(); } catch (_) { /* non-JSON */ }
  return { httpStatus: res.status, payload };
}

function envelopeData(payload) {
  if (!payload) return null;
  if (payload.ok === true || payload.status === 'success') return payload.data;
  return null;
}

function findCanary(tasks, title) {
  // Exact match first; fall back to case-insensitive containment in case the
  // model reworded around the quoted phrase (the timestamp keeps it unique).
  const needle = title.toLowerCase();
  const list = tasks || [];
  return list.find((t) => t.title === title)
    || list.find((t) => (t.title || '').toLowerCase().includes(needle))
    || null;
}

function classifyNote(note) {
  const text = note || '';
  return MISROUTE_MARKERS.some((m) => text.includes(m)) ? 'misroute' : 'clean';
}

function report(result) {
  if (JSON_OUT) {
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } else {
    const lines = [
      `nestor-toolcall-smoke: ${result.verdict}`,
      `  canary:   ${result.canaryTitle}`,
      `  base:     ${BASE}`,
      `  detail:   ${result.detail}`,
      `  cleanup:  ${result.cleanup}`
    ];
    process.stdout.write(`${lines.join('\n')}\n`);
  }
}

async function main() {
  const canaryTitle = `nestor-smoke ${new Date().toISOString()}`;
  const result = {
    verdict: 'ERROR',
    canaryTitle,
    detail: '',
    cleanup: 'n/a',
    elapsedMs: 0
  };
  const started = Date.now();

  // Preflight: secretary lane reachable and canary title unused.
  const before = await api('GET', '/api/secretary/tasks');
  const beforeData = envelopeData(before.payload);
  if (!beforeData) {
    result.detail = `preflight GET /api/secretary/tasks failed (http ${before.httpStatus})`;
    report(result);
    process.exit(2);
  }

  // Fire the canary turn. A timeout or 5xx here is NOT fatal — the tool call
  // may still land; the side-effect poll below is the real check.
  let turnNote = 'turn accepted';
  try {
    const turn = await api('POST', '/api/nestor/turn', {
      text: `Add '${canaryTitle}' to my personal list`,
      lane: 'auto',
      surface: 'smoke-test',
      timeoutMs: DEADLINE_S * 1000
    });
    if (turn.httpStatus >= 400) {
      turnNote = `turn http ${turn.httpStatus}`;
    } else {
      const turnData = envelopeData(turn.payload);
      const route = turnData?.laneSelection?.requestedLane === 'auto'
        ? `auto→${turnData.lane} (${turnData.laneSelection.reason || 'policy'})`
        : turnData?.lane || 'unknown-route';
      turnNote = `turn accepted; ${route}`;
    }
  } catch (err) {
    turnNote = `turn transport error: ${err.message}`;
  }

  // Poll the independent side effect.
  let canary = null;
  const deadline = started + DEADLINE_S * 1000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
    const now = await api('GET', '/api/secretary/tasks');
    const data = envelopeData(now.payload);
    canary = findCanary(data && data.tasks, canaryTitle);
    if (canary) break;
  }
  result.elapsedMs = Date.now() - started;

  if (!canary) {
    result.verdict = 'FAIL_NO_EFFECT';
    result.detail = `no side effect within ${DEADLINE_S}s (${turnNote}) — ` +
      'Nestor replied without acting, the turn failed, or the tool call failed';
    report(result);
    process.exit(1);
  }

  const shape = classifyNote(canary.note);
  if (shape === 'misroute') {
    result.verdict = 'FAIL_MISROUTE';
    result.detail = `canary ${canary.id} created via create_todo dev template — ` +
      'live prompt drift: run core/scripts/sync-agent-prompts.js and reload the agent (see task 0473)';
  } else {
    result.verdict = 'PASS';
    result.detail = `canary ${canary.id} captured as a clean personal task (${turnNote})`;
  }

  // Cleanup — keep the queue honest across repeated runs.
  if (KEEP) {
    result.cleanup = `kept ${canary.id} (--keep)`;
  } else {
    const done = await api('POST', '/api/secretary/tasks/complete', { ref: canary.id });
    result.cleanup = envelopeData(done.payload)
      ? `completed ${canary.id}`
      : `FAILED to complete ${canary.id} (http ${done.httpStatus}) — remove manually`;
  }

  report(result);
  process.exit(result.verdict === 'PASS' ? 0 : 1);
}

main().catch((err) => {
  process.stderr.write(`nestor-toolcall-smoke: fatal ${err.stack || err.message}\n`);
  process.exit(2);
});
