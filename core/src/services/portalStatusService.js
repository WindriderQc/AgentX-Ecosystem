/**
 * Portal status aggregator — "Live Portal".
 *
 * Server-side health probe of every AgentX service so the portal landing page
 * (core/public/portal/index.html) can show live status WITHOUT cross-origin
 * requests (the browser only ever calls same-origin core `/api/portal/health`).
 *
 * Best-effort and fail-soft: bounded per-service timeout, never throws, and a
 * single unreachable service never blocks the others (Promise.all over
 * individually-guarded probes). Cross-service base URLs reuse the same env
 * convention as the existing core service clients
 * (BENCHMARK_SERVICE_URL / RAG_SERVICE_URL),
 * so this routes identically to how core already reaches its siblings.
 */

const { createServiceIdentity } = require('../../../shared/serviceIdentity');

const CORE_VERSION = require('../../package.json').version || '0.0.0';
const PROBE_TIMEOUT_MS = Number(process.env.PORTAL_HEALTH_TIMEOUT_MS) || 1500;

// id ↔ portal tile mapping is by `id` (the portal sets data-service on each tile).
const SERVICES = [
    { id: 'core',      identity: 'agentx-core',      label: 'AgentX Core', port: 3080, env: null,                    path: '/health' },
    { id: 'benchmark', identity: 'agentx-benchmark', label: 'Benchmark',   port: 3081, env: 'BENCHMARK_SERVICE_URL', path: '/health' },
    { id: 'rag',       identity: 'agentx-rag',       label: 'RAG',         port: 3082, env: 'RAG_SERVICE_URL',        path: '/health' }
];

function baseFor(svc) {
    const envKeys = Array.isArray(svc.env) ? svc.env : [svc.env].filter(Boolean);
    const raw = envKeys.map((key) => process.env[key]).find(Boolean);
    return (raw || `http://localhost:${svc.port}`).replace(/\/+$/, '');
}

const HEALTHY_STATUSES = new Set(['ok', 'success', 'healthy', 'connected', 'up']);
const DEGRADED_STATUSES = new Set(['degraded', 'warn', 'warning']);
const DOWN_STATUSES = new Set(['down', 'error', 'failed', 'unhealthy']);

function statusFromDetail(detail, fallback) {
    if (!detail || typeof detail !== 'object') return fallback;

    // A canonical `ok: true` means that the request succeeded; it does not
    // guarantee that the capability is ready. Prefer explicit readiness from
    // the response payload before interpreting the transport envelope.
    const payload = detail.data && typeof detail.data === 'object' ? detail.data : detail;
    const dependencies = payload.dependencies && typeof payload.dependencies === 'object'
        ? Object.values(payload.dependencies)
        : [];
    if (payload.healthy === false || payload.ready === false
        || dependencies.some((dependency) => dependency?.healthy === false)) {
        return 'degraded';
    }
    if (payload.healthy === true || payload.ready === true) return 'ok';

    if (detail.ok === true) return 'ok';
    if (detail.ok === false) return fallback === 'down' ? 'down' : 'degraded';

    const raw = String(detail.status || detail.health || '').trim().toLowerCase();
    if (HEALTHY_STATUSES.has(raw)) return 'ok';
    if (DEGRADED_STATUSES.has(raw)) return 'degraded';
    if (DOWN_STATUSES.has(raw)) return 'down';
    return fallback;
}

function issuesFromDetail(detail) {
    if (!detail || typeof detail !== 'object') return [];
    const payload = detail.data && typeof detail.data === 'object' ? detail.data : detail;
    const dependencies = payload.dependencies && typeof payload.dependencies === 'object'
        ? payload.dependencies
        : {};

    return Object.entries(dependencies)
        .filter(([, dependency]) => dependency?.healthy === false)
        .map(([name]) => `${/^[a-z0-9-]{1,32}$/i.test(name) ? name : 'dependency'}: not ready`);
}

function identityFromDetail(detail) {
    if (!detail || typeof detail !== 'object') return null;
    const payload = detail.data && typeof detail.data === 'object' ? detail.data : detail;
    const source = payload.identity && typeof payload.identity === 'object'
        ? payload.identity
        : payload;
    const required = ['service', 'version', 'profile', 'revision', 'ts'];
    if (required.some((key) => typeof source[key] !== 'string' || source[key].length === 0)) return null;
    if (!/^agentx-[a-z0-9-]+$/.test(source.service)) return null;
    if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(source.version)) return null;
    if (!['demo', 'full'].includes(source.profile)) return null;
    if (!/^(?:[A-Fa-f0-9]{7,64}|[A-Za-z][A-Za-z0-9_-]{0,127})$/.test(source.revision)) return null;
    if (!Number.isFinite(Date.parse(source.ts)) || new Date(source.ts).toISOString() !== source.ts) return null;
    return Object.freeze(Object.fromEntries(required.map((key) => [key, source[key]])));
}

function summarizeIdentityConsistency(services) {
    const identities = services.map((service) => service.identity).filter(Boolean);
    const missing = services.filter((service) => !service.identity).map((service) => service.id);
    const distinct = (key) => [...new Set(identities.map((identity) => identity[key]))];
    const profiles = distinct('profile');
    const versions = distinct('version');
    const revisions = distinct('revision');
    const issues = [];

    if (missing.length) issues.push(`Identity unavailable: ${missing.join(', ')}`);
    if (profiles.length > 1) issues.push(`Mixed runtime profiles: ${profiles.join(', ')}`);
    if (versions.length > 1) issues.push(`Mixed product versions: ${versions.join(', ')}`);
    if (revisions.length > 1) issues.push(`Mixed build revisions: ${revisions.join(', ')}`);

    let status = issues.length ? 'degraded' : 'ok';
    if (status === 'ok' && revisions.length === 1 && revisions[0] === 'unknown') {
        status = 'unverified';
        issues.push('Build revision is not embedded in this process.');
    }

    return Object.freeze({ status, profiles, versions, revisions, missing, issues });
}

/**
 * Probe one service. Returns a status record; never throws.
 * `status` ∈ 'ok' | 'degraded' | 'down'.
 */
async function probe(svc, localHealth) {
    // Core probes itself in-process — no self HTTP round-trip.
    if (svc.id === 'core') {
        const mongo = localHealth && localHealth.mongodb && localHealth.mongodb.status;
        const ollama = localHealth && localHealth.ollama && localHealth.ollama.status;
        const issues = [];
        if (mongo !== 'connected') issues.push(`mongodb: ${mongo || 'unknown'}`);
        return {
            id: svc.id, label: svc.label, port: svc.port,
            status: issues.length ? 'degraded' : 'ok',
            latency_ms: 0,
            issues,
            identity: identityFromDetail(createServiceIdentity({ service: 'agentx-core', version: CORE_VERSION })),
            capabilities: {
                ollama: { status: ollama || 'unknown', optional: true }
            },
            detail: { mongodb: mongo || 'unknown', ollama: ollama || 'unknown' }
        };
    }

    const url = baseFor(svc) + svc.path;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
    const started = Date.now();
    try {
        const res = await fetch(url, { signal: controller.signal, redirect: 'manual' });
        const latency = Date.now() - started;
        let detail = null;
        try { detail = await res.json(); } catch (_) { /* non-JSON service response */ }

        let status = (res.status >= 200 && res.status < 400) ? 'ok' : 'degraded';
        status = statusFromDetail(detail, status);
        const observedIdentity = identityFromDetail(detail);
        const identityMatches = observedIdentity?.service === svc.identity;
        const issues = issuesFromDetail(detail);
        if (observedIdentity && !identityMatches) {
            issues.push('identity: unexpected service');
            status = 'degraded';
        }
        return {
            id: svc.id, label: svc.label, port: svc.port,
            status, latency_ms: latency,
            issues,
            identity: identityMatches ? observedIdentity : null,
            detail: { httpStatus: res.status }
        };
    } catch (err) {
        const reason = err && err.name === 'AbortError' ? 'timeout' : 'unreachable';
        return {
            id: svc.id, label: svc.label, port: svc.port,
            status: 'down', latency_ms: null,
            issues: [reason],
            identity: null,
            detail: { reason }
        };
    } finally {
        clearTimeout(timer);
    }
}

/**
 * Aggregate status for all services.
 * @param {Object} [localHealth] core's in-process systemHealth ({mongodb,ollama})
 * @returns {Promise<Object>} { generated_at, summary, services[] }
 */
async function getPortalStatus(localHealth) {
    const services = await Promise.all(SERVICES.map((service) => probe(service, localHealth)));
    const consistency = summarizeIdentityConsistency(services);
    const count = (s) => services.filter((r) => r.status === s).length;
    const serviceDown = count('down');
    const serviceDegraded = count('degraded');
    const status = serviceDown
        ? 'down'
        : (serviceDegraded || consistency.status === 'degraded' ? 'degraded' : 'ok');
    const generatedAt = new Date().toISOString();

    return {
        generatedAt,
        generated_at: generatedAt,
        summary: {
            status,
            total: services.length,
            healthy: count('ok'),
            degraded: serviceDegraded,
            down: serviceDown,
            identityStatus: consistency.status
        },
        consistency,
        services
    };
}

module.exports = {
    getPortalStatus,
    identityFromDetail,
    summarizeIdentityConsistency,
    SERVICES
};
