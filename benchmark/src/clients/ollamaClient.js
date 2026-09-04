/**
 * Centralized Ollama API Client
 *
 * Single wrapper for all Ollama HTTP interactions.  Every service should use
 * this instead of raw `fetch()` to get consistent:
 *  - HTTP agent (keep-alive, connection pool)
 *  - Timeout handling via AbortSignal
 *  - Error normalisation
 *  - Logging
 *
 * Endpoints:  /api/generate, /api/chat, /api/tags, /api/show, /api/ps, /api/create, /api/pull
 */

const { getFetchOptions } = require('../helpers/httpAgent');
const { getConfiguredHosts } = require('../helpers/ollamaHostConfig');
const { admitOllamaTargetResolved } = require('../helpers/ollamaTargetAdmission');
const logger = require('../../config/logger');

const DEFAULT_TIMEOUT_MS = 30_000;

function coerceCreateValue(raw) {
    if (raw == null) return raw;
    const trimmed = String(raw).trim();
    if (/^(true|false)$/i.test(trimmed)) return trimmed.toLowerCase() === 'true';
    if (/^-?\d+(\.\d+)?$/.test(trimmed)) return Number(trimmed);
    return trimmed;
}

function normalizeCreateBody(body = {}) {
    if (!body || typeof body !== 'object') return body;
    if (!body.modelfile) {
        if (body.name && !body.model) {
            return { ...body, model: body.name };
        }
        return body;
    }

    const lines = String(body.modelfile)
        .split('\n')
        .map(line => line.trim())
        .filter(line => line && !line.startsWith('#'));

    const next = { stream: body.stream ?? false };
    if (body.name && !body.model) next.model = body.name;
    if (body.model) next.model = body.model;

    const parameters = {};

    for (const line of lines) {
        const [instruction, ...rest] = line.split(/\s+/);
        const value = rest.join(' ').trim();
        switch ((instruction || '').toUpperCase()) {
        case 'FROM':
            next.from = value;
            break;
        case 'PARAMETER': {
            const [paramName, ...paramRest] = rest;
            if (paramName) parameters[paramName] = coerceCreateValue(paramRest.join(' '));
            break;
        }
        case 'SYSTEM':
            next.system = value.replace(/^"(.*)"$/, '$1');
            break;
        case 'TEMPLATE':
            next.template = value;
            break;
        case 'LICENSE':
            next.license = value;
            break;
        default:
            break;
        }
    }

    if (Object.keys(parameters).length) next.parameters = parameters;
    return next;
}

/**
 * Low-level fetch wrapper with agent + timeout.
 *
 * @param {string} hostUrl   – Ollama host (e.g. "http://localhost:11434")
 * @param {string} path      – API path (e.g. "/api/tags")
 * @param {object} [opts]
 * @param {string} [opts.method='GET']
 * @param {object} [opts.body]        – will be JSON-stringified
 * @param {number} [opts.timeoutMs]   – per-request timeout (default 30 s)
 * @param {AbortSignal} [opts.signal] – external abort signal
 * @returns {Promise<any>}  parsed JSON body
 */
async function ollamaFetch(hostUrl, path, opts = {}) {
    const host = await admitOllamaTargetResolved(hostUrl, { configuredHosts: getConfiguredHosts() });
    const url = `${host}${path}`;
    const method = opts.method || 'GET';
    const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;

    const controller = new AbortController();
    const timer = timeoutMs > 0 ? setTimeout(() => controller.abort(), timeoutMs) : null;

    // Honour an external signal
    const abortFromCaller = () => controller.abort(opts.signal?.reason);
    if (opts.signal) {
        if (opts.signal.aborted) abortFromCaller();
        else opts.signal.addEventListener('abort', abortFromCaller, { once: true });
    }

    const fetchOpts = getFetchOptions(url, {
        method,
        headers: { 'Content-Type': 'application/json' },
        signal: controller.signal,
        redirect: 'manual',
        ...(opts.body ? { body: JSON.stringify(opts.body) } : {})
    });

    try {
        const res = await fetch(url, fetchOpts);
        if (!res.ok) {
            const text = await res.text().catch(() => '');
            const err = new Error(`Ollama ${method} ${path} returned ${res.status}: ${text.slice(0, 200)}`);
            err.status = res.status;
            throw err;
        }
        return await res.json();
    } catch (err) {
        if (err.name === 'AbortError') {
            if (opts.signal?.aborted) {
                if (opts.signal.reason instanceof Error) throw opts.signal.reason;
                const aborted = new Error(`Ollama ${method} ${path} aborted by caller`);
                aborted.code = 'CALLER_ABORTED';
                throw aborted;
            }
            const timeout = new Error(`Ollama ${method} ${path} timed out after ${timeoutMs}ms`);
            timeout.code = 'ETIMEDOUT';
            throw timeout;
        }
        throw err;
    } finally {
        if (timer) clearTimeout(timer);
        opts.signal?.removeEventListener('abort', abortFromCaller);
    }
}

// ── Convenience methods ──────────────────────────────────────────────────────

/** GET /api/tags — list available models */
const listModels = (host, opts) => ollamaFetch(host, '/api/tags', { timeoutMs: 8_000, ...opts });

/** GET /api/ps — running models and VRAM usage */
const listRunning = (host, opts) => ollamaFetch(host, '/api/ps', { timeoutMs: 5_000, ...opts });

/** POST /api/show — model metadata */
const showModel = (host, model, opts) =>
    ollamaFetch(host, '/api/show', { method: 'POST', body: { name: model }, timeoutMs: 15_000, ...opts });

/** POST /api/generate — text completion */
const generate = (host, body, opts) =>
    ollamaFetch(host, '/api/generate', { method: 'POST', body, ...opts });

/** POST /api/chat — chat completion */
const chat = (host, body, opts) =>
    ollamaFetch(host, '/api/chat', { method: 'POST', body, ...opts });

/** POST /api/create — create/deploy a model */
const createModel = (host, body, opts) =>
    ollamaFetch(host, '/api/create', { method: 'POST', body: normalizeCreateBody(body), timeoutMs: 120_000, ...opts });

/** POST /api/pull — install a model and wait until Ollama finishes. */
const pullModel = (host, name, opts) =>
    ollamaFetch(host, '/api/pull', {
        method: 'POST',
        body: { name, stream: false },
        timeoutMs: 30 * 60 * 1000,
        ...opts
    });

module.exports = {
    ollamaFetch,
    listModels,
    listRunning,
    showModel,
    generate,
    chat,
    createModel,
    pullModel,
    normalizeCreateBody,
    DEFAULT_TIMEOUT_MS
};
