'use strict';

/**
 * Explicit context-size performance sweep.
 *
 * Uses the existing HostPerformanceSnapshot path so results are queryable from
 * the profiler host-test history. This runner is intentionally performance-only:
 * it measures throughput/latency/VRAM at fixed num_ctx buckets with scaled
 * prompt fill, without running the full quality benchmark corpus.
 */

const mongoose = require('mongoose');

const { testModelOnHost } = require('../src/services/hostTestService');
const {
  claimHostForBenchmark,
  releaseBenchmarkClaim,
  restoreDedication
} = require('../src/clients/coreApiClient');

// These are deliberate measurement buckets, not runtime context lanes.
const DEFAULT_CONTEXTS = [4096, 8192, 16384, 32768];
const WARMUP_BUFFER_MS = 5 * 60 * 1000;

function parseArgs(argv) {
  const args = {};
  for (const raw of argv) {
    if (raw === '--help' || raw === '-h') {
      args.help = true;
      continue;
    }
    const match = String(raw).match(/^--([^=]+)=(.*)$/);
    if (match) args[match[1]] = match[2];
  }
  return args;
}

function csv(value, fallback) {
  if (!value) return fallback;
  return String(value)
    .split(',')
    .map(item => item.trim())
    .filter(Boolean);
}

function intCsv(value, fallback) {
  const parsed = csv(value, [])
    .map(item => Number.parseInt(item, 10))
    .filter(n => Number.isFinite(n) && n > 0);
  return parsed.length ? parsed : fallback;
}

function asInt(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function now() {
  return new Date().toISOString();
}

function log(message, data = null) {
  const line = data ? `${now()} ${message} ${JSON.stringify(data)}` : `${now()} ${message}`;
  console.log(line);
}

function summarizeRows(rows) {
  return rows.map(row => ({
    model: row.model,
    context: row.context,
    repeat: row.repeat,
    status: row.status,
    tokensPerSec: row.tokensPerSec,
    promptEvalTokensPerSec: row.promptEvalTokensPerSec,
    latencyMs: row.latencyMs,
    timeToFirstTokenMs: row.timeToFirstTokenMs,
    promptTokens: row.promptTokens,
    requestedPromptTokens: row.requestedPromptTokens,
    completionTokens: row.completionTokens,
    vramUsedMiB: row.vramUsedMiB,
    vramTotalMiB: row.vramTotalMiB,
    error: row.error || null
  }));
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log([
      'node benchmark/scripts/context-performance-sweep.js \\',
      '  --host=<ollama-url> --hostId=<id> --models=<model-a,model-b> [options]',
      '',
      `Default measurement contexts: ${DEFAULT_CONTEXTS.join(',')}`,
      'Inputs may also be supplied through CONTEXT_SWEEP_HOST,',
      'CONTEXT_SWEEP_HOST_ID, and CONTEXT_SWEEP_MODELS.'
    ].join('\n'));
    return;
  }

  const hostUrl = args.host || process.env.CONTEXT_SWEEP_HOST;
  const hostId = args.hostId || process.env.CONTEXT_SWEEP_HOST_ID;
  const models = csv(args.models || process.env.CONTEXT_SWEEP_MODELS, []);
  if (!hostUrl) throw new Error('--host or CONTEXT_SWEEP_HOST is required');
  if (!hostId) throw new Error('--hostId or CONTEXT_SWEEP_HOST_ID is required');
  if (!models.length) throw new Error('--models or CONTEXT_SWEEP_MODELS is required');
  const contexts = intCsv(args.contexts || process.env.CONTEXT_SWEEP_CONTEXTS, DEFAULT_CONTEXTS);
  const contextFillPct = asInt(args.fill || process.env.CONTEXT_SWEEP_FILL_PCT, 25);
  const numPredict = asInt(args.predict || process.env.CONTEXT_SWEEP_NUM_PREDICT, 128);
  const repeats = asInt(args.repeats || process.env.CONTEXT_SWEEP_REPEATS, 1);
  const timeoutMs = asInt(args.timeout || process.env.CONTEXT_SWEEP_TIMEOUT_MS, 900000);
  const runId = args.runId || process.env.CONTEXT_SWEEP_RUN_ID || `context-sweep-${new Date().toISOString().replace(/[:.]/g, '-')}`;
  const perCellEstimateMs = Math.max(4 * 60 * 1000, timeoutMs + WARMUP_BUFFER_MS);
  const estimatedDurationMs = models.length * contexts.length * repeats * perCellEstimateMs;

  const summary = {
    runId,
    hostUrl,
    hostId,
    models,
    contexts,
    contextFillPct,
    numPredict,
    repeats,
    timeoutMs,
    startedAt: now(),
    completedAt: null,
    rows: []
  };

  await mongoose.connect(process.env.MONGODB_URI || process.env.MONGO_URI || 'mongodb://mongo:27017/agentx');

  let claimed = false;
  try {
    const claim = await claimHostForBenchmark(hostUrl, runId, estimatedDurationMs);
    claimed = claim?.claimed !== false;
    if (!claimed && process.env.CONTEXT_SWEEP_ALLOW_CLAIM_CONFLICT !== 'true') {
      throw new Error(`Host claim refused: ${claim?.reason || 'unknown reason'}`);
    }

    log('Context sweep started', {
      runId,
      hostUrl,
      hostId,
      models,
      contexts,
      contextFillPct,
      numPredict,
      repeats
    });

    for (const model of models) {
      for (const context of contexts) {
        for (let repeat = 1; repeat <= repeats; repeat++) {
          log('Context sweep cell started', { runId, model, context, repeat });
          const result = await testModelOnHost(model, hostUrl, {
            hostId,
            numCtx: context,
            contextFillPct,
            numPredict,
            promptWorkloadMode: 'scaled',
            timeoutMs
          });

          const row = {
            model,
            context,
            repeat,
            ...result
          };
          summary.rows.push(row);
          log('Context sweep cell completed', {
            runId,
            model,
            context,
            repeat,
            status: result.status,
            tokensPerSec: result.tokensPerSec,
            promptEvalTokensPerSec: result.promptEvalTokensPerSec,
            latencyMs: result.latencyMs,
            promptTokens: result.promptTokens,
            vramUsedMiB: result.vramUsedMiB,
            error: result.error || null
          });
        }
      }
    }
  } finally {
    summary.completedAt = now();
    if (claimed) {
      try {
        await releaseBenchmarkClaim(hostUrl, runId);
        log('Context sweep claim released', { runId, hostUrl });
      } catch (err) {
        log('Context sweep claim release failed', { runId, hostUrl, error: err.message });
      }
    }

    try {
      await restoreDedication(hostUrl);
      log('Context sweep dedication restored', { runId, hostUrl });
    } catch (err) {
      log('Context sweep dedication restore failed', { runId, hostUrl, error: err.message });
    }

    await mongoose.disconnect();
  }

  const report = {
    ...summary,
    rows: summarizeRows(summary.rows)
  };
  console.log(`CONTEXT_SWEEP_SUMMARY ${JSON.stringify(report)}`);
}

if (require.main === module) {
  main().catch(err => {
    console.error(`${now()} Context sweep failed: ${err.stack || err.message}`);
    process.exitCode = 1;
  });
}

module.exports = { DEFAULT_CONTEXTS, parseArgs, csv, intCsv, asInt, summarizeRows };
