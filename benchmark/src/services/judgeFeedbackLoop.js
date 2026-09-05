/**
 * Judge Feedback Loop
 *
 * Aggregates human reviews vs judge scores to identify calibration drift.
 * Auto-promotes high-divergence reviewed results to ground truth.
 */

const BenchmarkResult = require('../../models/BenchmarkResult');
const JudgeGroundTruth = require('../../models/JudgeGroundTruth');
const logger = require('../../config/logger');
const { buildStrictTrustResultExclusion } = require('./benchmark/publicReadPrivacy');

const DIVERGENCE_THRESHOLD = 2.0;

/**
 * Compute per-category accuracy stats from human-reviewed results.
 * @returns {{ byCategory: Record<string, object>, overall: object }}
 */
async function getJudgeFeedbackStats() {
    const reviewed = await BenchmarkResult.find({
        human_score: { $ne: null },
        quality_score: { $ne: null },
        excluded_from_leaderboard: { $ne: true },
        ...buildStrictTrustResultExclusion()
    }).select('category prompt_category quality_score judge_quality_score human_score judge_model').lean();

    if (!reviewed.length) return { byCategory: {}, overall: { count: 0 } };

    const cats = {};
    let totalDev = 0;
    let totalCount = 0;
    let overrides = 0;

    for (const r of reviewed) {
        const cat = r.prompt_category || r.category || 'unknown';
        if (!cats[cat]) cats[cat] = { count: 0, totalDev: 0, maxDev: 0, harshCount: 0, lenientCount: 0 };
        // judge_quality_score holds the judge's original score on overridden
        // rows (where quality_score has been replaced by human_score). Falls
        // back to quality_score for approved rows and for legacy rows that
        // pre-date the override→effective-score change.
        const judgeScore = r.judge_quality_score ?? r.quality_score;
        const dev = judgeScore - r.human_score;
        const absDev = Math.abs(dev);
        cats[cat].count++;
        cats[cat].totalDev += absDev;
        if (absDev > cats[cat].maxDev) cats[cat].maxDev = absDev;
        if (dev > 0.5) cats[cat].lenientCount++;   // judge scored higher than human
        if (dev < -0.5) cats[cat].harshCount++;     // judge scored lower than human
        totalDev += absDev;
        totalCount++;
        if (absDev >= DIVERGENCE_THRESHOLD) overrides++;
    }

    const byCategory = {};
    for (const [cat, s] of Object.entries(cats)) {
        byCategory[cat] = {
            count: s.count,
            avgDeviation: +(s.totalDev / s.count).toFixed(2),
            maxDeviation: +s.maxDev.toFixed(2),
            harshRate: +(s.harshCount / s.count).toFixed(2),
            lenientRate: +(s.lenientCount / s.count).toFixed(2)
        };
    }

    return {
        byCategory,
        overall: {
            count: totalCount,
            avgDeviation: +(totalDev / totalCount).toFixed(2),
            highDivergenceCount: overrides,
            highDivergenceRate: +(overrides / totalCount).toFixed(2)
        }
    };
}

/**
 * Promote human-reviewed results with high divergence to ground truth.
 * Only promotes results that don't already have a ground truth entry.
 *
 * @returns {{ promoted: number, skipped: number }}
 */
async function autoPromoteGroundTruth() {
    const candidates = await BenchmarkResult.find({
        human_score: { $ne: null },
        quality_score: { $ne: null },
        prompt: { $ne: null },
        response: { $ne: null },
        excluded_from_leaderboard: { $ne: true },
        ...buildStrictTrustResultExclusion()
    }).select('prompt_name prompt response category prompt_category quality_score judge_quality_score human_score human_notes model').lean();

    // Pre-fetch existing ground truth names to avoid N+1 queries
    const candidateNames = candidates
        .filter(r => Math.abs((r.judge_quality_score ?? r.quality_score) - r.human_score) >= DIVERGENCE_THRESHOLD)
        .map(r => `auto_${r.prompt_name || 'unknown'}_${r.model || 'unknown'}_${r._id}`);
    const existingGT = candidateNames.length > 0
        ? await JudgeGroundTruth.find({ name: { $in: candidateNames } }).select('name').lean()
        : [];
    const existingNames = new Set(existingGT.map(g => g.name));

    let promoted = 0;
    let skipped = 0;

    for (const r of candidates) {
        const judgeScore = r.judge_quality_score ?? r.quality_score;
        const dev = Math.abs(judgeScore - r.human_score);
        if (dev < DIVERGENCE_THRESHOLD) { skipped++; continue; }

        const name = `auto_${r.prompt_name || 'unknown'}_${r.model || 'unknown'}_${r._id}`;
        if (existingNames.has(name)) { skipped++; continue; }

        try {
            await JudgeGroundTruth.create({
                name,
                prompt: typeof r.prompt === 'object' ? JSON.stringify(r.prompt) : String(r.prompt),
                response: String(r.response).slice(0, 50000),
                category: r.prompt_category || r.category || 'knowledge',
                expert_scores: { overall: r.human_score, dimensions: {} },
                expert_rationale: r.human_notes || `Auto-promoted: judge=${judgeScore}, human=${r.human_score} (Δ${dev.toFixed(1)})`,
                created_by: 'auto-feedback-loop',
                tags: ['auto-promoted']
            });
            promoted++;
        } catch (err) {
            logger.debug('Auto-promote failed', { name, error: err.message });
            skipped++;
        }
    }

    logger.info('Auto-promote ground truth complete', { promoted, skipped });
    return { promoted, skipped };
}

module.exports = { getJudgeFeedbackStats, autoPromoteGroundTruth, DIVERGENCE_THRESHOLD };
