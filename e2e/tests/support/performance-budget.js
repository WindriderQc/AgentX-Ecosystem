'use strict';

const PERFORMANCE_ATTACHMENT_NAME = 'agentx-browser-performance';
const PERFORMANCE_RECORD_KIND = 'agentx.browser-performance-observation';
const PERFORMANCE_RECORD_SCHEMA_VERSION = 1;
const RELEASE_ASSET_TYPES = Object.freeze([
  'document',
  'script',
  'stylesheet',
  'font',
  'image',
]);
const RELEASE_ASSET_TYPE_SET = new Set(RELEASE_ASSET_TYPES);

function firstPartyReleaseRequest(request, allowedOrigins) {
  if (!request || !RELEASE_ASSET_TYPE_SET.has(request.resourceType())) return false;
  try {
    return allowedOrigins.includes(new URL(request.url()).origin);
  } catch {
    return false;
  }
}

function emptyBreakdown() {
  return Object.fromEntries(RELEASE_ASSET_TYPES.map((resourceType) => [
    resourceType,
    { requests: 0, decodedBytes: 0 },
  ]));
}

function freezeMetrics(breakdown, domNodes) {
  const frozenBreakdown = Object.freeze(Object.fromEntries(
    RELEASE_ASSET_TYPES.map((resourceType) => [
      resourceType,
      Object.freeze({ ...breakdown[resourceType] }),
    ])
  ));
  return Object.freeze({
    decodedBytes: RELEASE_ASSET_TYPES.reduce(
      (total, resourceType) => total + frozenBreakdown[resourceType].decodedBytes,
      0
    ),
    javaScriptBytes: frozenBreakdown.script.decodedBytes,
    assetRequests: RELEASE_ASSET_TYPES.reduce(
      (total, resourceType) => total + frozenBreakdown[resourceType].requests,
      0
    ),
    domNodes,
    byType: frozenBreakdown,
  });
}

function createPerformanceCollector(page, { allowedOrigins, settleTimeoutMs = 5000 } = {}) {
  if (!page || typeof page.on !== 'function') throw new TypeError('page is required');
  if (!Array.isArray(allowedOrigins) || allowedOrigins.length === 0) {
    throw new TypeError('allowedOrigins must be a non-empty array');
  }

  const breakdown = emptyBreakdown();
  const seenResponses = new Set();
  const inFlight = new Set();
  const bodyReads = new Set();
  const bodyErrors = [];
  let stopped = false;

  const onRequest = (request) => {
    if (firstPartyReleaseRequest(request, allowedOrigins)) inFlight.add(request);
  };
  const finishRequest = (request) => inFlight.delete(request);
  const onResponse = (response) => {
    const request = response.request();
    if (!firstPartyReleaseRequest(request, allowedOrigins)) return;
    finishRequest(request);
    if (!response.ok()) return;

    const resourceType = request.resourceType();
    const key = `${resourceType}:${request.url()}`;
    if (seenResponses.has(key)) return;
    seenResponses.add(key);

    let read;
    read = response.body()
      .then((body) => {
        breakdown[resourceType].requests += 1;
        breakdown[resourceType].decodedBytes += body.byteLength;
      })
      .catch(() => {
        bodyErrors.push(`Could not read a successful ${resourceType} response body`);
      })
      .finally(() => bodyReads.delete(read));
    bodyReads.add(read);
  };

  page.on('request', onRequest);
  page.on('response', onResponse);
  page.on('requestfinished', finishRequest);
  page.on('requestfailed', finishRequest);

  function stop() {
    if (stopped) return;
    stopped = true;
    page.off('request', onRequest);
    page.off('response', onResponse);
    page.off('requestfinished', finishRequest);
    page.off('requestfailed', finishRequest);
  }

  async function settle() {
    try {
      await page.evaluate(async () => {
        if (document.fonts?.ready) await document.fonts.ready;
        await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      });

      const deadline = Date.now() + settleTimeoutMs;
      while (inFlight.size > 0 || bodyReads.size > 0) {
        await Promise.all([...bodyReads]);
        if (inFlight.size === 0 && bodyReads.size === 0) break;
        if (Date.now() >= deadline) {
          throw new Error(
            `Performance asset collection did not settle (${inFlight.size} request(s), ${bodyReads.size} body read(s))`
          );
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }

      if (bodyErrors.length > 0) throw new Error(bodyErrors.join('; '));
      const domNodes = await page.locator('*').count();
      return freezeMetrics(breakdown, domNodes);
    } finally {
      stop();
    }
  }

  return Object.freeze({ settle, stop });
}

function budgetViolations(metrics, limits) {
  const checks = [
    ['decodedBytes', 'decoded first-party bytes', limits.maxDecodedBytes],
    ['javaScriptBytes', 'decoded JavaScript bytes', limits.maxJavaScriptBytes],
    ['assetRequests', 'unique first-party release-asset responses', limits.maxAssetRequests],
    ['domNodes', 'DOM nodes', limits.maxDomNodes],
  ];
  return checks
    .filter(([field, , limit]) => metrics[field] > limit)
    .map(([field, label, limit]) => Object.freeze({
      field,
      label,
      observed: metrics[field],
      limit,
    }));
}

function createPerformanceRecord({ surface, profile, project, viewport, budget, metrics }) {
  return Object.freeze({
    schemaVersion: PERFORMANCE_RECORD_SCHEMA_VERSION,
    kind: PERFORMANCE_RECORD_KIND,
    surface: Object.freeze({ id: surface.id, service: surface.service }),
    profile,
    project,
    viewport: Object.freeze({
      width: Number(viewport?.width) || null,
      height: Number(viewport?.height) || null,
    }),
    budget: Object.freeze({ id: budget.id, limits: Object.freeze({ ...budget.limits }) }),
    observed: metrics,
  });
}

module.exports = {
  PERFORMANCE_ATTACHMENT_NAME,
  PERFORMANCE_RECORD_KIND,
  PERFORMANCE_RECORD_SCHEMA_VERSION,
  RELEASE_ASSET_TYPES,
  budgetViolations,
  createPerformanceCollector,
  createPerformanceRecord,
  firstPartyReleaseRequest,
  freezeMetrics,
};
