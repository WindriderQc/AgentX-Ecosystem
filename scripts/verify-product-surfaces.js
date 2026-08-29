#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const {
  cancelResponseBody,
  readBoundedText,
} = require('./bounded-response');

const REGISTRY_PATH = path.resolve(__dirname, '..', 'config', 'product-surfaces.json');
const DEFAULT_BASE_URLS = Object.freeze({
  core: 'http://127.0.0.1:3180',
  benchmark: 'http://127.0.0.1:3181',
  rag: 'http://127.0.0.1:3182',
});
const REQUIRED_PROFILES = Object.freeze(['demo', 'full']);
const REQUIRED_SERVICES = Object.freeze(['core', 'benchmark', 'rag']);
const MAX_SURFACE_RESPONSE_BYTES = 4 * 1024 * 1024;
const PERFORMANCE_BUDGET_FIELDS = Object.freeze([
  'maxDecodedBytes',
  'maxJavaScriptBytes',
  'maxAssetRequests',
  'maxDomNodes',
]);
const FAILURE_MARKERS = Object.freeze([
  { pattern: /<script\b[^>]*\bsrc=["']https?:\/\//i, label: 'a WAN-dependent runtime script' },
  {
    pattern: /<link\b(?=[^>]*\brel=["'][^"']*\bstylesheet\b[^"']*["'])(?=[^>]*\bhref=["']https?:\/\/)[^>]*>/i,
    label: 'a WAN-dependent runtime stylesheet',
  },
  { pattern: /\{\{\s*[A-Za-z0-9_.-]+\s*\}\}/, label: 'an unresolved template token' },
  { pattern: /<%[=-]?[^%]+%>/, label: 'an unresolved EJS token' },
  { pattern: /\bCannot GET\b/i, label: 'an Express missing-route response' },
  { pattern: /\bInternal Server Error\b/i, label: 'an internal-server-error response' },
]);

function required(condition, message) {
  if (!condition) throw new Error(message);
}

function readRegistry(filePath = REGISTRY_PATH) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function hasExactMembers(actual, expected) {
  return Array.isArray(actual)
    && actual.length === expected.length
    && new Set(actual).size === actual.length
    && expected.every((value) => actual.includes(value));
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function validateRegistry(registry) {
  required(registry?.schemaVersion === 2, 'Surface registry schemaVersion must be 2');
  required(
    hasExactMembers(registry.profiles, REQUIRED_PROFILES),
    `Surface registry profiles must be exactly: ${REQUIRED_PROFILES.join(', ')}`
  );
  required(
    hasExactMembers(registry.services, REQUIRED_SERVICES),
    `Surface registry services must be exactly: ${REQUIRED_SERVICES.join(', ')}`
  );
  required(
    isPlainObject(registry.performanceBudgets) && Object.keys(registry.performanceBudgets).length > 0,
    'Surface registry performanceBudgets are missing'
  );

  const performanceBudgets = new Map();
  for (const [budgetId, budget] of Object.entries(registry.performanceBudgets)) {
    required(/^[a-z0-9-]+$/.test(budgetId), `Invalid performance budget id: ${budgetId}`);
    required(isPlainObject(budget), `Performance budget ${budgetId} must be an object`);
    required(
      hasExactMembers(Object.keys(budget), PERFORMANCE_BUDGET_FIELDS),
      `Performance budget ${budgetId} fields must be exactly: ${PERFORMANCE_BUDGET_FIELDS.join(', ')}`
    );
    for (const field of PERFORMANCE_BUDGET_FIELDS) {
      required(
        Number.isInteger(budget[field]) && budget[field] > 0,
        `Performance budget ${budgetId}.${field} must be a positive integer`
      );
    }
    performanceBudgets.set(budgetId, Object.freeze({ ...budget }));
  }
  required(Array.isArray(registry.surfaces) && registry.surfaces.length > 0, 'Surface registry surfaces are missing');

  const ids = new Set();
  const servicePaths = new Set();
  for (const surface of registry.surfaces) {
    required(typeof surface.id === 'string' && /^[a-z0-9-]+$/.test(surface.id), 'Every surface needs a stable kebab-case id');
    required(!ids.has(surface.id), `Duplicate surface id: ${surface.id}`);
    ids.add(surface.id);
    required(registry.services.includes(surface.service), `Unknown service for ${surface.id}: ${surface.service}`);
    required(typeof surface.path === 'string' && surface.path.startsWith('/') && !surface.path.includes('?'), `Invalid canonical path for ${surface.id}`);
    const servicePath = `${surface.service}:${surface.path}`;
    required(!servicePaths.has(servicePath), `Duplicate canonical service path: ${servicePath}`);
    servicePaths.add(servicePath);
    required(Array.isArray(surface.profiles) && surface.profiles.length > 0, `Profiles are missing for ${surface.id}`);
    required(new Set(surface.profiles).size === surface.profiles.length, `Duplicate profile for ${surface.id}`);
    required(surface.profiles.every((profile) => registry.profiles.includes(profile)), `Unknown profile for ${surface.id}`);
    required(typeof surface.journey === 'string' && surface.journey.length > 0, `Journey is missing for ${surface.id}`);
    required(typeof surface.critical === 'boolean', `Critical flag is missing for ${surface.id}`);
    if (surface.critical) {
      required(
        typeof surface.performanceBudget === 'string' && surface.performanceBudget.length > 0,
        `Performance budget reference is missing for critical surface ${surface.id}`
      );
    }
    if (surface.performanceBudget !== undefined) {
      required(
        performanceBudgets.has(surface.performanceBudget),
        `Unknown performance budget for ${surface.id}: ${surface.performanceBudget}`
      );
    }
  }

  for (const profile of REQUIRED_PROFILES) {
    for (const service of REQUIRED_SERVICES) {
      const coverage = registry.surfaces.filter((surface) => (
        surface.service === service && surface.profiles.includes(profile)
      ));
      required(coverage.length > 0, `Surface registry has no ${profile} coverage for ${service}`);
      required(
        coverage.some((surface) => surface.critical),
        `Surface registry has no critical ${profile} surface for ${service}`
      );
    }
  }
  return registry;
}

function selectSurfaces(registry, { profile, criticalOnly = false }) {
  required(registry.profiles.includes(profile), `Unknown profile: ${profile}`);
  return registry.surfaces.filter((surface) => (
    surface.profiles.includes(profile) && (!criticalOnly || surface.critical)
  ));
}

function normalizedBaseUrl(value, label) {
  const url = new URL(String(value || ''));
  required(['http:', 'https:'].includes(url.protocol), `${label} URL must use HTTP or HTTPS`);
  url.pathname = url.pathname.replace(/\/+$/, '');
  url.search = '';
  url.hash = '';
  return url.toString().replace(/\/$/, '');
}

async function verifySurface(surface, { fetchImpl, baseUrls, timeoutMs }) {
  const url = `${baseUrls[surface.service]}${surface.path}`;
  const signal = AbortSignal.timeout(timeoutMs);
  let response;
  try {
    response = await fetchImpl(url, {
      redirect: 'manual',
      headers: { Accept: 'text/html' },
      signal,
    });
  } catch (error) {
    throw new Error(`${surface.id} request failed: ${error.message}`);
  }

  required(response.status < 300 || response.status >= 400, `${surface.id} redirected with HTTP ${response.status}`);
  required(response.ok, `${surface.id} returned HTTP ${response.status}`);
  if (response.url) {
    required(
      new URL(response.url).href === new URL(url).href,
      `${surface.id} resolved to the wrong URL: ${response.url}`
    );
  }
  const contentType = String(response.headers?.get?.('content-type') || '');
  required(contentType.includes('text/html'), `${surface.id} returned ${contentType || 'an unknown content type'}, not HTML`);
  const body = await readBoundedText(response, {
    maxBytes: MAX_SURFACE_RESPONSE_BYTES,
    signal,
  });
  required(body.trim().length > 0, `${surface.id} returned an empty page`);
  for (const marker of FAILURE_MARKERS) {
    required(!marker.pattern.test(body), `${surface.id} rendered ${marker.label}`);
  }
  const identityPattern = new RegExp(`\\bdata-agentx-surface\\s*=\\s*["']${surface.id}["']`);
  required(identityPattern.test(body), `${surface.id} did not render its canonical surface identity`);
  return Object.freeze({
    id: surface.id,
    service: surface.service,
    path: surface.path,
    status: response.status,
    identity: surface.id,
  });
}

function selectProfileBoundaries(registry, profile) {
  if (profile !== 'demo') return [];
  return registry.surfaces.filter((surface) => (
    surface.service === 'core'
    && surface.profiles.includes('full')
    && !surface.profiles.includes('demo')
  ));
}

async function verifyProfileBoundary(surface, { fetchImpl, baseUrls, timeoutMs, profile }) {
  const url = `${baseUrls[surface.service]}${surface.path}`;
  const signal = AbortSignal.timeout(timeoutMs);
  let response;
  try {
    response = await fetchImpl(url, {
      redirect: 'manual',
      headers: { Accept: 'text/html,application/json' },
      signal,
    });
  } catch (error) {
    throw new Error(`${surface.id} profile-boundary request failed: ${error.message}`);
  }

  try {
    const observedProfile = String(response.headers?.get?.('x-agentx-profile') || '');
    required(observedProfile === profile, `${surface.id} profile boundary omitted ${profile} identity`);
    if (surface.path === '/') {
      required(response.status === 302, `${surface.id} must redirect the demo front door with HTTP 302`);
      const location = String(response.headers?.get?.('location') || '');
      required(
        new URL(location, url).href === new URL('/demo', baseUrls.core).href,
        `${surface.id} demo redirect must resolve to /demo`
      );
      return Object.freeze({ id: surface.id, status: 302, outcome: 'demo-redirect' });
    }

    required(response.status === 404, `${surface.id} leaked into the demo profile with HTTP ${response.status}`);
    return Object.freeze({ id: surface.id, status: 404, outcome: 'blocked' });
  } finally {
    await cancelResponseBody(response);
  }
}

async function verifyProductSurfaces({
  registry = readRegistry(),
  profile = 'demo',
  criticalOnly = false,
  fetchImpl = fetch,
  baseUrls = DEFAULT_BASE_URLS,
  timeoutMs = 5000,
} = {}) {
  validateRegistry(registry);
  const resolvedBaseUrls = Object.fromEntries(registry.services.map((service) => [
    service,
    normalizedBaseUrl(baseUrls[service], service),
  ]));
  const selected = selectSurfaces(registry, { profile, criticalOnly });
  required(selected.length > 0, `Surface registry selected zero ${profile} surfaces`);
  const boundaries = selectProfileBoundaries(registry, profile);
  const selectedSettled = await Promise.allSettled(selected.map((surface) => verifySurface(surface, {
    fetchImpl,
    baseUrls: resolvedBaseUrls,
    timeoutMs,
  })));
  const boundarySettled = await Promise.allSettled(boundaries.map((surface) => verifyProfileBoundary(surface, {
    fetchImpl,
    baseUrls: resolvedBaseUrls,
    timeoutMs,
    profile,
  })));
  const passed = selectedSettled.filter((result) => result.status === 'fulfilled').map((result) => result.value);
  const boundaryPassed = boundarySettled.filter((result) => result.status === 'fulfilled').map((result) => result.value);
  const failed = selectedSettled
    .map((result, index) => ({ result, surface: selected[index] }))
    .filter(({ result }) => result.status === 'rejected')
    .map(({ result, surface }) => ({ id: surface.id, error: result.reason.message }));
  failed.push(...boundarySettled
    .map((result, index) => ({ result, surface: boundaries[index] }))
    .filter(({ result }) => result.status === 'rejected')
    .map(({ result, surface }) => ({ id: surface.id, error: result.reason.message })));

  if (failed.length) {
    const checkCount = selected.length + boundaries.length;
    const error = new Error(`Surface verification failed (${failed.length}/${checkCount}): ${failed.map((item) => item.error).join('; ')}`);
    error.failures = failed;
    throw error;
  }
  return Object.freeze({
    profile,
    criticalOnly,
    total: selected.length,
    passed,
    profileBoundaries: Object.freeze(boundaryPassed),
  });
}

function parseArgs(argv) {
  const options = { profile: 'demo', criticalOnly: false, baseUrls: { ...DEFAULT_BASE_URLS } };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--profile') options.profile = argv[++index] || '';
    else if (arg === '--critical-only') options.criticalOnly = true;
    else if (arg === '--core-url') options.baseUrls.core = argv[++index] || '';
    else if (arg === '--benchmark-url') options.baseUrls.benchmark = argv[++index] || '';
    else if (arg === '--rag-url') options.baseUrls.rag = argv[++index] || '';
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return options;
}

if (require.main === module) {
  verifyProductSurfaces(parseArgs(process.argv.slice(2)))
    .then((receipt) => process.stdout.write(`product surfaces ok: profile=${receipt.profile} pages=${receipt.total}\n`))
    .catch((error) => {
      process.stderr.write(`Agent X surface verification failed: ${error.message}\n`);
      process.exitCode = 1;
    });
}

module.exports = {
  DEFAULT_BASE_URLS,
  FAILURE_MARKERS,
  MAX_SURFACE_RESPONSE_BYTES,
  REQUIRED_PROFILES,
  REQUIRED_SERVICES,
  PERFORMANCE_BUDGET_FIELDS,
  REGISTRY_PATH,
  parseArgs,
  readRegistry,
  selectSurfaces,
  selectProfileBoundaries,
  validateRegistry,
  verifyProductSurfaces,
  verifySurface,
  verifyProfileBoundary,
};
