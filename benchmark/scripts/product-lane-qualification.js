'use strict';

/**
 * Product-lane qualification for already-resident AgentX models.
 *
 * This intentionally bypasses task routing while retaining Core's benchmark
 * claim protocol. It measures exact model+host+pin-context candidates without
 * mutating router overrides or loading an unpinned model.
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const fetch = require('node-fetch');
const { buildProductLaneCorpus } = require('../src/services/qualification/productLaneCorpus');

const CORE_URL = process.env.CORE_URL || 'http://192.0.2.99:3080';
const DEFAULT_CANDIDATES = [
  { id: 'gemma4-26b-primary', model: 'ax/gemma4:26b-a4b-it-qat', host: 'http://192.0.2.199:11434', numCtx: 83558 },
  { id: 'qwen35-9b-secondary', model: 'ax/qwen3.5:9b', host: 'http://192.0.2.12:11434', numCtx: 131072 }
];

function parseArgs(argv) {
  const args = {
    repeats: 3,
    candidates: [],
    cases: [],
    samplingProfile: 'production',
    dryRun: false,
    noClaim: false
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = () => argv[++index];
    if (arg === '--repeats') args.repeats = Math.max(1, Math.min(5, Number(next()) || 3));
    else if (arg === '--candidate') {
      const [id, model, host, numCtx] = String(next() || '').split('|');
      if (!id || !model || !host) throw new Error('--candidate expects id|model|host|numCtx');
      args.candidates.push({ id, model, host: host.replace(/\/+$/, ''), numCtx: Number(numCtx) || 8192 });
    } else if (arg === '--case') args.cases.push(...String(next() || '').split(',').filter(Boolean));
    else if (arg === '--sampling-profile') args.samplingProfile = String(next() || '').trim().toLowerCase();
    else if (arg === '--out') args.out = path.resolve(next());
    else if (arg === '--rescore') args.rescore = path.resolve(next());
    else if (arg === '--dry-run') args.dryRun = true;
    else if (arg === '--no-claim') args.noClaim = true;
    else if (arg === '--help') args.help = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  if (!['production', 'controlled'].includes(args.samplingProfile)) {
    throw new Error('--sampling-profile must be production or controlled');
  }
  if (!args.candidates.length) args.candidates = DEFAULT_CANDIDATES;
  return args;
}

function percentile(values, pct) {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!sorted.length) return null;
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * pct) - 1)];
}

function summarize(candidate, rows) {
  const successful = rows.filter((row) => !row.error);
  const passed = successful.filter((row) => row.assessment?.pass);
  const safety = rows.filter((row) => row.safetyCritical);
  const byCase = {};
  for (const row of rows) {
    const bucket = byCase[row.caseId] || { runs: 0, passes: 0, errors: 0 };
    bucket.runs += 1;
    if (row.assessment?.pass) bucket.passes += 1;
    if (row.error) bucket.errors += 1;
    byCase[row.caseId] = bucket;
  }
  return {
    candidate,
    samplingProfile: rows[0]?.samplingProfile || null,
    promotionEligible: rows.length > 0 && rows.every((row) => row.samplingProfile === 'production'),
    runs: rows.length,
    passRate: rows.length ? passed.length / rows.length : 0,
    safetyPassed: safety.length > 0 && safety.every((row) => row.assessment?.pass === true),
    errorRate: rows.length ? (rows.length - successful.length) / rows.length : 0,
    ttftMs: {
      p50: percentile(successful.map((row) => row.metrics.firstTokenMs), 0.5),
      p95: percentile(successful.map((row) => row.metrics.firstTokenMs), 0.95)
    },
    totalMs: {
      p50: percentile(successful.map((row) => row.metrics.totalMs), 0.5),
      p95: percentile(successful.map((row) => row.metrics.totalMs), 0.95)
    },
    tokensPerSecond: {
      p50: percentile(successful.map((row) => row.metrics.tokensPerSecond), 0.5),
      p95: percentile(successful.map((row) => row.metrics.tokensPerSecond), 0.95)
    },
    byCase
  };
}

async function jsonRequest(url, options = {}, timeoutMs = 15000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    const text = await response.text();
    let payload;
    try { payload = text ? JSON.parse(text) : {}; } catch (_err) { payload = { raw: text }; }
    if (!response.ok) throw new Error(payload.message || payload.error || `HTTP ${response.status}`);
    return payload;
  } finally {
    clearTimeout(timer);
  }
}

function claimPath(candidate) {
  return `${CORE_URL}/api/nerve-center/host-preferences/${encodeURIComponent(candidate.host)}/benchmark-claim`;
}

function ownedClaimPath(candidate, batchId, suffix = '') {
  return `${claimPath(candidate)}/${encodeURIComponent(batchId)}${suffix}`;
}

async function claim(candidate, batchId, estimatedDurationMs) {
  const payload = await jsonRequest(claimPath(candidate), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      batchId,
      estimatedDurationMs,
      source: 'product-lane-qualification',
      owner: 'codex',
      note: `Pinned resident qualification: ${candidate.id}`,
      heartbeatTtlMs: 90000
    })
  });
  if (payload.data?.claimed === false) throw new Error(payload.data.reason || 'Host claim rejected');
}

async function heartbeat(candidate, batchId, estimatedDurationMs) {
  await jsonRequest(ownedClaimPath(candidate, batchId, '/heartbeat'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ estimatedDurationMs, source: 'product-lane-qualification', owner: 'codex' })
  });
}

async function release(candidate, batchId) {
  await jsonRequest(ownedClaimPath(candidate, batchId), { method: 'DELETE' }, 600000);
}

async function assertResident(candidate) {
  const [tags, running] = await Promise.all([
    jsonRequest(`${candidate.host}/api/tags`),
    jsonRequest(`${candidate.host}/api/ps`)
  ]);
  const installed = (tags.models || []).some((row) => row.name === candidate.model);
  const resident = (running.models || []).some((row) => row.name === candidate.model);
  if (!installed) throw new Error(`${candidate.model} is not installed on ${candidate.host}`);
  if (!resident) throw new Error(`${candidate.model} is not resident on ${candidate.host}; refusing a disruptive cold load`);
  return (running.models || []).find((row) => row.name === candidate.model);
}

async function restoreResidentContext(candidate, residentBefore) {
  const expected = Number(residentBefore?.context_length || 0);
  if (!expected || expected === candidate.numCtx) return;
  const response = await fetch(`${candidate.host}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: candidate.model,
      messages: [{ role: 'user', content: 'Reply only: OK' }],
      stream: false,
      think: false,
      keep_alive: -1,
      options: { num_ctx: expected, num_predict: 4, temperature: 0 }
    }),
    timeout: 180000
  });
  if (!response.ok) throw new Error(`Could not restore ${candidate.model} context ${expected}: HTTP ${response.status}`);
  await response.json();
  const running = await jsonRequest(`${candidate.host}/api/ps`);
  const restored = (running.models || []).find((row) => row.name === candidate.model);
  if (Number(restored?.context_length || 0) !== expected) {
    throw new Error(`Context restore verification failed for ${candidate.model}: expected ${expected}, got ${restored?.context_length || 0}`);
  }
}

async function streamChat(candidate, testCase, samplingProfile, seed) {
  const startedAt = Date.now();
  const options = {
    num_ctx: candidate.numCtx,
    num_predict: testCase.lane === 'nestor_complete_schema' ? 180 : 120
  };
  if (samplingProfile === 'controlled') {
    Object.assign(options, { temperature: 0.15, top_p: 0.85, seed });
  }
  const response = await fetch(`${candidate.host}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: candidate.model,
      messages: [
        { role: 'system', content: testCase.system },
        { role: 'user', content: testCase.prompt }
      ],
      stream: true,
      think: false,
      keep_alive: -1,
      options
    }),
    timeout: 120000
  });
  if (!response.ok) throw new Error(`Ollama HTTP ${response.status}: ${(await response.text()).slice(0, 300)}`);

  let buffer = '';
  let reply = '';
  let firstTokenMs = null;
  let final = {};
  for await (const chunk of response.body) {
    buffer += chunk.toString('utf8');
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';
    for (const line of lines) {
      if (!line.trim()) continue;
      const event = JSON.parse(line);
      const content = event.message?.content || '';
      if (content && firstTokenMs == null) firstTokenMs = Date.now() - startedAt;
      reply += content;
      if (event.done) final = event;
    }
  }
  if (buffer.trim()) {
    const event = JSON.parse(buffer);
    const content = event.message?.content || '';
    if (content && firstTokenMs == null) firstTokenMs = Date.now() - startedAt;
    reply += content;
    if (event.done) final = event;
  }

  const totalMs = Date.now() - startedAt;
  const evalSeconds = Number(final.eval_duration || 0) / 1e9;
  return {
    reply: reply.trim(),
    metrics: {
      firstTokenMs,
      totalMs,
      loadMs: Number(final.load_duration || 0) / 1e6,
      promptEvalMs: Number(final.prompt_eval_duration || 0) / 1e6,
      evalMs: Number(final.eval_duration || 0) / 1e6,
      promptTokens: Number(final.prompt_eval_count || 0),
      outputTokens: Number(final.eval_count || 0),
      tokensPerSecond: evalSeconds > 0 ? Number(final.eval_count || 0) / evalSeconds : null,
      doneReason: final.done_reason || ''
    }
  };
}

function atomicWrite(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(value, null, 2));
  fs.renameSync(temporary, file);
}

async function runCandidate(candidate, corpus, repeats, samplingProfile, output, outFile, noClaim) {
  const batchId = `product-lanes-${Date.now()}-${candidate.id}`.replace(/[^a-zA-Z0-9_.-]/g, '-');
  const estimatedDurationMs = corpus.length * repeats * 15000;
  const residentBefore = await assertResident(candidate);
  if (!noClaim) await claim(candidate, batchId, estimatedDurationMs);
  const heartbeatTimer = noClaim ? null : setInterval(() => {
    heartbeat(candidate, batchId, estimatedDurationMs).catch((error) => {
      process.stderr.write(`Heartbeat failed for ${candidate.id}: ${error.message}\n`);
    });
  }, 30000);

  try {
    for (const testCase of corpus) {
      for (let repeat = 0; repeat < repeats; repeat += 1) {
        const row = {
          candidateId: candidate.id,
          model: candidate.model,
          host: candidate.host,
          numCtx: candidate.numCtx,
          caseId: testCase.id,
          lane: testCase.lane,
          safetyCritical: testCase.safetyCritical,
          repeat: repeat + 1,
          samplingProfile,
          samplingSource: samplingProfile === 'production' ? 'modelfile_default' : 'controlled_override',
          seed: samplingProfile === 'controlled' ? 42 + repeat : null,
          prompt: testCase.prompt,
          startedAt: new Date().toISOString()
        };
        try {
          const result = await streamChat(candidate, testCase, samplingProfile, row.seed);
          Object.assign(row, result, { assessment: testCase.score(result.reply) });
        } catch (error) {
          row.error = error.message;
        }
        row.completedAt = new Date().toISOString();
        output.results.push(row);
        output.summaries[candidate.id] = summarize(candidate, output.results.filter((item) => item.candidateId === candidate.id));
        atomicWrite(outFile, output);
        process.stdout.write(`${candidate.id} ${testCase.id} #${repeat + 1}: ${row.assessment?.pass ? 'PASS' : 'FAIL'} ${row.metrics?.totalMs || '-'}ms\n`);
      }
    }
  } finally {
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    let restoreError = null;
    try {
      await restoreResidentContext(candidate, residentBefore);
    } catch (error) {
      restoreError = error;
    } finally {
      if (!noClaim) await release(candidate, batchId);
    }
    if (restoreError) throw restoreError;
  }
}

function usage() {
  return [
    'node benchmark/scripts/product-lane-qualification.js [options]',
    '  --repeats N                         Runs per case (1-5, default 3)',
    '  --candidate id|model|host|numCtx     Repeatable; defaults to current 26B and warm 9B pins',
    '  --case id,id                         Run only selected corpus cases',
    '  --sampling-profile production|controlled',
    '                                      Default production; only production evidence is promotion-eligible',
    '  --out FILE                           Raw JSON output path',
    '  --rescore FILE                       Reapply current deterministic scorers without inference',
    '  --dry-run                            Print resolved campaign without inference',
    '  --no-claim                           Diagnostics only; do not coordinate host ownership'
  ].join('\n');
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) return process.stdout.write(`${usage()}\n`);
  let corpus = buildProductLaneCorpus();
  if (args.cases.length) corpus = corpus.filter((entry) => args.cases.includes(entry.id));
  if (!corpus.length) throw new Error('No corpus cases selected');
  if (args.rescore) {
    const output = JSON.parse(fs.readFileSync(args.rescore, 'utf8'));
    const byId = Object.fromEntries(corpus.map((entry) => [entry.id, entry]));
    for (const row of output.results || []) {
      if (!row.error && byId[row.caseId]) row.assessment = byId[row.caseId].score(row.reply);
    }
    output.summaries = {};
    for (const candidate of output.candidates || []) {
      output.summaries[candidate.id] = summarize(candidate, output.results.filter((row) => row.candidateId === candidate.id));
    }
    output.rescoredAt = new Date().toISOString();
    atomicWrite(args.rescore, output);
    process.stdout.write(`${JSON.stringify(output.summaries, null, 2)}\n`);
    return;
  }
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const outFile = args.out || path.resolve(__dirname, '..', 'reports', `product-lanes-${stamp}.json`);
  const output = {
    schemaVersion: 2,
    campaign: 'agentx-product-lanes-v1',
    startedAt: new Date().toISOString(),
    gitSha: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: path.resolve(__dirname, '../..'), encoding: 'utf8' }).trim(),
    coreUrl: CORE_URL,
    repeats: args.repeats,
    samplingProfile: args.samplingProfile,
    samplingSource: args.samplingProfile === 'production' ? 'modelfile_default' : 'controlled_override',
    promotionEligible: args.samplingProfile === 'production',
    candidates: args.candidates,
    cases: corpus.map(({ id, lane, safetyCritical, prompt, system }) => ({
      id, lane, safetyCritical, prompt,
      systemSha256: require('crypto').createHash('sha256').update(system).digest('hex')
    })),
    results: [],
    summaries: {}
  };
  if (args.dryRun) {
    process.stdout.write(`${JSON.stringify({ outFile, ...output }, null, 2)}\n`);
    return;
  }
  atomicWrite(outFile, output);
  for (const candidate of args.candidates) {
    await runCandidate(candidate, corpus, args.repeats, args.samplingProfile, output, outFile, args.noClaim);
  }
  output.completedAt = new Date().toISOString();
  atomicWrite(outFile, output);
  process.stdout.write(`Results: ${outFile}\n${JSON.stringify(output.summaries, null, 2)}\n`);
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`${error.stack || error.message}\n`);
    process.exitCode = 1;
  });
}

module.exports = { DEFAULT_CANDIDATES, parseArgs, percentile, summarize };
