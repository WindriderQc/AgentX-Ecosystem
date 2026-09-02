#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { readBoundedJson } = require('../../scripts/bounded-response');
const {
  MODES,
  summarizeMode,
  compareModeSummaries,
  fingerprint,
  buildBatchPayload
} = require('../src/services/qualification/pairedThinkingCampaign');

const TERMINAL = new Set(['completed', 'failed', 'stopped', 'interrupted']);
const REQUEST_DEADLINE_MS = 30_000;
const MAX_RESPONSE_BYTES = 16 * 1024 * 1024;

function parseList(value) {
  return String(value || '').split(',').map((item) => item.trim()).filter(Boolean);
}

function parseArgs(argv) {
  const args = {
    execute: false,
    api: 'http://127.0.0.1:3081',
    repeats: 3,
    numCtx: 8192,
    numPredict: 4096,
    temperature: 0.2,
    topP: 0.9,
    topK: 40,
    repeatPenalty: 1.1,
    seed: 42,
    judgeConcurrency: 1,
    pollMs: 5000,
    timeoutMs: 2 * 60 * 60 * 1000,
    order: [...MODES],
    operatorTokenEnv: 'AGENTX_OPERATOR_TOKEN',
    runName: 'Paired final-only vs thinking'
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => argv[++i];
    if (arg === '--execute') args.execute = true;
    else if (arg === '--api') args.api = next();
    else if (arg === '--host') args.host = next();
    else if (arg === '--model') args.model = next();
    else if (arg === '--judge-host') args.judgeHost = next();
    else if (arg === '--judge-model') args.judgeModel = next();
    else if (arg === '--prompt-ids') args.promptIds = parseList(next());
    else if (arg === '--repeats') args.repeats = Number(next());
    else if (arg === '--num-ctx') args.numCtx = Number(next());
    else if (arg === '--num-predict') args.numPredict = Number(next());
    else if (arg === '--temperature') args.temperature = Number(next());
    else if (arg === '--top-p') args.topP = Number(next());
    else if (arg === '--top-k') args.topK = Number(next());
    else if (arg === '--repeat-penalty') args.repeatPenalty = Number(next());
    else if (arg === '--seed') args.seed = Number(next());
    else if (arg === '--judge-concurrency') args.judgeConcurrency = Number(next());
    else if (arg === '--poll-ms') args.pollMs = Number(next());
    else if (arg === '--timeout-ms') args.timeoutMs = Number(next());
    else if (arg === '--order') {
      const order = String(next()).trim().toLowerCase();
      if (order === 'final-first') args.order = ['final_only', 'explicit_thinking'];
      else if (order === 'thinking-first') args.order = ['explicit_thinking', 'final_only'];
      else throw new Error('--order must be final-first or thinking-first');
    }
    else if (arg === '--operator-token-env') args.operatorTokenEnv = next();
    else if (arg === '--run-name') args.runName = next();
    else if (arg === '--out') args.out = next();
    else if (arg === '--help' || arg === '-h') args.help = true;
    else throw new Error(`unknown argument: ${arg}`);
  }

  if (args.help) return args;
  for (const field of ['host', 'model', 'judgeHost', 'judgeModel']) {
    if (!args[field]) throw new Error(`--${field.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)} is required`);
  }
  if (!Array.isArray(args.promptIds) || args.promptIds.length === 0 || args.promptIds.length > 100) {
    throw new Error('--prompt-ids must contain 1 to 100 comma-separated prompt ids');
  }
  if (args.promptIds.some((id) => !/^[a-f0-9]{24}$/i.test(id))) {
    throw new Error('--prompt-ids must contain Mongo ObjectId values');
  }
  if (!Number.isInteger(args.repeats) || args.repeats < 3 || args.repeats > 5) {
    throw new Error('--repeats must be an integer from 3 to 5');
  }
  if (!Number.isInteger(args.numCtx) || args.numCtx < 512) throw new Error('--num-ctx must be an integer >= 512');
  if (!Number.isInteger(args.numPredict) || args.numPredict < 100) throw new Error('--num-predict must be an integer >= 100');
  if (!Number.isFinite(args.temperature) || args.temperature < 0 || args.temperature > 2) throw new Error('--temperature must be in [0, 2]');
  if (!Number.isFinite(args.topP) || args.topP <= 0 || args.topP > 1) throw new Error('--top-p must be in (0, 1]');
  if (!Number.isInteger(args.topK) || args.topK < 1) throw new Error('--top-k must be a positive integer');
  if (!Number.isFinite(args.repeatPenalty) || args.repeatPenalty <= 0) throw new Error('--repeat-penalty must be positive');
  if (!Number.isInteger(args.seed)) throw new Error('--seed must be an integer');
  if (!Number.isInteger(args.judgeConcurrency) || args.judgeConcurrency < 1) throw new Error('--judge-concurrency must be a positive integer');
  if (!Number.isInteger(args.pollMs) || args.pollMs < 1000) throw new Error('--poll-ms must be an integer >= 1000');
  if (!Number.isInteger(args.timeoutMs) || args.timeoutMs < 60_000) throw new Error('--timeout-ms must be an integer >= 60000');
  return args;
}

function usage() {
  process.stdout.write(`Paired final-only vs explicit-thinking benchmark\n\n` +
`Dry plan by default; add --execute to launch both sequential batches.\n\n` +
`Required:\n` +
`  --host <ollama-url> --model <exact-tag>\n` +
`  --judge-host <ollama-url> --judge-model <exact-tag>\n` +
`  --prompt-ids <id,id,...>\n\n` +
`Safety/evidence:\n` +
`  --repeats <3..5>          default 3\n` +
`  --order <final-first|thinking-first>\n` +
`  --operator-token-env <name>  default AGENTX_OPERATOR_TOKEN\n` +
`  --out <file>\n\n` +
`The report separates raw scores from review-clean scores, withholds prompts\n` +
`that lack the required clean repeats, and never authorizes routing.\n`);
}

function normalizeApi(api) {
  return String(api).replace(/\/+$/, '');
}

function headersFor(args, withBody = false) {
  const headers = {};
  if (withBody) headers['Content-Type'] = 'application/json';
  const token = args.operatorTokenEnv ? process.env[args.operatorTokenEnv] : null;
  if (token) headers['X-AgentX-Operator-Token'] = token;
  return headers;
}

async function requestJson(url, options = {}, fetchImpl = fetch) {
  const signal = AbortSignal.timeout(REQUEST_DEADLINE_MS);
  const response = await fetchImpl(url, { ...options, redirect: 'manual', signal });
  let payload = null;
  try {
    payload = await readBoundedJson(response, { maxBytes: MAX_RESPONSE_BYTES, signal });
  } catch (error) {
    if (response.ok) throw error;
  }
  if (!response.ok) {
    const error = new Error(payload?.error || payload?.message || `HTTP ${response.status} from ${url}`);
    error.statusCode = response.status;
    error.payload = payload;
    throw error;
  }
  return payload;
}

async function delay(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function assertNoActiveBatch(args, deps = {}) {
  const load = deps.requestJson || requestJson;
  const payload = await load(`${normalizeApi(args.api)}/api/benchmark/batches/active`, {
    headers: headersFor(args)
  });
  const active = payload?.data?.batches || payload?.data || [];
  if (Array.isArray(active) && active.length > 0) {
    throw new Error(`benchmark singleton is occupied by batch ${active[0]._id || active[0].id || 'unknown'}`);
  }
}

async function launchBatch(args, payload, deps = {}) {
  const load = deps.requestJson || requestJson;
  const response = await load(`${normalizeApi(args.api)}/api/benchmark/batch`, {
    method: 'POST',
    headers: headersFor(args, true),
    body: JSON.stringify(payload)
  });
  const batchId = response?.data?.batch_id;
  if (!batchId) throw new Error('benchmark launch response did not include batch_id');
  return batchId;
}

async function waitForBatch(args, batchId, deps = {}) {
  const load = deps.requestJson || requestJson;
  const sleep = deps.delay || delay;
  const started = Date.now();
  while (Date.now() - started <= args.timeoutMs) {
    const response = await load(`${normalizeApi(args.api)}/api/benchmark/batch/${batchId}`, {
      headers: headersFor(args)
    });
    const batch = response?.data;
    if (batch && TERMINAL.has(batch.status)) return batch;
    await sleep(args.pollMs);
  }
  throw new Error(`timed out waiting for batch ${batchId}`);
}

async function fetchBatchRows(args, batchId, deps = {}) {
  const load = deps.requestJson || requestJson;
  const url = new URL(`${normalizeApi(args.api)}/api/benchmark/results/advanced`);
  url.searchParams.set('batchId', batchId);
  url.searchParams.set('limit', '5000');
  url.searchParams.set('sort', 'timestamp');
  url.searchParams.set('sortDir', 'asc');
  const response = await load(url.toString(), { headers: headersFor(args) });
  const data = response?.data || {};
  if (Number(data.total) > Number(data.returned)) {
    throw new Error(`batch ${batchId} returned only ${data.returned}/${data.total} rows`);
  }
  return data.results || [];
}

function safeTimestamp() {
  return new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) { usage(); return; }
  const generatedAt = new Date().toISOString();
  const frozen = {
    host: args.host,
    model: args.model,
    judgeHost: args.judgeHost,
    judgeModel: args.judgeModel,
    promptIds: args.promptIds,
    repeats: args.repeats,
    numCtx: args.numCtx,
    numPredict: args.numPredict,
    temperature: args.temperature,
    topP: args.topP,
    topK: args.topK,
    repeatPenalty: args.repeatPenalty,
    seed: args.seed,
    order: args.order
  };
  const pairId = fingerprint({ schema: 'agentx.paired-thinking-plan/v1', generatedAt, frozen });
  const payloads = Object.fromEntries(args.order.map((mode) => [mode, buildBatchPayload(args, mode, pairId)]));

  if (!args.execute) {
    process.stdout.write(`${JSON.stringify({
      schema: 'agentx.paired-thinking-plan/v1',
      pair_id: pairId,
      generated_at: generatedAt,
      execution: 'not_authorized_dry_plan',
      order: args.order,
      payloads
    }, null, 2)}\n`);
    return;
  }

  const batches = {};
  const summaries = {};
  for (const mode of args.order) {
    await assertNoActiveBatch(args);
    const batchId = await launchBatch(args, payloads[mode]);
    process.stdout.write(`Launched ${mode}: ${batchId}\n`);
    const batch = await waitForBatch(args, batchId);
    if (batch.status !== 'completed') {
      throw new Error(`${mode} batch ${batchId} ended with status ${batch.status}`);
    }
    const rows = await fetchBatchRows(args, batchId);
    const expectedRows = args.promptIds.length * args.repeats;
    if (rows.length !== expectedRows) {
      throw new Error(`${mode} batch ${batchId} produced ${rows.length}/${expectedRows} expected rows`);
    }
    batches[mode] = {
      batch_id: batchId,
      status: batch.status,
      batch_contract_fingerprint: batch.batch_contract_fingerprint || null,
      quality_cohort_fingerprint: batch.quality_cohort_fingerprint || null,
      completed: batch.completed,
      failed: batch.failed,
      needs_review_count: batch.needs_review_count,
      invalid_count: batch.invalid_count
    };
    summaries[mode] = summarizeMode(rows, { mode, expectedRepeats: args.repeats });
  }

  const report = {
    schema: 'agentx.paired-thinking-report/v1',
    pair_id: pairId,
    generated_at: generatedAt,
    completed_at: new Date().toISOString(),
    authority: {
      evidence_status: 'exploratory',
      qualified: false,
      routing_change_authorized: false,
      raw_scores_are_authoritative: false,
      review_clean_scores_are_decision_inputs_only: true
    },
    frozen,
    batches,
    modes: summaries,
    paired_comparison: compareModeSummaries(
      summaries.final_only,
      summaries.explicit_thinking,
      { minimumRepeats: args.repeats }
    )
  };
  report.report_fingerprint = fingerprint(report);
  const out = path.resolve(args.out || path.join('.agentx', 'reports', `paired-thinking-${safeTimestamp()}.json`));
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`);
  process.stdout.write(`Paired report: ${out}\n`);
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`${error.stack || error.message}\n`);
    process.exitCode = 1;
  });
}

module.exports = {
  REQUEST_DEADLINE_MS,
  MAX_RESPONSE_BYTES,
  parseArgs,
  headersFor,
  requestJson,
  assertNoActiveBatch,
  launchBatch,
  waitForBatch,
  fetchBatchRows,
  main
};
