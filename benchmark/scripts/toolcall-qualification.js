#!/usr/bin/env node
'use strict';

/**
 * toolcall-qualification — task 0468 CLI.
 *
 * DEFAULT (safe, deterministic): a golden dry-run that replays the fixture
 * reference transcripts through the harness with zero network, zero model,
 * zero production tools, and writes a JSON report to benchmark/reports/.
 *
 *   node scripts/toolcall-qualification.js               # dry-run
 *   node scripts/toolcall-qualification.js --scenario s1_selection_basic
 *
 * LIVE runs are a CONTROLLED CAMPAIGN and refuse to start without the gate:
 *
 *   node scripts/toolcall-qualification.js --live \
 *     --model ax/gemma4:31b-it-qat --host http://127.0.0.1:11434 \
 *     --confirm-campaign RUN_NATIVE_TOOL_QUALIFICATION --repetitions 3
 *
 * Campaign prerequisites (task 0468 constraints — enforced, then documented
 * in the report):
 *   1. Typed disruption confirmation (no live matrix by default; one artifact
 *      per invocation, never a roster sweep).
 *   2. A benchmark host claim via Core's coordination API before load, and an
 *      exact generation-fenced release in `finally` after the run.
 *   3. The artifact+host capability contract fetched from Core — tool support
 *      is read from the contract, never inferred from the model name.
 *   4. think:false for artifacts whose thinking probes are unqualified.
 * Live transports still execute ONLY mocked tools — a live campaign measures
 * the model against the same scripted boundary; production tools are never
 * exposed to any model from this harness.
 */

const fs = require('fs');
const path = require('path');
const {
  readBoundedJson,
  readBoundedText
} = require('../../scripts/bounded-response');

const {
  runHarness,
  makeScriptedTransport
} = require('../src/services/qualification/toolCallHarness');
const {
  CONFIRMATION_TOKEN,
  runToolCapabilityCampaign
} = require('../src/services/qualification/toolCallCampaignRunner');
const { SCENARIOS_V1 } = require('../src/services/qualification/toolCallFixtures');

const DEFAULT_LIVE_TIMEOUT_MS = 600_000;
const MAX_LIVE_RESPONSE_BYTES = 4 * 1024 * 1024;
const MAX_LIVE_ERROR_BYTES = 64 * 1024;

function parseArgs(argv) {
  const args = {
    live: false,
    confirmCampaign: null,
    scenarios: null,
    model: null,
    host: null,
    repetitions: 3,
    campaignId: null,
    out: null
  };
  for (let i = 2; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--live') args.live = true;
    else if (a === '--confirm-campaign') args.confirmCampaign = argv[++i] || null;
    else if (a === '--model') args.model = argv[++i];
    else if (a === '--host') args.host = argv[++i];
    else if (a === '--out') args.out = argv[++i];
    else if (a === '--repetitions') args.repetitions = Number(argv[++i]);
    else if (a === '--campaign-id') args.campaignId = argv[++i];
    else if (a === '--scenario') (args.scenarios = args.scenarios || []).push(argv[++i]);
    else if (a === '--help' || a === '-h') args.help = true;
  }
  return args;
}

function buildLiveTransport({ model, host, fetchImpl, timeoutMs = DEFAULT_LIVE_TIMEOUT_MS }) {
  // Lazy import so the dry-run path never touches node-fetch.
  const fetch = fetchImpl || require('node-fetch');
  return async function liveTransport({ messages, tools, execution = {} }) {
    const signal = AbortSignal.timeout(timeoutMs);
    const ollamaOptions = {};
    if (Number.isInteger(execution.numCtx) && execution.numCtx > 0) ollamaOptions.num_ctx = execution.numCtx;
    if (Number.isInteger(execution.numPredict) && execution.numPredict > 0) ollamaOptions.num_predict = execution.numPredict;
    for (const key of ['temperature', 'top_p', 'top_k', 'repeat_penalty', 'seed']) {
      const value = execution.sampling?.[key];
      if (Number.isFinite(value)) ollamaOptions[key] = value;
    }
    const res = await fetch(`${host.replace(/\/$/, '')}/api/chat`, {
      method: 'POST',
      redirect: 'manual',
      signal,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model,
        messages,
        tools,
        stream: false,
        think: execution.think === true,
        ...(Object.keys(ollamaOptions).length ? { options: ollamaOptions } : {})
      })
    });
    if (!res.ok) {
      let detail;
      try {
        detail = await readBoundedText(res, { maxBytes: MAX_LIVE_ERROR_BYTES, signal });
      } catch (error) {
        detail = `unreadable response (${error.message})`;
      }
      if ([400, 404, 422].includes(res.status)
        && /(?:does not|doesn't|not).*support.*tools?|tools?.*(?:unsupported|not supported)/i.test(detail)) {
        return { toolSupport: false };
      }
      throw new Error(`ollama chat ${res.status}: ${detail}`);
    }
    const data = await readBoundedJson(res, {
      maxBytes: MAX_LIVE_RESPONSE_BYTES,
      signal
    });
    const msg = data.message || {};
    if (Array.isArray(msg.tool_calls) && msg.tool_calls.length > 0) {
      return {
        toolCalls: msg.tool_calls.map((c) => ({
          name: c.function && c.function.name,
          args: (c.function && c.function.arguments) || {}
        }))
      };
    }
    return { content: msg.content || '' };
  };
}

async function main() {
  const args = parseArgs(process.argv);
  if (args.help) {
    console.log('Usage: toolcall-qualification [--scenario id ...] [--out file]  # scenario filters are dry-run only');
    console.log(`       toolcall-qualification --live --model M --host URL --repetitions 3 --confirm-campaign ${CONFIRMATION_TOKEN}`);
    process.exit(0);
  }

  let transport;
  let artifact;
  let report;
  let outputPayload;
  let liveExitOk = false;

  if (args.live) {
    transport = buildLiveTransport({ model: args.model, host: args.host });
    const campaignResult = await runToolCapabilityCampaign({
      model: args.model,
      host: args.host,
      repetitions: args.repetitions,
      confirmation: args.confirmCampaign,
      campaignId: args.campaignId,
      scenarios: args.scenarios || undefined,
      transport
    });
    artifact = {
      model: campaignResult.identity.modelName,
      digest: campaignResult.identity.artifactDigest,
      host: campaignResult.identity.hostUrl
    };
    report = campaignResult.reports[campaignResult.reports.length - 1];
    outputPayload = campaignResult;
    liveExitOk = ['supported', 'unsupported'].includes(campaignResult.qualification?.outcome);
  } else {
    transport = makeScriptedTransport();
    artifact = { model: 'golden-reference', digest: 'golden', host: 'none' };
    report = await runHarness(transport, {
      artifact,
      contractSnapshot: { source: 'golden-dry-run' },
      scenarios: args.scenarios || undefined
    });
    outputPayload = report;
  }

  const outDir = path.join(__dirname, '..', 'reports');
  fs.mkdirSync(outDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const outFile = args.out || path.join(outDir, `toolcall-qualification-${stamp}.json`);
  fs.writeFileSync(outFile, JSON.stringify(outputPayload, null, 2));

  const r = report.toolCallOutcomes.reliability;
  console.log(`[toolcall-qualification] ${args.live ? 'LIVE' : 'DRY-RUN'} ${artifact.model}`);
  console.log(`  scenarios: ${SCENARIOS_V1.length} available, ${r.graded} graded, ${r.passed} passed (ratio ${r.ratio})`);
  console.log(`  classifications: ${JSON.stringify(report.toolCallOutcomes.classificationCounts)}`);
  console.log(`  fixtureFingerprint: ${report.fixtureFingerprint.slice(0, 16)}…`);
  if (args.live) console.log(`  qualification: ${outputPayload.qualification?.outcome || 'inconclusive'}`);
  console.log(`  report: ${outFile}`);
  process.exit(args.live ? (liveExitOk ? 0 : 1) : (r.graded > 0 && r.passed === r.graded ? 0 : 1));
}

if (require.main === module) {
  main().catch((err) => {
    console.error('[toolcall-qualification] fatal:', err.message);
    process.exit(String(err.code || '').startsWith('TOOL_CAMPAIGN_') ? 2 : 3);
  });
}

module.exports = {
  DEFAULT_LIVE_TIMEOUT_MS,
  MAX_LIVE_ERROR_BYTES,
  MAX_LIVE_RESPONSE_BYTES,
  buildLiveTransport,
  main,
  parseArgs
};
