#!/usr/bin/env node
'use strict';

/**
 * repo-coding-qualification — executable coding leaderboard runner (task 0452).
 *
 * Replaces the LLM text-judge coding leaderboard (live correlation ~0.544) with
 * pass/fail grading you can trust: give each candidate model a repository-repair
 * fixture, take its unified diff, apply it in an isolated scratch repo, run the
 * public + hidden tests, and score PURELY from exit codes (executableRepoGrader).
 * Aggregated with the unbiased pass@k estimator. No judge model anywhere.
 *
 * Offline-first: `--dry-run` grades each task's golden solution.diff instead of
 * calling a model, so the whole runner is provable (pass@1 = 1.0) before any GPU
 * spend. Do NOT run the live campaign without the operator's go.
 *
 * Live runs are disruptive (they load big models on a shared host), so wrap this
 * in the benchmark host-claim lifecycle rather than calling a host cold:
 *
 *   node scripts/with-agentx-claim.js \
 *     --host <ollama-url> \
 *     --owner claude-code --batch repo-coding-qual-$(date +%Y%m%d%H%M%S) \
 *     --estimate-ms 3600000 -- \
 *     node benchmark/scripts/repo-coding-qualification.js \
 *       --host <ollama-url> --core <core-url> \
 *       --models <model-a,model-b> --attempts 3
 *
 * Verify offline first:
 *   node benchmark/scripts/repo-coding-qualification.js --dry-run
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { readBoundedJson } = require('../../scripts/bounded-response');

const { loadRepoTasks } = require('../src/services/qualification/repoTaskFixtures');
const { toJsonlLine } = require('../src/services/qualification/executableRepoGrader');
const {
  buildRepairPrompt,
  runQualification,
  sha256
} = require('../src/services/qualification/repoQualificationRunner');
const { getFetchOptions } = require('../src/helpers/httpAgent');
const { benchmarkFetch } = require('../src/services/benchmark/http');
const {
  assertFrozenArtifactDigest,
  getFrozenModelExecutionConfig,
  resolveStandaloneCampaignInferenceContracts
} = require('../src/services/benchmark/inferenceContractSnapshot');

const DEFAULT_ATTEMPTS = 5;
const DEFAULT_KS = [1, 3, 5];
const DEFAULT_ATTEMPT_SEEDS = [101, 202, 303, 404, 505];
const DEFAULT_NUM_CTX = 8192;
// Generous output budget: reasoning models in this fleet (gemma4 a4b, Qwen3.5
// a3b) spend hundreds of tokens in the thinking channel and get truncated
// (done_reason "length") before emitting the patch under the ~512 default,
// scoring a spurious 0. 4096 lets them finish reasoning AND answer.
const DEFAULT_NUM_PREDICT = 4096;
// Hard floor: every mode's matrix must use the same generous output budget, and
// it must be large enough that reasoning models are not truncated pre-answer.
const MIN_NUM_PREDICT = 4096;
// Non-zero so N attempts are independent samples — pass@k is meaningless if a
// greedy (temp 0) decode returns the same diff every attempt.
const DEFAULT_TEMPERATURE = 0.2;
const DEFAULT_TOP_P = 0.95;
const DEFAULT_TOP_K = 40;
const DEFAULT_REPEAT_PENALTY = 1.1;
const DEFAULT_RESPONSE_MODE = 'final_only';
const DEFAULT_MODEL_TIMEOUT_MS = 600_000; // generous: 30B on a shared host
const DEFAULT_GRADE_TIMEOUT_MS = 30_000;
const CORE_CLAIM_TIMEOUT_MS = 10_000;
const MAX_CORE_CLAIM_RESPONSE_BYTES = 1024 * 1024;
const DEFAULT_OUTPUT_ROOT = path.join(__dirname, '..', '.agentx', 'reports', 'repo-coding-qualification');

function parseList(value) {
  return String(value).split(',').map((s) => s.trim()).filter(Boolean);
}

function parseArgs(argv) {
  const args = {
    models: null,
    attempts: DEFAULT_ATTEMPTS,
    tasks: null,
    out: null,
    dryRun: false,
    host: null,
    core: null,
    claimId: null,
    numCtx: DEFAULT_NUM_CTX,
    numPredict: DEFAULT_NUM_PREDICT,
    temperature: DEFAULT_TEMPERATURE,
    topP: DEFAULT_TOP_P,
    topK: DEFAULT_TOP_K,
    repeatPenalty: DEFAULT_REPEAT_PENALTY,
    responseMode: DEFAULT_RESPONSE_MODE,
    seeds: DEFAULT_ATTEMPT_SEEDS,
    modelTimeoutMs: DEFAULT_MODEL_TIMEOUT_MS,
    gradeTimeoutMs: DEFAULT_GRADE_TIMEOUT_MS,
    ks: DEFAULT_KS
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => argv[++i];
    if (arg === '--dry-run') args.dryRun = true;
    else if (arg === '--models') args.models = parseList(next());
    else if (arg === '--attempts') args.attempts = Number(next());
    else if (arg === '--tasks') args.tasks = parseList(next());
    else if (arg === '--out') args.out = next();
    else if (arg === '--host') args.host = next();
    else if (arg === '--core') args.core = next();
    else if (arg === '--claim-id') args.claimId = next();
    else if (arg === '--num-ctx') args.numCtx = Number(next());
    else if (arg === '--num-predict') args.numPredict = Number(next());
    else if (arg === '--temperature') args.temperature = Number(next());
    else if (arg === '--top-p') args.topP = Number(next());
    else if (arg === '--top-k') args.topK = Number(next());
    else if (arg === '--repeat-penalty') args.repeatPenalty = Number(next());
    else if (arg === '--seeds') args.seeds = parseList(next()).map(Number);
    else if (arg === '--response-mode') args.responseMode = String(next()).trim().toLowerCase();
    else if (arg === '--think') {
      const v = String(next()).toLowerCase();
      if (v !== 'true' && v !== 'false') throw new Error('--think must be true or false');
      args.responseMode = v === 'true' ? 'explicit_thinking' : 'final_only';
    }
    else if (arg === '--model-timeout-ms') args.modelTimeoutMs = Number(next());
    else if (arg === '--grade-timeout-ms') args.gradeTimeoutMs = Number(next());
    else if (arg === '--ks') args.ks = parseList(next()).map(Number);
    else if (arg === '--help' || arg === '-h') { args.help = true; }
    else throw new Error(`unknown argument: ${arg}`);
  }
  if (!Number.isInteger(args.attempts) || args.attempts < 1 || args.attempts > 25) {
    throw new Error('--attempts must be an integer from 1 to 25');
  }
  if (!args.ks.every((k) => Number.isInteger(k) && k >= 1)) {
    throw new Error('--ks must be a comma list of positive integers');
  }
  if (!Number.isFinite(args.temperature) || args.temperature < 0 || args.temperature > 2) {
    throw new Error('--temperature must be a number in [0, 2]');
  }
  if (!Number.isFinite(args.topP) || args.topP <= 0 || args.topP > 1) throw new Error('--top-p must be in (0, 1]');
  if (!Number.isInteger(args.topK) || args.topK < 1) throw new Error('--top-k must be a positive integer');
  if (!Number.isFinite(args.repeatPenalty) || args.repeatPenalty <= 0) throw new Error('--repeat-penalty must be positive');
  if (!Number.isInteger(args.numCtx) || args.numCtx <= 0) throw new Error('--num-ctx must be a positive integer');
  if (!['final_only', 'native', 'explicit_thinking'].includes(args.responseMode)) {
    throw new Error('--response-mode must be final_only, native, or explicit_thinking');
  }
  if (args.seeds.length < args.attempts || args.seeds.slice(0, args.attempts).some((seed) => !Number.isInteger(seed))) {
    throw new Error('--seeds must provide one integer per attempt');
  }
  if (new Set(args.seeds.slice(0, args.attempts)).size !== args.attempts) {
    throw new Error('--seeds must be unique so attempts are independent');
  }
  if (!args.dryRun && !args.claimId) throw new Error('--claim-id is required for live runs');
  if (!args.dryRun && !args.host) throw new Error('--host is required for live runs');
  if (!args.dryRun && !args.core) throw new Error('--core is required for live runs');
  if (!args.dryRun && !args.models?.length) throw new Error('--models is required for live runs');
  // Uniform output budget floor: reasoning models need room to finish thinking
  // AND emit the final answer. A lower budget silently truncates them, so it is
  // rejected rather than allowed to confound a campaign.
  if (!Number.isInteger(args.numPredict) || args.numPredict < MIN_NUM_PREDICT) {
    throw new Error(`--num-predict must be an integer >= ${MIN_NUM_PREDICT} (uniform output budget)`);
  }
  return args;
}

function usage() {
  process.stdout.write(`Executable repository coding qualification (task 0452)

Usage:
  node benchmark/scripts/repo-coding-qualification.js [options]

Options:
  --dry-run                 Grade each task's golden diff instead of calling a
                            model. Proves the runner offline (pass@1 = 1.0).
  --models <a,b,c>          Candidate model ids (required live; dry-run defaults to golden).
  --attempts <n>            Repetitions per (model, task) (default: ${DEFAULT_ATTEMPTS}).
  --tasks <id,id>           Restrict to these fixture task ids.
  --host <ollama-url>       Ollama host (required live).
  --core <agentx-url>       Core contract/claim API (required live).
  --claim-id <id>           Required live: exact active benchmark claim id.
  --num-ctx <n>             Context window for the model call (default: ${DEFAULT_NUM_CTX}).
  --num-predict <n>         Max output tokens; UNIFORM per campaign, floor ${MIN_NUM_PREDICT}
                            so reasoning models finish and emit the patch (default: ${DEFAULT_NUM_PREDICT}).
  --temperature <t>         Sampling temperature; keep > 0 so attempts differ and
                            pass@k is meaningful (default: ${DEFAULT_TEMPERATURE}).
  --top-p <n>               Frozen top-p (default: ${DEFAULT_TOP_P}).
  --top-k <n>               Frozen top-k (default: ${DEFAULT_TOP_K}).
  --repeat-penalty <n>      Frozen repeat penalty (default: ${DEFAULT_REPEAT_PENALTY}).
  --seeds <a,b,c,d,e>       One deterministic seed per attempt.
  --response-mode <mode>    final_only (default), native, explicit_thinking.
  --think <true|false>      Backward-compatible alias: false = final_only,
                            true = explicit_thinking. Prefer --response-mode.
  --model-timeout-ms <ms>   Per model call timeout (default: ${DEFAULT_MODEL_TIMEOUT_MS}).
  --grade-timeout-ms <ms>   Per test-command timeout (default: ${DEFAULT_GRADE_TIMEOUT_MS}).
  --ks <1,3,5>              pass@k values to report (default: ${DEFAULT_KS.join(',')}).
  --out <dir>               Report directory (default under .agentx/reports/).

Live runs are disruptive: wrap with scripts/with-agentx-claim.js and get the
operator's go before spending GPU.
`);
}

function safeRunId() {
  return new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
}

/** Build the real Ollama model caller from the already-frozen campaign. */
function buildOllamaCallModel({ host, modelConfigs, timeoutMs }) {
  const url = `${host.replace(/\/+$/, '')}/api/chat`;
  return async function callModel({ model, prompt, seed }) {
    const config = modelConfigs.get(model);
    if (!config) throw new Error(`missing frozen execution config for ${model}`);
    const payload = {
      model,
      messages: [{ role: 'user', content: prompt }],
      stream: false,
      options: {
        num_ctx: config.num_ctx,
        num_predict: config.response_max_tokens,
        temperature: config.temperature,
        top_p: config.top_p,
        top_k: config.top_k,
        repeat_penalty: config.repeat_penalty,
        seed
      }
    };
    if (config.send_think && typeof config.think === 'boolean') payload.think = config.think;
    const startedAt = Date.now();
    const options = getFetchOptions(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      timeout: timeoutMs
    });
    const response = await benchmarkFetch(url, options);
    if (!response.ok) {
      throw new Error(`HTTP ${response.status} ${response.statusText} from ${url}`);
    }
    const data = await response.json();
    // Return the structured reply. `content` is the FINAL answer (the only
    // executable channel); `thinking` is the separate reasoning channel and is
    // NEVER used as a diff substitute; `doneReason` lets the contract detect a
    // truncated (output-capped) generation. The response contract in the runner
    // decides pass/fail — the caller does not salvage a patch from `thinking`.
    const message = data.message || {};
    return {
      content: message.content || '',
      thinking: message.thinking || '',
      doneReason: data.done_reason || null,
      metrics: {
        latencyMs: Date.now() - startedAt,
        promptTokens: Number(data.prompt_eval_count) || 0,
        outputTokens: Number(data.eval_count) || 0,
        tokensPerSecond: Number(data.eval_duration) > 0
          ? (Number(data.eval_count) || 0) / (Number(data.eval_duration) / 1e9)
          : null
      }
    };
  };
}

async function requestJson(url, fetchImpl = benchmarkFetch) {
  const signal = AbortSignal.timeout(CORE_CLAIM_TIMEOUT_MS);
  const response = await fetchImpl(url, getFetchOptions(url, {
    redirect: 'manual',
    signal
  }));
  const payload = await readBoundedJson(response, {
    maxBytes: MAX_CORE_CLAIM_RESPONSE_BYTES,
    signal
  });
  if (!response.ok) throw new Error(payload?.message || payload?.error || `HTTP ${response.status} from ${url}`);
  return payload;
}

async function assertExpectedActiveClaim({ core, host, claimId }, deps = {}) {
  const loadClaims = deps.requestJson || requestJson;
  const payload = await loadClaims(
    `${core.replace(/\/+$/, '')}/api/nerve-center/host-preferences/benchmark-claims/active`
  );
  const normalizedHost = host.replace(/\/+$/, '').toLowerCase();
  const claims = payload?.data?.claims || [];
  const match = claims.find((claim) => String(claim.hostUrl || '').replace(/\/+$/, '').toLowerCase() === normalizedHost);
  if (!match || match.batchId !== claimId) {
    throw new Error(`live qualification requires active claim ${claimId} on ${host}`);
  }
  return match;
}

function stableSerialize(value) {
  if (Array.isArray(value)) return `[${value.map(stableSerialize).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableSerialize(value[key])}`).join(',')}}`;
  }
  return value === undefined ? 'null' : JSON.stringify(value);
}

function fingerprint(value) {
  return crypto.createHash('sha256').update(stableSerialize(value)).digest('hex');
}

function assertExactFrozenSettings(config, args, model) {
  const thinking = args.responseMode === 'final_only'
    ? { think: false, send_think: true }
    : args.responseMode === 'explicit_thinking'
      ? { think: true, send_think: true }
      : { think: null, send_think: false };
  const expected = {
    num_ctx: args.numCtx,
    response_max_tokens: args.numPredict,
    temperature: args.temperature,
    top_p: args.topP,
    top_k: args.topK,
    repeat_penalty: args.repeatPenalty,
    think_mode: args.responseMode,
    ...thinking
  };
  const mismatches = Object.entries(expected)
    .filter(([key, value]) => config[key] !== value)
    .map(([key, value]) => `${key}: expected ${value}, got ${config[key]}`);
  if (mismatches.length) {
    throw new Error(`Core contract did not freeze exact campaign settings for ${model}: ${mismatches.join('; ')}`);
  }
  return config;
}

function selectTasks(allTasks, filter) {
  if (!filter) return allTasks;
  const want = new Set(filter);
  const picked = allTasks.filter((t) => want.has(t.id));
  const missing = filter.filter((id) => !picked.some((t) => t.id === id));
  if (missing.length) throw new Error(`unknown task id(s): ${missing.join(', ')}`);
  return picked;
}

/** The explicit, labeled decode mode for this campaign (never mixed). */
function resolveMode(args) {
  if (args.dryRun) return 'dry-run';
  return args.responseMode;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) { usage(); return; }

  const allTasks = loadRepoTasks();
  const tasks = selectTasks(allTasks, args.tasks);
  const models = args.models || ['golden'];
  const modeLabel = resolveMode(args);
  const attemptSeeds = args.seeds.slice(0, args.attempts);
  const executionConfig = args.dryRun ? null : {
    force_num_ctx: args.numCtx,
    response_max_tokens: args.numPredict,
    response_max_tokens_source: 'caller',
    response_mode: args.responseMode,
    temperature: args.temperature,
    top_p: args.topP,
    top_k: args.topK,
    repeat_penalty: args.repeatPenalty,
    api_mode: 'chat',
    repeats: args.attempts,
    thinking_final_answer_policy: 'visible_required'
  };

  const runId = safeRunId();
  const outDir = path.resolve(args.out || path.join(DEFAULT_OUTPUT_ROOT, `${modeLabel}-${runId}`));
  fs.mkdirSync(outDir, { recursive: true });

  let campaign = null;
  let runnerFingerprint = null;
  const modelConfigs = new Map();
  if (!args.dryRun) {
    await assertExpectedActiveClaim({ core: args.core, host: args.host, claimId: args.claimId });
    campaign = await resolveStandaloneCampaignInferenceContracts({
      hostGroups: [[args.host, models]],
      executionConfig
    }, { coreUrl: args.core });
    if (!campaign.rankable || campaign.responseMode !== args.responseMode) {
      throw new Error(`frozen campaign is not rankable in requested mode ${args.responseMode}`);
    }
    for (const model of models) {
      const frozen = getFrozenModelExecutionConfig(campaign, model, args.host, executionConfig);
      modelConfigs.set(model, assertExactFrozenSettings(frozen, args, model));
    }
    const taskManifest = tasks.map((task) => ({
      id: task.id,
      title: task.title,
      category: task.category,
      language: task.language,
      allowedPaths: task.fixture.allowedPaths,
      fixtureFingerprint: task.fixtureFingerprint,
      promptFingerprint: sha256(buildRepairPrompt(task))
    }));
    runnerFingerprint = fingerprint({
      contractRequestFingerprint: campaign.requestFingerprint,
      claimId: args.claimId,
      models,
      tasks: taskManifest,
      attempts: args.attempts,
      attemptSeeds,
      ks: args.ks,
      fixedSettings: executionConfig
    });
    fs.writeFileSync(path.join(outDir, 'contract-snapshot.json'), `${JSON.stringify({
      schemaVersion: 1,
      runnerFingerprint,
      claimId: args.claimId,
      attemptSeeds,
      tasks: taskManifest,
      campaign
    }, null, 2)}\n`);
  }

  const params = args.dryRun ? null : {
    numCtx: args.numCtx,
    numPredict: args.numPredict,
    temperature: args.temperature,
    topP: args.topP,
    topK: args.topK,
    repeatPenalty: args.repeatPenalty,
    responseMode: args.responseMode,
    attemptSeeds,
    runnerFingerprint,
    contractRequestFingerprint: campaign.requestFingerprint
  };

  const banner = args.dryRun ? 'DRY-RUN (golden diffs, no model calls)' : `LIVE via ${args.host}`;
  process.stdout.write(
    `repo-coding-qualification ${runId}\n` +
    `  campaign: ${banner}\n` +
    `  mode:     ${modeLabel}${params ? `  (num_predict=${params.numPredict} num_ctx=${params.numCtx} temp=${params.temperature})` : ''}\n` +
    `  models:   ${models.join(', ')}\n` +
    `  tasks:    ${tasks.map((t) => t.id).join(', ')}\n` +
    `  attempts: ${args.attempts} seeds=${attemptSeeds.join(',')} (runs: ${models.length * tasks.length * args.attempts})\n` +
    `${runnerFingerprint ? `  frozen:   ${runnerFingerprint}\n` : ''}\n`
  );

  const callModel = args.dryRun
    ? null
    : buildOllamaCallModel({ host: args.host, modelConfigs, timeoutMs: args.modelTimeoutMs });

  const jsonlStream = fs.createWriteStream(path.join(outDir, 'runs.jsonl'), { flags: 'w' });
  // Raw model replies (final + thinking channels) persisted separately so a
  // failed run is debuggable offline without re-spending GPU.
  const responsesStream = fs.createWriteStream(path.join(outDir, 'responses.jsonl'), { flags: 'w' });
  let result;
  try {
    result = await runQualification({
      tasks,
      models,
      attempts: args.attempts,
      callModel,
      dryRun: args.dryRun,
      mode: modeLabel,
      params,
      ks: args.ks,
      timeoutMs: args.gradeTimeoutMs,
      attemptSeeds,
      beforeModel: args.dryRun ? null : async ({ model }) => {
        await assertExpectedActiveClaim({ core: args.core, host: args.host, claimId: args.claimId });
        await assertFrozenArtifactDigest(campaign, model, args.host);
      },
      modelProvenance: args.dryRun ? null : (model) => {
        const config = modelConfigs.get(model);
        return {
          runnerFingerprint,
          contractRequestFingerprint: campaign.requestFingerprint,
          contractFingerprint: config.inference_contract_fingerprint,
          artifactDigest: config.artifact_digest,
          host: args.host,
          responseMode: config.think_mode,
          numCtx: config.num_ctx,
          numPredict: config.response_max_tokens
        };
      },
      onRecord: (record, meta) => {
        jsonlStream.write(`${toJsonlLine(record)}\n`);
        if (meta.response) {
          responsesStream.write(`${JSON.stringify({
            model: record.model, task: record.task, attempt: record.attempt,
            seed: record.seed,
            doneReason: meta.response.doneReason,
            metrics: meta.response.metrics,
            content: meta.response.content, thinking: meta.response.thinking
          })}\n`);
        }
        const flag = record.grade.pass ? 'PASS' : 'fail';
        process.stdout.write(`  [${flag}] ${record.model} · ${record.task} · a${record.attempt} — ${record.grade.reason}\n`);
      }
    });
  } finally {
    await Promise.all([
      new Promise((resolve) => jsonlStream.end(resolve)),
      new Promise((resolve) => responsesStream.end(resolve))
    ]);
  }

  const summary = {
    runId,
    generatedAt: new Date().toISOString(),
    campaign: args.dryRun ? 'dry-run' : 'live',
    host: args.dryRun ? null : args.host,
    claimId: args.dryRun ? null : args.claimId,
    runnerFingerprint,
    inferenceContractCampaign: campaign,
    ...result.meta,
    perModel: result.perModel,
    outcomes: result.outcomes,
    perTask: result.perTask
  };
  fs.writeFileSync(path.join(outDir, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`);

  process.stdout.write(`\nMode "${modeLabel}" — pass@k by model:\n`);
  for (const row of result.perModel) {
    const ks = row.rankable
      ? Object.entries(row.passAtK).map(([k, v]) => `${k}=${v.toFixed(3)}`).join(' ')
      : `UNRANKABLE (${row.unrankableSamples} response-contract outcome(s))`;
    const outc = Object.entries(result.outcomes[row.model] || {})
      .filter(([k]) => k !== 'pass').map(([k, v]) => `${k}=${v}`).join(' ');
    process.stdout.write(`  ${row.model}: ${row.correct}/${row.samples} passed · ${ks}${outc ? `  [${outc}]` : ''}\n`);
  }
  process.stdout.write(`\nReport: ${outDir}\n`);

  // In dry-run, every golden diff must pass — fail loudly if the harness itself
  // is broken, so this stays a trustworthy pre-GPU gate.
  if (args.dryRun) {
    const allPass = result.records.every((r) => r.grade.pass);
    if (!allPass) {
      process.stderr.write('DRY-RUN FAILED: not every golden diff passed — harness is broken.\n');
      process.exitCode = 1;
    }
  }
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`${error.stack || error.message}\n`);
    process.exitCode = 1;
  });
}

module.exports = {
  CORE_CLAIM_TIMEOUT_MS,
  MAX_CORE_CLAIM_RESPONSE_BYTES,
  parseArgs,
  buildOllamaCallModel,
  requestJson,
  assertExpectedActiveClaim,
  assertExactFrozenSettings,
  fingerprint,
  selectTasks,
  resolveMode,
  main
};
