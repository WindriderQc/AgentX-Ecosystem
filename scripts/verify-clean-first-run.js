#!/usr/bin/env node
'use strict';

const {
  cancelResponseBody,
  readBoundedJson,
  readBoundedText,
} = require('./bounded-response');

const DEFAULT_URLS = Object.freeze({
  core: 'http://127.0.0.1:3180',
  benchmark: 'http://127.0.0.1:3181',
  rag: 'http://127.0.0.1:3182',
});
const REQUEST_TIMEOUT_MS = 5000;
const MAX_CLEAN_FIRST_RUN_RESPONSE_BYTES = 4 * 1024 * 1024;
const PRIVATE_MARKER = /\b(?:aiops|openclaw|herm[eè]s|octoprint|specialblend|ugbrutal|ugalien|ugfrank|windrider)\b|192\.168\.|10\.0\.0\.99/i;

function required(condition, message) {
  if (!condition) throw new Error(message);
}

function baseUrl(value, label) {
  let parsed;
  try {
    parsed = new URL(String(value || ''));
  } catch {
    throw new Error(`${label} URL is invalid`);
  }
  required(['http:', 'https:'].includes(parsed.protocol), `${label} URL must use HTTP or HTTPS`);
  parsed.pathname = parsed.pathname.replace(/\/+$/, '');
  parsed.search = '';
  parsed.hash = '';
  return parsed.toString().replace(/\/$/, '');
}

async function request(fetchImpl, url, label) {
  const signal = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
  let response;
  try {
    response = await fetchImpl(url, {
      headers: { Accept: 'application/json, text/html;q=0.9' },
      redirect: 'follow',
      signal,
    });
  } catch (error) {
    throw new Error(`${label} request failed: ${error.message}`);
  }
  if (!response || response.ok !== true) {
    await cancelResponseBody(response);
    required(false, `${label} returned HTTP ${response?.status ?? 'unknown'}`);
  }
  return { response, signal };
}

async function requestJson(fetchImpl, url, label) {
  const { response, signal } = await request(fetchImpl, url, label);
  try {
    return await readBoundedJson(response, {
      maxBytes: MAX_CLEAN_FIRST_RUN_RESPONSE_BYTES,
      signal,
    });
  } catch (error) {
    if (error?.code !== 'INVALID_JSON') {
      throw new Error(`${label} response could not be read: ${error.message}`);
    }
    throw new Error(`${label} did not return valid JSON`);
  }
}

async function requestText(fetchImpl, url, label) {
  const { response, signal } = await request(fetchImpl, url, label);
  try {
    const body = await readBoundedText(response, {
      maxBytes: MAX_CLEAN_FIRST_RUN_RESPONSE_BYTES,
      signal,
    });
    return { response, body };
  } catch (error) {
    throw new Error(`${label} response could not be read: ${error.message}`);
  }
}

function verifyCanonicalIdentity(body, service, label) {
  required(body?.service === service, `${label} health service identity is invalid`);
  required(typeof body?.version === 'string' && body.version.length > 0, `${label} health version is missing`);
  required(body?.profile === 'demo', `${label} health profile is not demo`);
  required(typeof body?.revision === 'string' && body.revision.length > 0, `${label} health revision is missing`);
  required(Number.isFinite(Date.parse(body?.ts)), `${label} health timestamp is invalid`);
}

function verifyCoreHealth(body) {
  required(body?.ok === true, 'Core health is not ok');
  required(body?.status === 'ok', 'Core health status is not ok');
  verifyCanonicalIdentity(body, 'agentx-core', 'Core');
  required(body?.details?.mongodb === 'connected', 'Core is not connected to MongoDB');
}

function verifyBenchmarkHealth(body) {
  required(body?.ok === true, 'Benchmark health is not ok');
  required(body?.status === 'ok', 'Benchmark health status is not ok');
  verifyCanonicalIdentity(body, 'agentx-benchmark', 'Benchmark');
  required(body?.db === 'connected', 'Benchmark is not connected to MongoDB');
}

function verifyRagHealth(body) {
  required(body?.ok === true, 'RAG health is not ok');
  required(body?.status === 'ok', 'RAG health status is not ok');
  verifyCanonicalIdentity(body, 'agentx-rag', 'RAG');
  required(body?.db === 'connected', 'RAG is not connected to MongoDB');
  required(body?.vectorStore?.healthy === true, 'RAG vector store is not healthy');
}

async function verifyCleanFirstRun({ fetchImpl = fetch, urls = DEFAULT_URLS } = {}) {
  const resolved = Object.freeze({
    core: baseUrl(urls.core, 'Core'),
    benchmark: baseUrl(urls.benchmark, 'Benchmark'),
    rag: baseUrl(urls.rag, 'RAG'),
  });

  const [coreHealth, benchmarkHealth, ragHealth, config, landingResult] = await Promise.all([
    requestJson(fetchImpl, `${resolved.core}/health`, 'Core health'),
    requestJson(fetchImpl, `${resolved.benchmark}/health`, 'Benchmark health'),
    requestJson(fetchImpl, `${resolved.rag}/health`, 'RAG health'),
    requestJson(fetchImpl, `${resolved.core}/api/config`, 'Core config'),
    requestText(fetchImpl, `${resolved.core}/`, 'Core landing page'),
  ]);

  verifyCoreHealth(coreHealth);
  verifyBenchmarkHealth(benchmarkHealth);
  verifyRagHealth(ragHealth);
  required(config?.profile === 'demo', 'Core did not start in the demo profile');

  const landingPath = new URL(landingResult.response.url || `${resolved.core}/`).pathname;
  required(landingPath === '/demo', `Core root did not resolve to /demo; received ${landingPath}`);
  const landing = landingResult.body;
  required(/Agent X/i.test(landing), 'Demo landing page is missing the Agent X identity');
  required(/\/playground\?persona=learning_guide/.test(landing), 'Demo landing page is missing the Learning Guide path');
  required(!PRIVATE_MARKER.test(landing), 'Demo landing page contains a private-environment marker');

  return Object.freeze({
    status: 'ok',
    profile: config.profile,
    services: Object.freeze({ core: 'healthy', benchmark: 'healthy', rag: 'healthy' }),
    landing: Object.freeze({ path: landingPath, learningGuide: true }),
    ollama: 'optional-not-required',
  });
}

function parseArgs(argv) {
  const urls = { ...DEFAULT_URLS };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--core-url') urls.core = argv[++index] || '';
    else if (arg === '--benchmark-url') urls.benchmark = argv[++index] || '';
    else if (arg === '--rag-url') urls.rag = argv[++index] || '';
    else throw new Error(`unknown argument: ${arg}`);
  }
  return urls;
}

if (require.main === module) {
  verifyCleanFirstRun({ urls: parseArgs(process.argv.slice(2)) })
    .then((receipt) => {
      process.stdout.write(
        `clean first run ok: profile=${receipt.profile} services=${Object.keys(receipt.services).join(',')} landing=${receipt.landing.path} ollama=${receipt.ollama}\n`
      );
    })
    .catch((error) => {
      process.stderr.write(`Agent X clean-first-run contract failed: ${error.message}\n`);
      process.exitCode = 1;
    });
}

module.exports = {
  DEFAULT_URLS,
  MAX_CLEAN_FIRST_RUN_RESPONSE_BYTES,
  PRIVATE_MARKER,
  parseArgs,
  verifyCleanFirstRun,
};
