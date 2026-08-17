'use strict';

function normalizeJudgeNumCtx(value, fallback = null) {
    if (value === null || value === undefined || value === '') return fallback;
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) return fallback;
    return Math.max(512, Math.round(parsed));
}

module.exports = { normalizeJudgeNumCtx };
