'use strict';

/**
 * repoQualificationRunner — the reusable core of the executable repository
 * coding qualification (task 0452). It turns each repair fixture into a model
 * prompt, extracts a unified diff from the model's reply, and grades it with the
 * deterministic executableRepoGrader — NO LLM judge anywhere in the verdict.
 *
 * This module is intentionally free of I/O side effects beyond reading the
 * fixture source files: the network call is injected as `callModel`, and record
 * persistence is delegated to an `onRecord` callback. That keeps the whole
 * runner verifiable offline — `runQualification({ dryRun: true })` grades each
 * task's golden solution.diff instead of calling a model, which must yield
 * pass@1 = 1.0. The thin CLI (scripts/repo-coding-qualification.js) wires in the
 * real Ollama client, JSONL output, and the host-claim wrapper.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const { gradeRun } = require('./executableRepoGrader');
const { buildPassAtKReport, wilsonInterval } = require('./passAtK');

const DEFAULT_KS = [1, 3];
const DEFAULT_TIMEOUT_MS = 30_000;

/** Read one repo-relative file from a fixture's on-disk repo directory. */
function readFixtureFile(fixtureDir, relPath) {
  return fs.readFileSync(path.join(fixtureDir, relPath), 'utf8');
}

/**
 * The relative path of a `{ cmd: 'node', args: ['test/public.js'] }` style test
 * command — i.e. the script file the command runs, if it is a plain file arg.
 */
function testFilePath(testCmd) {
  if (!testCmd || !Array.isArray(testCmd.args)) return null;
  const fileArg = testCmd.args.find((a) => typeof a === 'string' && /\.[cm]?js$/.test(a));
  return fileArg || null;
}

/**
 * Assemble the context a candidate is shown for one task: the editable source
 * files (the declared `allowedPaths`) and the public test. The hidden and
 * regression tests are deliberately withheld — they only judge the result.
 */
function readTaskContext(task) {
  const { fixtureDir, allowedPaths, publicTest } = task.fixture;
  const editablePaths = Array.isArray(allowedPaths) && allowedPaths.length
    ? allowedPaths
    : [];
  const editable = editablePaths.map((rel) => ({
    path: rel,
    content: readFixtureFile(fixtureDir, rel)
  }));

  const publicPath = testFilePath(publicTest);
  const publicTestFile = publicPath
    ? { path: publicPath, content: readFixtureFile(fixtureDir, publicPath) }
    : null;

  return { editable, publicTest: publicTestFile };
}

function fence(lang, body) {
  return `\`\`\`${lang}\n${body.replace(/\n?$/, '\n')}\`\`\``;
}

/**
 * Build the repair prompt for one task. The model is given the editable source
 * and the public test, and instructed to return ONLY a unified diff that
 * `git apply -p1` can apply from the repo root, touching only the allowed files.
 */
function buildRepairPrompt(task, { context } = {}) {
  const ctx = context || readTaskContext(task);
  const allowed = ctx.editable.map((f) => f.path);

  const lines = [
    'You are completing a bounded task in a small JavaScript repository.',
    'Implement the stated requirements so the tests pass. Change as little as possible.',
    '',
    `## Task`,
    task.title || task.id,
    '',
    task.instructions || task.title || task.id,
    '',
    '## Editable files (you may modify ONLY these)'
  ];
  for (const file of ctx.editable) {
    lines.push('', `### ${file.path}`, fence('javascript', file.content));
  }
  if (ctx.publicTest) {
    lines.push(
      '',
      `## Public test — must pass after your fix (file: ${ctx.publicTest.path})`,
      fence('javascript', ctx.publicTest.content)
    );
  }
  lines.push(
    '',
    '## Response format — READ CAREFULLY',
    'Return ONLY a unified diff that `git apply -p1` can apply from the repository root.',
    '- Use `--- a/<path>` and `+++ b/<path>` headers and correct `@@` hunks.',
    `- Modify ONLY these files: ${allowed.join(', ') || '(the editable files above)'}.`,
    '- Do NOT create, delete, or rename any other file.',
    '- Output the diff and nothing else: no prose, no explanation, no markdown code fences.'
  );
  return lines.join('\n');
}

// A line that legitimately belongs to a unified diff body: the git/file/hunk
// headers, context/added/removed lines, or the "\ No newline" marker.
const DIFF_LINE_RE = /^(diff --git |diff |index |--- |\+\+\+ |@@|[ +-]|\\)/;

/**
 * Trim a candidate diff down to its actual diff body: drop any leading lines
 * before the first header and any trailing prose after the last diff line.
 * Models frequently append an explanation ("This fixes the sign bug.") after
 * the patch; git apply then reports a "corrupt patch" at the first prose line,
 * so a correct fix would be scored as a format failure without this trim.
 */
function trimToDiff(body) {
  const lines = String(body).replace(/\r\n/g, '\n').split('\n');
  let first = -1;
  let last = -1;
  for (let i = 0; i < lines.length; i += 1) {
    if (DIFF_LINE_RE.test(lines[i])) {
      if (first === -1) first = i;
      last = i;
    }
  }
  if (first === -1) return '';
  return lines.slice(first, last + 1).join('\n') + '\n';
}

/**
 * Robustly recover a unified diff from a model response. Models wrap diffs in
 * ```diff fences, in plain ``` fences, or emit prose around them; some emit the
 * raw diff followed by an explanation. We prefer a fenced block that looks like
 * a diff, else slice from the first diff marker — then trim to the diff body so
 * trailing prose does not corrupt the patch. A still-malformed result is fine —
 * git apply rejects it and that is a legitimate failing grade, not a crash.
 */
function extractDiff(text) {
  if (typeof text !== 'string') return '';
  const looksLikeDiff = (s) => /(^|\n)(diff --git |--- |\+\+\+ |@@ )/.test(s);

  // 1) Fenced code blocks — prefer the first one that looks like a diff.
  const fenceRe = /```[ \t]*([a-zA-Z0-9_-]*)[ \t]*\r?\n([\s\S]*?)```/g;
  let match;
  let firstBlock = null;
  while ((match = fenceRe.exec(text)) !== null) {
    const lang = (match[1] || '').toLowerCase();
    const body = match[2];
    if (firstBlock === null) firstBlock = body;
    if (lang === 'diff' || lang === 'patch' || looksLikeDiff(body)) {
      return trimToDiff(body);
    }
  }

  // 2) No diff-shaped fence: slice from the first diff marker in the raw text,
  //    then trim trailing prose off the end.
  const markerRe = /(^|\n)(diff --git |--- )/;
  const m = markerRe.exec(text);
  if (m) {
    const start = m.index + (m[1] ? m[1].length : 0);
    return trimToDiff(text.slice(start));
  }

  // 3) A single fenced block with no diff markers — keep only diff-shaped lines.
  if (firstBlock !== null) return trimToDiff(firstBlock);
  // Nothing diff-shaped anywhere: return empty so the contract records
  // no_diff_in_final rather than feeding prose to git apply.
  return '';
}

/**
 * Normalize a model reply into the fields the response contract needs. Accepts
 * either a plain string (treated as the final answer) or a structured object
 * from the Ollama /api/chat response: `content` is the FINAL answer, `thinking`
 * is the separate reasoning channel, `doneReason` is Ollama's stop reason.
 */
function normalizeResponse(reply) {
  if (reply == null) return { content: '', thinking: '', doneReason: null, metrics: null };
  if (typeof reply === 'string') return { content: reply, thinking: '', doneReason: null, metrics: null };
  return {
    content: typeof reply.content === 'string' ? reply.content : '',
    thinking: typeof reply.thinking === 'string' ? reply.thinking : '',
    doneReason: reply.doneReason || reply.done_reason || null,
    metrics: reply.metrics && typeof reply.metrics === 'object' ? { ...reply.metrics } : null
  };
}

function sha256(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

function diffStats(diff) {
  const lines = String(diff || '').replace(/\r\n/g, '\n').split('\n');
  return {
    addedLines: lines.filter((line) => line.startsWith('+') && !line.startsWith('+++')).length,
    removedLines: lines.filter((line) => line.startsWith('-') && !line.startsWith('---')).length
  };
}

/**
 * The response contract for this executable mode: ONLY the model's final answer
 * (message.content) is executable. The thinking channel is reasoning, never a
 * diff substitute — a reply that produced no final answer is a contract failure,
 * not something to salvage from its thoughts. Contract violations:
 *   - empty_response      no final answer and no thinking (model returned nothing)
 *   - thinking_only       reasoning present but no final answer was emitted
 *   - truncated_no_final  generation hit the output cap (done_reason "length")
 *                         before emitting the final answer
 *   - no_diff_in_final    a final answer was emitted but contained no diff
 *
 * Returns { ok, violation, diff }. `diff` is extracted from the FINAL answer
 * only; on any violation it is null and no grading is attempted.
 */
const CONTRACT_VIOLATIONS = ['empty_response', 'thinking_only', 'truncated_no_final', 'no_diff_in_final'];
const UNRANKABLE_CONTRACT_VIOLATIONS = ['empty_response', 'thinking_only', 'truncated_no_final', 'model_call_failed'];

function isRankableContractOutcome(violation) {
  return !UNRANKABLE_CONTRACT_VIOLATIONS.includes(violation);
}

function evaluateResponseContract(reply) {
  const { content, thinking, doneReason } = normalizeResponse(reply);
  const finalAnswer = content.trim();
  if (!finalAnswer) {
    let violation;
    if (doneReason === 'length') violation = 'truncated_no_final';
    else if (thinking.trim()) violation = 'thinking_only';
    else violation = 'empty_response';
    return { ok: false, violation, diff: null };
  }
  // Extract ONLY from the final answer — never from `thinking`.
  const diff = extractDiff(content);
  if (!diff.trim()) return { ok: false, violation: 'no_diff_in_final', diff: null };
  return { ok: true, violation: null, diff };
}

/**
 * Build a run record for a contract failure — the same shape gradeRun emits, but
 * with no test execution (there was no valid patch to run). Kept distinct from
 * a patch that applied-but-failed so per-mode reports can separate "the model
 * never produced an executable answer" from "the model's fix was wrong".
 */
function makeContractFailureRecord({ task, model, attempt, violation }) {
  return {
    task,
    model,
    attempt,
    grade: {
      pass: false,
      applied: false,
      publicPass: false,
      hiddenPass: null,
      regressionPass: null,
      scopeViolation: false,
      reason: `contract_violation: ${violation}`
    },
    touchedFiles: [],
    outOfScope: [],
    scratchRoot: null,
    durationMs: 0
  };
}

/**
 * Classify a graded record into one coarse outcome for per-mode reporting:
 * pass | contract:<violation> | patch_failed | test_failed | model_call_failed.
 */
function classifyOutcome(record) {
  if (record.grade.pass) return 'pass';
  if (record.callError) return 'model_call_failed';
  const reason = record.grade.reason || '';
  if (reason.startsWith('contract_violation')) return `contract:${reason.split(': ')[1] || 'unknown'}`;
  if (/patch_did_not_apply/.test(reason)) return 'patch_failed';
  return 'test_failed';
}

/** Aggregate per-model outcome counts so a report can show WHY runs failed. */
function summarizeOutcomes(records) {
  const byModel = {};
  for (const r of records) {
    const m = r.model;
    (byModel[m] ??= {});
    const o = classifyOutcome(r);
    byModel[m][o] = (byModel[m][o] || 0) + 1;
  }
  return byModel;
}

/**
 * Run the executable qualification across models × attempts × tasks, in ONE
 * explicitly-labeled decode mode. Modes are never mixed in a single run so that
 * scores stay comparable; the mode and the exact decode params are recorded on
 * every record and in the summary.
 *
 * @param {Object}   opts
 * @param {Array}    opts.tasks       loaded fixtures (repoTaskFixtures.loadRepoTasks()).
 * @param {string[]} opts.models      candidate model ids.
 * @param {number}   opts.attempts    repetitions per (model, task) — pass@k needs >= k.
 * @param {Function} opts.callModel   async ({ model, prompt, task, attempt }) => reply,
 *                                     where reply is a string or { content, thinking,
 *                                     doneReason }. Only `content` is executable.
 *                                     Ignored when dryRun is true.
 * @param {boolean}  opts.dryRun      grade each task's golden solution.diff instead of
 *                                     calling a model (offline verification; pass@1 = 1.0).
 * @param {string}   opts.mode        decode-mode label recorded with every result
 *                                     (e.g. 'native', 'think-false', 'think-true').
 * @param {Object}   opts.params      decode params recorded with every result.
 * @param {number[]} opts.ks          pass@k values to report (default [1, 3]).
 * @param {number}   opts.timeoutMs   per-test timeout handed to gradeRun.
 * @param {Function} opts.onRecord    optional (record, meta) => void per graded run.
 * @param {number[]} opts.attemptSeeds deterministic seed schedule, one per attempt.
 * @param {Function} opts.beforeModel optional async artifact-drift guard per model block.
 * @param {Function} opts.modelProvenance returns frozen artifact/contract metadata.
 * @returns {Promise<{records, perModel, perTask, outcomes, meta}>}
 */
async function runQualification({
  tasks,
  models,
  attempts = 3,
  callModel,
  dryRun = false,
  mode = dryRun ? 'dry-run' : 'native',
  params = null,
  ks = DEFAULT_KS,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  onRecord = null,
  attemptSeeds = [],
  beforeModel = null,
  modelProvenance = null
} = {}) {
  if (!Array.isArray(tasks) || tasks.length === 0) {
    throw new Error('runQualification: tasks is required and must be non-empty');
  }
  if (!Array.isArray(models) || models.length === 0) {
    throw new Error('runQualification: models is required and must be non-empty');
  }
  if (!Number.isInteger(attempts) || attempts < 1) {
    throw new Error('runQualification: attempts must be a positive integer');
  }
  if (!dryRun && typeof callModel !== 'function') {
    throw new Error('runQualification: callModel is required unless dryRun is true');
  }
  if (attemptSeeds.length > 0 && attemptSeeds.length < attempts) {
    throw new Error('runQualification: attemptSeeds must contain at least one seed per attempt');
  }

  const records = [];
  for (const model of models) {
    if (!dryRun && typeof beforeModel === 'function') await beforeModel({ model });
    const frozenModelProvenance = typeof modelProvenance === 'function'
      ? modelProvenance(model)
      : null;
    for (const task of tasks) {
      const context = readTaskContext(task);
      const prompt = buildRepairPrompt(task, { context });
      const promptFingerprint = sha256(prompt);
      for (let attempt = 1; attempt <= attempts; attempt += 1) {
        let record;
        let response = null;
        let callError = null;

        if (dryRun) {
          // Offline gate: the golden diff is, by definition, the final answer.
          record = gradeRun({ fixture: task.fixture, diff: task.solutionDiff, model, attempt, task: task.id, timeoutMs });
          record.contract = { ok: true, violation: null, rankable: true };
          record.patchStats = diffStats(task.solutionDiff);
        } else {
          try {
            response = normalizeResponse(await callModel({
              model,
              prompt,
              task,
              attempt,
              seed: attemptSeeds[attempt - 1] ?? null
            }));
          } catch (err) {
            callError = err.message || String(err);
            response = { content: '', thinking: '', doneReason: null };
          }

          if (callError) {
            record = makeContractFailureRecord({ task: task.id, model, attempt, violation: 'empty_response' });
            record.contract = { ok: false, violation: 'model_call_failed', rankable: false };
            record.callError = callError;
            record.grade.reason = `model_call_failed: ${callError}`;
          } else {
            const contract = evaluateResponseContract(response);
            if (!contract.ok) {
              // Contract failure: no executable final answer. Do NOT run tests,
              // and NEVER fall back to the thinking channel as the diff.
              record = makeContractFailureRecord({ task: task.id, model, attempt, violation: contract.violation });
              record.contract = {
                ok: false,
                violation: contract.violation,
                rankable: isRankableContractOutcome(contract.violation)
              };
            } else {
              record = gradeRun({ fixture: task.fixture, diff: contract.diff, model, attempt, task: task.id, timeoutMs });
              record.contract = { ok: true, violation: null, rankable: true };
              record.patchStats = diffStats(contract.diff);
            }
          }
        }

        // Provenance the grader does not carry: decode mode, exact params, and
        // response shape so every JSONL row is self-describing and auditable.
        record.mode = mode;
        record.params = params ? { ...params } : null;
        record.dryRun = dryRun;
        record.seed = attemptSeeds[attempt - 1] ?? null;
        record.promptFingerprint = promptFingerprint;
        record.taskProvenance = {
          id: task.id,
          title: task.title || task.id,
          category: task.category || null,
          language: task.language || null,
          fixtureFingerprint: task.fixtureFingerprint || null,
          allowedPaths: [...(task.fixture.allowedPaths || [])]
        };
        record.inferenceContract = frozenModelProvenance
          ? { ...frozenModelProvenance }
          : null;
        record.responseChars = response ? response.content.length : null;
        record.thinkingChars = response ? response.thinking.length : null;
        record.doneReason = response ? response.doneReason : null;
        record.modelCall = response?.metrics ? { ...response.metrics } : null;
        if (!record.patchStats) record.patchStats = { addedLines: 0, removedLines: 0 };

        records.push(record);
        if (onRecord) onRecord(record, { model, task: task.id, attempt, response });
      }
    }
  }

  const outcomes = summarizeOutcomes(records);
  const perTask = {};
  for (const task of tasks) {
    perTask[task.id] = buildPassAtKReport(
      records.filter((r) => r.task === task.id),
      { ks }
    ).map((row) => {
      const taskModelRecords = records.filter((record) => record.task === task.id && record.model === row.model);
      const unrankableSamples = taskModelRecords.filter((record) => record.contract?.rankable === false).length;
      return {
        ...row,
        rankable: unrankableSamples === 0,
        unrankableSamples,
        passAtK: unrankableSamples === 0 ? row.passAtK : null
      };
    });
  }
  // pass@k is defined across repeated samples of the same problem. Compute it
  // per task first, then macro-average those task-level estimates; pooling all
  // heterogeneous tasks as if they were attempts of one problem is invalid.
  const perModel = models.map((model) => {
    const modelRecords = records.filter((record) => record.model === model);
    const correct = modelRecords.filter((record) => record.grade.pass).length;
    const unrankableRecords = modelRecords.filter((record) => record.contract?.rankable === false);
    const rankable = unrankableRecords.length === 0;
    const taskRows = tasks.map((task) => ({
      task: task.id,
      row: perTask[task.id].find((entry) => entry.model === model)
    }));
    const meanPassAtK = {};
    for (const k of ks) {
      const values = taskRows.map(({ row }) => row?.passAtK?.[`pass@${k}`]).filter(Number.isFinite);
      if (values.length === tasks.length) {
        meanPassAtK[`pass@${k}`] = values.reduce((sum, value) => sum + value, 0) / values.length;
      }
    }
    return {
      model,
      samples: modelRecords.length,
      correct,
      rankable,
      rankingStatus: rankable ? 'rankable' : 'unrankable_contract',
      unrankableSamples: unrankableRecords.length,
      unrankableOutcomes: summarizeOutcomes(unrankableRecords)[model] || {},
      observedPassRate: rankable && modelRecords.length ? correct / modelRecords.length : null,
      passRateInterval95: rankable && modelRecords.length ? wilsonInterval(correct, modelRecords.length) : null,
      passAtK: rankable ? meanPassAtK : null,
      tasksPassedAtLeastOnce: taskRows.filter(({ row }) => (row?.correct || 0) > 0).length,
      zeroPassTasks: taskRows.filter(({ row }) => (row?.correct || 0) === 0).map(({ task }) => task)
    };
  });

  return {
    records,
    perModel,
    perTask,
    outcomes,
    meta: {
      models: [...models],
      tasks: tasks.map((t) => t.id),
      attempts,
      dryRun,
      mode,
      params: params ? { ...params } : null,
      ks: [...ks],
      attemptSeeds: attemptSeeds.slice(0, attempts),
      totalRuns: records.length
    }
  };
}

module.exports = {
  readTaskContext,
  buildRepairPrompt,
  extractDiff,
  trimToDiff,
  normalizeResponse,
  evaluateResponseContract,
  diffStats,
  CONTRACT_VIOLATIONS,
  UNRANKABLE_CONTRACT_VIOLATIONS,
  isRankableContractOutcome,
  classifyOutcome,
  summarizeOutcomes,
  runQualification,
  sha256,
  testFilePath
};
