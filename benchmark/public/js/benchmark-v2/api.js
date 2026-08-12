// api.js — thin fetch wrappers for the benchmark-v2 page (The Engine Room)
// All endpoints verified against routes/benchmark/ route files and server.js.

import { apiFetch } from '../utils/api.js';

const BASE = '/api/benchmark';

// ── Hosts ────────────────────────────────────────────────────────────────────

/** GET /api/ollama-hosts — list all configured Ollama hosts with status */
export const fetchHosts = () => apiFetch('/api/ollama-hosts');

// ── Profiler ─────────────────────────────────────────────────────────────────

/** GET /api/profiler/hosts — host profiles with baseline, status, GPU info */
export const fetchProfilerHosts = () => apiFetch('/api/profiler/hosts');

/** GET /api/profiler/models — model profiles with per-host readiness maps */
export const fetchProfilerModels = () => apiFetch('/api/profiler/models');

/** GET /api/profiler/dashboard — profiler summary including benchmarked model names */
export const fetchProfilerDashboard = () => apiFetch('/api/profiler/dashboard');

/** GET /api/profiler/pipeline/profile/active — running single-model profile jobs */
export const fetchActiveProfiles = () => apiFetch('/api/profiler/pipeline/profile/active');

/** GET /api/profiler/pipeline/profile-host/active — running per-host profile queues */
export const fetchActiveProfileQueues = () => apiFetch('/api/profiler/pipeline/profile-host/active');

// ── Batches ──────────────────────────────────────────────────────────────────

/** GET /api/benchmark/batches/active — return the currently running batch or null */
export const fetchActiveBatch = () => apiFetch(`${BASE}/batches/active`);

/**
 * GET /api/benchmark/batch/:id — full batch data including results and current test.
 * include_heavy=true includes raw responses; include_all_results=true fetches every result.
 */
export const fetchBatchProgress = (id) => apiFetch(`${BASE}/batch/${id}?include_heavy=true&include_all_results=true`);

/** POST /api/benchmark/batch — start a new benchmark batch */
export const startBatch = (config) => apiFetch(`${BASE}/batch`, { method: 'POST', body: config });

/** POST /api/benchmark/batch/:id/stop — request a graceful stop */
export const stopBatch = (id) => apiFetch(`${BASE}/batch/${id}/stop`, { method: 'POST' });

/** POST /api/benchmark/batch/:id/resume — resume a stopped/failed/interrupted batch */
export const resumeBatch = (id) => apiFetch(`${BASE}/batch/${id}/resume`, { method: 'POST' });

/** POST /api/benchmark/batch/:id/recover — mark a stuck running batch as stopped */
export const recoverBatch = (id) => apiFetch(`${BASE}/batch/${id}/recover`, { method: 'POST' });

/** POST /api/benchmark/batch/:id/rerun-invalid — preview or launch corrected invalid-row rerun */
export const rerunInvalidRows = (id, body = {}) => apiFetch(`${BASE}/batch/${id}/rerun-invalid`, { method: 'POST', body });

function hasRemainingResumeWork(batch) {
    if (!batch || !['stopped', 'failed', 'interrupted'].includes(batch.status)) return false;

    const totalTests = Number(batch.total_tests) || 0;
    const completed = Number(batch.completed) || 0;
    const judgePending = Number(batch.judge_stats?.pending) || 0;
    const checkpointCount = Array.isArray(batch.checkpoint?.completed_pairs)
        ? batch.checkpoint.completed_pairs.length
        : null;

    const executionRemaining = totalTests > 0
        ? Math.max(0, totalTests - Math.max(completed, checkpointCount ?? 0)) > 0
        : false;

    return executionRemaining || judgePending > 0;
}

/**
 * Fetch the most recent resumable batch (stopped/failed/interrupted).
 * Returns the batch object or null. Batches the user explicitly dismissed
 * via the resume banner are filtered out (see resume-banner-dismiss.js
 * concept — stored as JSON array under `bv2_dismissedResumeIds`).
 */
const SK_DISMISSED = 'bv2_dismissedResumeIds';

function _readDismissed() {
    try {
        const raw = localStorage.getItem(SK_DISMISSED);
        const arr = raw ? JSON.parse(raw) : [];
        return Array.isArray(arr) ? new Set(arr.map(String)) : new Set();
    } catch { return new Set(); }
}

export function dismissResumableBatch(batchId) {
    if (!batchId) return;
    const set = _readDismissed();
    set.add(String(batchId));
    try { localStorage.setItem(SK_DISMISSED, JSON.stringify([...set])); } catch {}
}

export async function fetchResumableBatch() {
    // Fetch recent batches and find the most recent batch with real remaining work.
    const res = await fetchBatches({ limit: 10 });
    const batches = res?.data?.batches || [];
    const dismissed = _readDismissed();
    const resumable = batches.find(b => {
        const id = String(b?._id || b?.id || '');
        if (id && dismissed.has(id)) return false;
        return hasRemainingResumeWork(b);
    });
    return resumable || null;
}

// ── Timeline ─────────────────────────────────────────────────────────────────

/** GET /api/benchmark/batch/:id/timeline — ordered list of completed test segments */
export const fetchTimeline = (batchId) => apiFetch(`${BASE}/batch/${batchId}/timeline`);

// ── Prompts & Config ─────────────────────────────────────────────────────────

/** GET /api/benchmark/prompts — full prompt library */
export const fetchPrompts = () => apiFetch(`${BASE}/prompts`);

/** GET /api/benchmark/config — judge defaults and benchmark configuration */
export const fetchConfig = () => apiFetch(`${BASE}/config`);

// ── Batches list ────────────────────────────────────────────────────────────

/** GET /api/benchmark/batches — list batches with optional filters (status, limit) */
export function fetchBatches(params = {}) {
    const qs = new URLSearchParams(params).toString();
    return apiFetch(qs ? `${BASE}/batches?${qs}` : `${BASE}/batches`);
}

// ── Judge roster ────────────────────────────────────────────────────────────

/** GET /api/benchmark/judge-roster — judge models with eval stats and host availability */
export const fetchJudgeRoster = () => apiFetch(`${BASE}/judge-roster`);

// ── Preflight ────────────────────────────────────────────────────────────────

/**
 * POST /api/benchmark/preflight — check host reachability and model availability.
 * @param {object} config — e.g. { host, models, judgeModel, judgeHost }
 */
export const preflight = (config) => apiFetch(`${BASE}/preflight`, { method: 'POST', body: config });

// ── Templates ────────────────────────────────────────────────────────────────

/** GET /api/benchmark/templates — list saved batch templates */
export const fetchTemplates = () => apiFetch(`${BASE}/templates`);

/** POST /api/benchmark/templates — save a new template */
export const saveTemplate = (payload) => apiFetch(`${BASE}/templates`, { method: 'POST', body: payload });

/** DELETE /api/benchmark/templates/:id */
export const deleteTemplate = (id) => apiFetch(`${BASE}/templates/${id}`, { method: 'DELETE' });

/** POST /api/benchmark/templates/:id/use — record a template use */
export const useTemplate = (id) => apiFetch(`${BASE}/templates/${id}/use`, { method: 'POST' });
