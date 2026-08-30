// api.js — thin fetch wrappers for the leaderboard-v2 page
// All endpoints confirmed against routes/benchmark/ route files.

import { apiFetch } from '../utils/api.js';

const BASE = '/api/benchmark';

export const fetchDashboard = (includeUnavailableModels = false) => {
    const params = new URLSearchParams();
    if (includeUnavailableModels) params.set('includeUnavailableModels', '1');
    const qs = params.toString();
    return apiFetch(`${BASE}/dashboard${qs ? `?${qs}` : ''}`);
};

// axis param ∈ {'composite' (default), 'deterministic', 'subjective'} per task 0199.
// Composite preserves the historical fetch shape; explicit axes opt into the
// per-signal aggregation paths in src/services/benchmark/index.js.
export const fetchGeneralistLeaderboard = (axis = 'composite', hostScope = 'current', challengeScope = 'advanced', includeUnavailableModels = false, trustScope = 'trusted') => {
    const params = new URLSearchParams();
    if (axis && axis !== 'composite') params.set('axis', axis);
    if (hostScope) params.set('hostScope', hostScope);
    if (challengeScope) params.set('challengeScope', challengeScope);
    if (trustScope && trustScope !== 'exploratory') params.set('trustScope', trustScope);
    if (includeUnavailableModels) params.set('includeUnavailableModels', '1');
    const qs = params.toString();
    return apiFetch(`${BASE}/generalist-leaderboard${qs ? `?${qs}` : ''}`);
};

export const fetchGroundTruthGaps = () =>
    apiFetch(`${BASE}/judge/ground-truth/gaps`);

export function fetchQualityBreakdown(model, host) {
    const params = new URLSearchParams({ model });
    if (host) params.set('host', host);
    return apiFetch(`${BASE}/quality-breakdown?${params}`);
}

export const fetchBatchQualityBreakdown = (pairs) =>
    apiFetch(`${BASE}/quality-breakdown/batch`, { method: 'POST', body: { pairs } });

function hostNameMapToHosts(payload) {
    const map = payload?.data || payload || {};
    return {
        hosts: Object.entries(map).map(([url, name]) => ({
            id: String(name || url),
            name: String(name || url),
            url,
            available: true,
            models: []
        }))
    };
}

export async function fetchHosts() {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 900);
    try {
        return await apiFetch('/api/ollama-hosts', { signal: controller.signal });
    } catch (_) {
        return hostNameMapToHosts(await apiFetch(`${BASE}/host-names`));
    } finally {
        clearTimeout(timeout);
    }
}

export function fetchResults(params = {}) {
    const qs = new URLSearchParams(params).toString();
    return apiFetch(`${BASE}/results/advanced?${qs}`);
}
