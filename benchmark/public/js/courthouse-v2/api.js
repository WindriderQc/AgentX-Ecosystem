// api.js — thin fetch wrappers for courthouse-v2
// All endpoints verified against routes/benchmark/ route files.

import { apiFetch } from '../utils/api.js';

const BASE = '/api/benchmark';

/**
 * GET /api/benchmark/results/advanced
 * @param {object} params - query params (model, categories, levelMin/Max, etc.)
 */
export function fetchResults(params = {}) {
    const qs = new URLSearchParams(params).toString();
    return apiFetch(`${BASE}/results/advanced?${qs}`);
}

/**
 * GET /api/benchmark/results/:id
 * @param {string} id - MongoDB _id
 */
export const fetchResult = (id) => apiFetch(`${BASE}/results/${encodeURIComponent(id)}`);

/**
 * GET /api/benchmark/results/needs-review
 * @param {object} params - optional: limit, batch_id, model
 */
export function fetchNeedsReview(params = {}) {
    const qs = new URLSearchParams(params).toString();
    return apiFetch(`${BASE}/results/needs-review?${qs}`);
}

/** GET /api/benchmark/judge-leaderboard */
export const fetchJudgeLeaderboard = () => apiFetch(`${BASE}/judge-leaderboard`);

/** GET /api/benchmark/prompts */
export const fetchPrompts = () => apiFetch(`${BASE}/prompts`);

/** GET /api/benchmark/config */
export const fetchConfig = () => apiFetch(`${BASE}/config`);

/** GET /api/benchmark/dashboard */
export const fetchDashboard = () => apiFetch(`${BASE}/dashboard`);

/**
 * GET /api/benchmark/question-discrimination
 * @param {object} params - optional: batch_id, summary, flagged_only
 */
export function fetchDiscrimination(params = {}) {
    const qs = new URLSearchParams(params).toString();
    return apiFetch(`${BASE}/question-discrimination?${qs}`);
}

/**
 * GET /api/benchmark/quality-breakdown?model=X&host=Y
 */
export function fetchQualityBreakdown(model, host) {
    const qs = new URLSearchParams({ model, ...(host ? { host } : {}) }).toString();
    return apiFetch(`${BASE}/quality-breakdown?${qs}`);
}

/**
 * GET /api/benchmark/trends?model=X&days=7
 */
export const fetchTrends = (model, days = 7) =>
    apiFetch(`${BASE}/trends?${new URLSearchParams({ model, days })}`);

/** GET /api/benchmark/judge-calibration */
export const fetchJudgeCalibration = () => apiFetch(`${BASE}/judge-calibration`);

/**
 * GET /api/benchmark/dimension-breakdown?model=X
 */
export const fetchDimensionBreakdown = (model) =>
    apiFetch(`${BASE}/dimension-breakdown?${new URLSearchParams({ model })}`);

/** GET /api/benchmark/truncation-stats */
export const fetchTruncationStats = () => apiFetch(`${BASE}/truncation-stats`);

/** GET /api/benchmark/host-names */
export const fetchHostNames = () => apiFetch(`${BASE}/host-names`);

export async function fetchFastHostList() {
    const names = await fetchHostNames();
    const map = names?.data || names || {};
    return Object.entries(map).map(([url, name]) => ({
        url,
        name: name || url
    }));
}

/**
 * Fetch other results for the same prompt (cross-model comparison).
 */
export function fetchSamePromptResults(promptName, limit = 20) {
    const qs = new URLSearchParams({ prompt_name: promptName, limit }).toString();
    return apiFetch(`${BASE}/results/advanced?${qs}`);
}

/**
 * Promote a result's score as ground truth for judge calibration.
 * POST /api/benchmark/results/:id/promote-ground-truth
 */
export const promoteGroundTruth = (resultId, expert_score, expert_rationale) =>
    apiFetch(`${BASE}/results/${encodeURIComponent(resultId)}/promote-ground-truth`, {
        method: 'POST', body: { expert_score, expert_rationale },
    });

/**
 * Submit a human review action for a result.
 * action: 'approve' | 'override' | 'rejudge' | 'reject'
 */
export function submitReview(resultId, action, data = {}) {
    const id = encodeURIComponent(resultId);
    if (action === 'rejudge') {
        return apiFetch(`${BASE}/results/${id}/rejudge`, { method: 'POST', body: data });
    }
    return apiFetch(`${BASE}/results/${id}/human-review`, {
        method: 'POST',
        body: { action, ...data }
    });
}
