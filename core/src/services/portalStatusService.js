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

const PROBE_TIMEOUT_MS = Number(process.env.PORTAL_HEALTH_TIMEOUT_MS) || 1500;

// id ↔ portal tile mapping is by `id` (the portal sets data-service on each tile).
const SERVICES = [
    { id: 'core',      label: 'AgentX Core',     port: 3080, env: null,                    path: '/health' },
    { id: 'benchmark', label: 'Benchmark',       port: 3081, env: 'BENCHMARK_SERVICE_URL', path: '/health' },
    // RAG's status endpoint reports dependency readiness (Mongo, embeddings,
    // Qdrant). Its /health endpoint is intentionally only a liveness probe.
    { id: 'rag',       label: 'RAG',             port: 3082, env: 'RAG_SERVICE_URL',        path: '/api/rag/status' }
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
        .map(([name, dependency]) => `${name}: ${dependency.error || 'not ready'}`);
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
        if (ollama !== 'connected') issues.push(`ollama: ${ollama || 'unknown'}`);
        return {
            id: svc.id, label: svc.label, port: svc.port,
            status: issues.length ? 'degraded' : 'ok',
            latency_ms: 0,
            issues,
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
        return {
            id: svc.id, label: svc.label, port: svc.port,
            status, latency_ms: latency,
            issues: issuesFromDetail(detail),
            detail: detail || { http: res.status }
        };
    } catch (err) {
        return {
            id: svc.id, label: svc.label, port: svc.port,
            status: 'down', latency_ms: null,
            issues: [(err && err.name === 'AbortError' ? 'timeout' : (err && (err.code || err.message)) || 'unreachable')],
            detail: { error: err && err.name === 'AbortError' ? 'timeout' : (err && (err.code || err.message)) || 'unreachable' }
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
    const count = (s) => services.filter((r) => r.status === s).length;
    const serviceDown = count('down');
    const serviceDegraded = count('degraded');
    const status = serviceDown ? 'down' : (serviceDegraded ? 'degraded' : 'ok');

    return {
        generated_at: new Date().toISOString(),
        summary: {
            status,
            total: services.length,
            healthy: count('ok'),
            degraded: serviceDegraded,
            down: serviceDown
        },
        services
    };
}

module.exports = { getPortalStatus, SERVICES };
