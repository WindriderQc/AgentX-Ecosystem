/**
 * Shared API fetch wrapper.
 * Centralises Content-Type header, JSON body serialisation, and error handling.
 *
 * Usage:
 *   import { apiFetch } from '../utils/api.js';
 *   const data = await apiFetch('/api/benchmark/batches');
 *   const created = await apiFetch('/api/benchmark/batch', { method: 'POST', body: { name: 'run-1' } });
 */

/**
 * @param {string} url   API endpoint
 * @param {object} [opts]
 * @param {string} [opts.method]  HTTP method (default GET)
 * @param {object} [opts.body]    Will be JSON.stringified automatically
 * @returns {Promise<any>}  Parsed JSON response
 */
export async function apiFetch(url, opts = {}) {
    const { body, headers: extraHeaders, ...rest } = opts;

    const res = await fetch(url, {
        headers: {
            'Content-Type': 'application/json',
            ...extraHeaders,
        },
        ...rest,
        body: body != null ? JSON.stringify(body) : undefined,
    });

    if (!res.ok) {
        const payload = await res.json().catch(() => ({ error: res.statusText }));
        const err = new Error(payload.error || payload.message || `HTTP ${res.status}`);
        // Preserve the structured response so callers can distinguish e.g. a
        // 409 host/profiling conflict from a hard failure.
        err.status = res.status;
        err.payload = payload;
        err.conflict = payload.conflict || null;
        throw err;
    }

    return res.json();
}
