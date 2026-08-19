'use strict';

/**
 * capabilityGrader — the single deterministic capability-tier decision engine
 * (task 0296). PURE: no DB, no network, no LLM. The LLM judge is NEVER an input.
 *
 * It consumes raw, deterministic signals (from the product contract matrix, the
 * C4 worktree harness, and model readiness) and returns the highest CONTIGUOUS
 * capability tier earned. "Contiguous" enforces the ladder: a model cannot be C3
 * without also clearing C0–C2.
 *
 * Historical frozen gates: docs/_archive/2026-06/dispatch-qualification-schema.md §2a.
 *
 *   C0 Reachable          readiness >= available OR an explicit reachability probe
 *   C1 Primitive tools    read+write+edit+exec all succeed (or readiness >= profiled)
 *   C2 Scratch contract   claim row + artifact + parseable feedback JSON + DONE
 *   C3 Large-context      C2 AND no tool-XML leak AND writes stay in bounds
 *   C4 Real-repo          C3 AND diff within bounds AND npm test green AND verify artifact
 *
 * Evidence shape (every field optional; missing => that gate's inputs are absent):
 *   {
 *     reachable:      Boolean,
 *     readinessStage: 'available'|'profiled'|'benchmarked',
 *     tools:    { read, write, edit, exec }            // booleans
 *     contract: { assignmentOk, artifactOk, feedbackOk, donePresent }  // booleans
 *     response: { text } | responseText: String,        // visible assistant text
 *     boundary: { touched:[..], allowedRoots:[..], declaredFiles:[..]|null },
 *     c4:       { diffBytes, diffFiles, npmTestExit, verificationArtifact },
 *     bounds:   { maxDiffBytes, maxDiffFiles }
 *   }
 */

const READINESS_RANK = Object.freeze({ available: 0, profiled: 1, benchmarked: 2 });
const TIER_ORDER = Object.freeze(['C0', 'C1', 'C2', 'C3', 'C4']);

function rankReadiness(stage) {
  if (stage == null) return -1;
  const r = READINESS_RANK[String(stage).toLowerCase()];
  return r == null ? -1 : r;
}

/**
 * Detect raw tool-call XML leaking into the visible response — a C3 disqualifier.
 * A calibrated agent emits tool calls through the harness, never as literal markup
 * in its final assistant text.
 */
function detectToolXmlLeak(text) {
  if (!text || typeof text !== 'string') return false;
  const patterns = [
    /<\/?tool_call\b/i,
    /<\/?function_calls\b/i,
    /<\/?invoke\b/i,
    /<\/?(write_file|read_file|edit_file|run_shell|run_command|exec)\b/i,
    /<\/?parameter\b/i,
    /<\/?antml:/i
  ];
  return patterns.some((p) => p.test(text));
}

/**
 * Write-boundary check (C3): every touched path must live under an allowed root,
 * and — when declaredFiles is given — must be one of the declared files.
 * Returns { ok, violations: [{ path, kind }] } where kind is 'wrong_root'|'undeclared'.
 */
function checkWriteBoundary({ touched = [], allowedRoots = [], declaredFiles = null } = {}) {
  const norm = (p) => String(p).replace(/\\/g, '/').replace(/\/+$/, '');
  const roots = allowedRoots.map(norm);
  const declared = declaredFiles ? declaredFiles.map(norm) : null;
  const violations = [];
  for (const raw of touched) {
    const p = norm(raw);
    const underRoot = roots.length === 0 ? true : roots.some((r) => p === r || p.startsWith(r + '/'));
    if (!underRoot) { violations.push({ path: p, kind: 'wrong_root' }); continue; }
    if (declared && !declared.includes(p)) violations.push({ path: p, kind: 'undeclared' });
  }
  return { ok: violations.length === 0, violations };
}

function describeContract(c = {}) {
  const missing = [];
  if (!c.assignmentOk) missing.push('assignment');
  if (!c.artifactOk) missing.push('artifact');
  if (!c.feedbackOk) missing.push('feedback');
  if (!c.donePresent) missing.push('DONE');
  return missing.length ? `missing ${missing.join('+')}` : 'ok';
}

function evalGates(evidence = {}) {
  const e = evidence;
  const tools = e.tools || {};
  const contract = e.contract || {};
  const readyRank = rankReadiness(e.readinessStage);

  // C0 — reachable
  const c0 = e.reachable === true || readyRank >= READINESS_RANK.available;

  // C1 — primitive tools (explicit successes preferred; readiness>=profiled is a proxy)
  const toolsAllOk = !!(tools.read && tools.write && tools.edit && tools.exec);
  const c1ByReadiness = readyRank >= READINESS_RANK.profiled;
  const c1 = toolsAllOk || c1ByReadiness;

  // C2 — scratch contract
  const c2 = !!(contract.assignmentOk && contract.artifactOk && contract.feedbackOk && contract.donePresent);

  // C3 — robustness under noise
  const responseText = (e.response && e.response.text) || e.responseText || '';
  const leak = detectToolXmlLeak(responseText);
  const boundary = e.boundary ? checkWriteBoundary(e.boundary) : { ok: true, violations: [] };
  const c3 = c2 && !leak && boundary.ok;

  // C4 — real-repo (signals produced by 0296b; graded here)
  const c4ev = e.c4 || {};
  const bounds = e.bounds || {};
  const diffFilesOk = c4ev.diffFiles == null || bounds.maxDiffFiles == null || c4ev.diffFiles <= bounds.maxDiffFiles;
  const diffBytesOk = c4ev.diffBytes == null || bounds.maxDiffBytes == null || c4ev.diffBytes <= bounds.maxDiffBytes;
  const npmOk = c4ev.npmTestExit === 0;
  const verifyOk = c4ev.verificationArtifact === true;
  const c4 = c3 && diffFilesOk && diffBytesOk && npmOk && verifyOk;

  const c3Reason = !c2 ? 'blocked: C2 not met'
    : leak ? 'tool-call XML leaked into the response'
      : !boundary.ok ? `write-boundary violation: ${boundary.violations.map((v) => `${v.path}(${v.kind})`).join(', ')}`
        : 'C2 + no tool-XML leak + writes in bounds';

  const c4Reason = !c3 ? 'blocked: C3 not met'
    : !npmOk ? `npm test exit=${c4ev.npmTestExit}`
      : !verifyOk ? 'no verification artifact'
        : !(diffFilesOk && diffBytesOk) ? 'diff exceeds bounds'
          : 'C3 + diff in bounds + npm test green + verification artifact';

  return {
    C0: { pass: c0, reason: c0 ? (e.reachable ? 'reachable probe ok' : `readiness=${e.readinessStage}`) : 'unreachable and no readiness' },
    C1: { pass: c1, reason: c1 ? (toolsAllOk ? 'read+write+edit+exec ok' : `readiness>=profiled (${e.readinessStage})`) : 'a primitive tool failed and readiness<profiled' },
    C2: { pass: c2, reason: c2 ? 'claim+artifact+feedback+DONE ok' : `contract ${describeContract(contract)}` },
    C3: { pass: c3, reason: c3Reason },
    C4: { pass: c4, reason: c4Reason }
  };
}

/**
 * Decide the highest CONTIGUOUS capability tier.
 * @returns { tier: 'C0'..'C4'|null, passed: Boolean, reason: String, perTier: {..} }
 */
function decideCapabilityTier(evidence = {}) {
  const gates = evalGates(evidence);
  const perTier = {};
  let highest = null;
  for (const tier of TIER_ORDER) {
    perTier[tier] = gates[tier];
    if (gates[tier].pass) highest = tier;
    else break; // contiguity: stop at the first failing gate
  }
  const passed = highest != null;
  const reason = passed ? `${highest}: ${gates[highest].reason}` : `below C0: ${gates.C0.reason}`;
  return { tier: highest, passed, reason, perTier };
}

module.exports = {
  decideCapabilityTier,
  detectToolXmlLeak,
  checkWriteBoundary,
  evalGates,
  rankReadiness,
  TIER_ORDER,
  READINESS_RANK
};
