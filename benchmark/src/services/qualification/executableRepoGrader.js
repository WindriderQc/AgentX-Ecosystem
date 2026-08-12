'use strict';

/**
 * executableRepoGrader — deterministic, executable pass/fail grading for a
 * single repository-repair attempt (task 0452, the reusable core of the
 * "executable repository coding qualification").
 *
 * Motivation: the current coding leaderboard grades ANSWER TEXT with an LLM
 * judge (live coding-judge correlation ~0.544, flagged). This grader instead
 * applies the model's patch to an isolated copy of a fixture repo and runs real
 * test commands. Pass/fail comes purely from process exit codes and a
 * deterministic file-scope diff — NO LLM is allowed to override the verdict.
 *
 * One call grades ONE attempt (one model, one repetition). Aggregation across
 * attempts (pass@k) is done separately via passAtK.buildPassAtKReport over the
 * emitted run records, so this module stays a pure, offline, unit-testable unit.
 *
 * Safety: all work happens inside a throwaway scratch root allocated under the
 * OS temp dir. Reuses calibrationProbes' scratch tripwire so the grader can
 * never mutate the live checkout, and its snapshot/diff to compute patch scope.
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const {
  makeScratchRoot,
  assertScratchRoot,
  snapshotTree,
  diffSnapshots
} = require('./calibrationProbes');

const DEFAULT_TIMEOUT_MS = 30_000;

// Relative, forward-slash form of an absolute path under root. `.git/` is
// excluded elsewhere so the scratch repo's own metadata never counts as scope.
function toRel(root, abs) {
  return path.relative(root, abs).replace(/\\/g, '/');
}

function isGitMeta(rel) {
  return rel === '.git' || rel.startsWith('.git/');
}

/** Write a fixture's inline files into the scratch root (dirs auto-created). */
function materializeFiles(root, files) {
  for (const [rel, content] of Object.entries(files || {})) {
    const dest = path.join(root, rel);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, content == null ? '' : String(content));
  }
}

/**
 * Materialize a fixture into a fresh scratch git repo. A fixture is either
 * `{ files: {rel: content} }` (inline, used by tests) and/or
 * `{ fixtureDir: '<abs path>' }` (copied recursively). We `git init` so patch
 * application is robust; `.git/` is filtered out of every scope computation.
 */
function materializeFixture(root, fixture) {
  if (fixture.fixtureDir) {
    fs.cpSync(fixture.fixtureDir, root, { recursive: true });
  }
  if (fixture.files) {
    materializeFiles(root, fixture.files);
  }
  spawnSync('git', ['init', '-q'], { cwd: root });
  // Identity is required for nothing we do here, but keep git quiet/deterministic.
  spawnSync('git', ['config', 'user.email', 'grader@agentx.local'], { cwd: root });
  spawnSync('git', ['config', 'user.name', 'agentx-grader'], { cwd: root });
}

/**
 * Apply a unified diff to the scratch tree with `git apply`. Returns
 * {applied, error}. Never throws for a rejected patch — a patch that does not
 * apply is a legitimate (failing) grading outcome, not a grader crash.
 */
function applyUnifiedDiff(root, diff, { strip = 1 } = {}) {
  if (typeof diff !== 'string' || diff.trim() === '') {
    return { applied: false, error: 'empty patch' };
  }
  const res = spawnSync(
    'git',
    ['apply', '--whitespace=nowarn', `-p${strip}`, '-'],
    { cwd: root, input: diff, encoding: 'utf8' }
  );
  if (res.status === 0) return { applied: true, error: null };
  return {
    applied: false,
    error: (res.stderr || res.stdout || `git apply exited ${res.status}`).trim()
  };
}

/** Run one test command inside the scratch root. pass === (exit code 0). */
function runCommand(root, command, timeoutMs) {
  if (!command || !command.cmd) return { ran: false, pass: false, exitCode: null, timedOut: false };
  const res = spawnSync(command.cmd, command.args || [], {
    cwd: root,
    timeout: timeoutMs,
    encoding: 'utf8'
  });
  const timedOut = res.error && res.error.code === 'ETIMEDOUT';
  return {
    ran: true,
    pass: !timedOut && res.status === 0,
    exitCode: res.status,
    timedOut: Boolean(timedOut),
    stdout: res.stdout || '',
    stderr: res.stderr || ''
  };
}

/**
 * Files touched by the patch, relative + sorted, excluding git metadata.
 * `allowedPaths` (relative, exact file paths or `dir/` prefixes) declares the
 * legal edit surface; anything else is an out-of-scope violation.
 */
function computeScope(root, before, after, allowedPaths) {
  const touchedAbs = diffSnapshots(before, after);
  const touched = touchedAbs
    .map((abs) => toRel(root, abs))
    .filter((rel) => rel && !isGitMeta(rel));
  const allow = Array.isArray(allowedPaths) ? allowedPaths.map((p) => p.replace(/\\/g, '/')) : null;
  const inAllow = (rel) => !allow || allow.some((a) => (a.endsWith('/') ? rel.startsWith(a) : rel === a));
  const outOfScope = allow ? touched.filter((rel) => !inAllow(rel)) : [];
  return { touched, outOfScope };
}

/**
 * Grade one repository-repair attempt.
 *
 * fixture: {
 *   files?: {rel: content}, fixtureDir?: absPath,
 *   publicTest: {cmd, args?},         // repair target; must PASS post-patch
 *   hiddenTest?: {cmd, args?},        // hidden repair target; must PASS post-patch
 *   regressionTest?: {cmd, args?},    // must be green BEFORE and AFTER the patch
 *   allowedPaths?: [rel...]           // legal edit surface; else scope violation
 * }
 * diff: unified diff string produced by the candidate model.
 *
 * Returns a run record whose `grade.pass` is a pure conjunction of executable
 * outcomes. `model`/`attempt`/`task` are passed through for pass@k grouping.
 */
function gradeRun({ fixture, diff, model = 'unknown', attempt = 1, task = 'repo-repair', timeoutMs = DEFAULT_TIMEOUT_MS, keepScratch = false } = {}) {
  if (!fixture || !fixture.publicTest || !fixture.publicTest.cmd) {
    throw new Error('gradeRun: fixture.publicTest.cmd is required');
  }
  const startedAt = Date.now();
  const root = assertScratchRoot(makeScratchRoot('repo-grade-'));
  try {
    materializeFixture(root, fixture);

    // Regression baseline: whatever must stay green has to be green pre-patch,
    // otherwise the fixture itself is broken and the run is inconclusive.
    const regressionBefore = fixture.regressionTest
      ? runCommand(root, fixture.regressionTest, timeoutMs)
      : null;

    const before = snapshotTree(root);
    const apply = applyUnifiedDiff(root, diff, { strip: fixture.strip ?? 1 });

    if (!apply.applied) {
      return finalize({
        task, model, attempt, root, keepScratch, startedAt,
        grade: {
          pass: false, applied: false, publicPass: false, hiddenPass: null,
          regressionPass: null, scopeViolation: false, reason: `patch_did_not_apply: ${apply.error}`
        },
        touchedFiles: [], outOfScope: []
      });
    }

    const after = snapshotTree(root);
    const { touched, outOfScope } = computeScope(root, before, after, fixture.allowedPaths);

    const publicRes = runCommand(root, fixture.publicTest, timeoutMs);
    const hiddenRes = fixture.hiddenTest ? runCommand(root, fixture.hiddenTest, timeoutMs) : null;
    const regressionAfter = fixture.regressionTest ? runCommand(root, fixture.regressionTest, timeoutMs) : null;

    const scopeViolation = outOfScope.length > 0;
    const publicPass = publicRes.pass;
    const hiddenPass = hiddenRes ? hiddenRes.pass : null;
    // Regression is satisfied only if it was green before AND stays green after.
    const regressionPass = fixture.regressionTest
      ? Boolean(regressionBefore?.pass && regressionAfter?.pass)
      : null;

    const pass = Boolean(
      publicPass &&
      (hiddenRes ? hiddenPass : true) &&
      (fixture.regressionTest ? regressionPass : true) &&
      !scopeViolation
    );

    const reason = pass
      ? 'all_executable_checks_passed'
      : [
        !publicPass ? 'public_test_failed' : null,
        hiddenRes && !hiddenPass ? 'hidden_test_failed' : null,
        fixture.regressionTest && !regressionPass ? 'regression_failed' : null,
        scopeViolation ? `out_of_scope_edits: ${outOfScope.join(', ')}` : null
      ].filter(Boolean).join('; ');

    return finalize({
      task, model, attempt, root, keepScratch, startedAt,
      grade: { pass, applied: true, publicPass, hiddenPass, regressionPass, scopeViolation, reason },
      touchedFiles: touched, outOfScope
    });
  } catch (err) {
    return finalize({
      task, model, attempt, root, keepScratch, startedAt,
      grade: {
        pass: false, applied: false, publicPass: false, hiddenPass: null,
        regressionPass: null, scopeViolation: false, reason: `grader_error: ${err.message}`
      },
      touchedFiles: [], outOfScope: []
    });
  }
}

function finalize({ task, model, attempt, root, keepScratch, startedAt, grade, touchedFiles, outOfScope }) {
  const record = {
    task,
    model,
    attempt,
    grade,
    touchedFiles,
    outOfScope,
    scratchRoot: keepScratch ? root : null,
    durationMs: Date.now() - startedAt
  };
  if (!keepScratch) {
    try { fs.rmSync(root, { recursive: true, force: true }); } catch (_) { /* best-effort */ }
  }
  return record;
}

/** Serialize a run record as one JSONL line (decoupled-JSONL grading output). */
function toJsonlLine(record) {
  return JSON.stringify(record);
}

module.exports = {
  gradeRun,
  toJsonlLine,
  // exported for unit tests / reuse
  applyUnifiedDiff,
  computeScope,
  runCommand,
  materializeFixture
};
