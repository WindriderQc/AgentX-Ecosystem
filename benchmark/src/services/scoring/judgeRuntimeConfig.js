'use strict';

function normalizeJudgeNumCtx(value, fallback = 8192) {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) return fallback;
    return Math.max(512, Math.min(131072, Math.round(parsed)));
}

module.exports = { normalizeJudgeNumCtx };
