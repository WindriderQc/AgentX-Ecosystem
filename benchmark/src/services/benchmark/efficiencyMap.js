/**
 * Efficiency Map — Scoring and Pareto frontier logic
 *
 * Computes a composite efficiency score (harmonic mean of quality and speed)
 * and identifies the Pareto-optimal frontier across model/host combinations.
 */

const BenchmarkResult = require('../../../models/BenchmarkResult');
const logger = require('../../../config/logger');

const QUALITY_FLOOR = 3.0;
const SPEED_CAP = 100;
const MIN_TEST_COUNT = 5;
const MAX_FINITE_NUMBER = Number.MAX_VALUE;

function isFinitePositive(value) {
    return Number.isFinite(value) && value > 0;
}

function isFiniteNumber(value) {
    return Number.isFinite(value);
}

/**
 * Harmonic mean of two non-negative values.
 * Returns 0 if either input is 0 or negative.
 */
function harmonicMean(a, b) {
    if (a <= 0 || b <= 0) return 0;
    return (2 * a * b) / (a + b);
}

/**
 * Efficiency score: harmonic mean of normalized quality and capped speed.
 * Returns 0 for models below the quality floor.
 *
 * @param {number} avgQuality   - Average quality score (0–10)
 * @param {number} avgTokPerSec - Average tokens per second
 * @returns {number|null} Score in [0, 100], or null without valid evidence
 */
function efficiencyScore(avgQuality, avgTokPerSec) {
    if (!isFiniteNumber(avgQuality) || !isFinitePositive(avgTokPerSec)) return null;
    if (avgQuality < QUALITY_FLOOR) return 0;
    const nQ = (avgQuality / 10) * 100;
    const nS = Math.min(SPEED_CAP, avgTokPerSec);
    return harmonicMean(nQ, nS);
}

/**
 * Compute the Pareto frontier from a list of points.
 * A point is Pareto-optimal if no other point dominates it on both quality and speed.
 *
 * Algorithm: sort descending by quality; sweep and keep points that exceed the
 * highest speed seen so far (guaranteeing no previously accepted point has both
 * higher quality AND higher speed).
 *
 * @param {Array<{model, host, quality, tokPerSec}>} points
 * @returns {Array} Pareto-optimal subset, sorted descending by quality
 */
function paretoFrontier(points) {
    const eligible = points.filter(p => isFiniteNumber(p.quality) && isFinitePositive(p.tokPerSec));
    if (eligible.length === 0) return [];
    const sorted = [...eligible].sort((a, b) => b.quality - a.quality);
    const frontier = [];
    let maxSpeed = -Infinity;
    for (const p of sorted) {
        if (p.tokPerSec > maxSpeed) {
            frontier.push(p);
            maxSpeed = p.tokPerSec;
        }
    }
    return frontier;
}

/**
 * Aggregate benchmark results into an efficiency map.
 * Requires at least MIN_TEST_COUNT successful results per model/host pair.
 *
 * @returns {Promise<{entries, frontier, meta}>}
 */
async function getEfficiencyMap() {
    // Match the same row-level filters the Generalist leaderboard uses so the
    // two views agree on which results "count": skip infra failures, courthouse
    // rejects, and unscored rows. Pre-fix, infra blowups and rejected rows
    // could lift a model's avgQuality / drag avgTokPerSec.
    const baseMatch = {
        success: true,
        quality_score: { $exists: true, $gt: 0 },
        infra_error: { $ne: true },
        excluded_from_leaderboard: { $ne: true }
    };

    // Prefer a calibrated measurement only when it is finite and positive,
    // otherwise fall back to a finite positive raw measurement. $avg ignores
    // the resulting nulls, preserving unavailable throughput as unavailable
    // instead of manufacturing a zero-speed observation.
    const finitePositiveMongo = value => ({
        $and: [
            { $isNumber: value },
            { $gt: [value, 0] },
            { $lte: [value, MAX_FINITE_NUMBER] }
        ]
    });
    const calibratedTps = {
        $let: {
            vars: {
                calibrated: '$performance_baseline.tokensPerSec',
                raw: '$tokens_per_sec'
            },
            in: {
                $cond: [
                    finitePositiveMongo('$$calibrated'),
                    '$$calibrated',
                    {
                        $cond: [
                            finitePositiveMongo('$$raw'),
                            '$$raw',
                            null
                        ]
                    }
                ]
            }
        }
    };

    const raw = await BenchmarkResult.aggregate([
        { $match: baseMatch },
        {
            $group: {
                _id: { model: '$model', host: '$host' },
                avgQuality: { $avg: '$quality_score' },
                avgTokPerSec: { $avg: calibratedTps },
                throughputTestCount: {
                    $sum: { $cond: [{ $ne: [calibratedTps, null] }, 1, 0] }
                },
                avgTtft: { $avg: '$time_to_first_token_ms' },
                avgLatency: { $avg: '$latency' },
                testCount: { $sum: 1 },
                categories: { $addToSet: '$prompt_category' }
            }
        },
        { $match: { testCount: { $gte: MIN_TEST_COUNT } } },
        { $sort: { avgQuality: -1 } }
    ]);

    const categoryAggs = await BenchmarkResult.aggregate([
        { $match: baseMatch },
        {
            $group: {
                _id: { model: '$model', host: '$host', category: '$prompt_category' },
                avg: { $avg: '$quality_score' }
            }
        }
    ]);

    const catLookup = new Map();
    for (const row of categoryAggs) {
        const key = `${row._id.model}@@${row._id.host}`;
        if (!catLookup.has(key)) catLookup.set(key, {});
        catLookup.get(key)[row._id.category] = Math.round(row.avg * 100) / 100;
    }

    const evaluated = raw.map(row => {
        const key = `${row._id.model}@@${row._id.host}`;
        const avgQuality = isFiniteNumber(row.avgQuality)
            ? Math.round(row.avgQuality * 100) / 100
            : null;
        const avgTokPerSec = isFinitePositive(row.avgTokPerSec)
            ? Math.round(row.avgTokPerSec * 10) / 10
            : null;
        const score = efficiencyScore(avgQuality, avgTokPerSec);
        const unrankedReason = avgQuality === null
            ? 'invalid_quality'
            : (avgTokPerSec === null ? 'missing_throughput' : null);

        return {
            model: row._id.model,
            host: row._id.host,
            avgQuality,
            avgTokPerSec,
            avgTtft: Math.round(row.avgTtft || 0),
            avgLatency: Math.round(row.avgLatency || 0),
            testCount: row.testCount,
            throughputTestCount: Number.isFinite(row.throughputTestCount)
                ? row.throughputTestCount
                : (avgTokPerSec === null ? 0 : row.testCount),
            efficiencyScore: score === null ? null : Math.round(score * 100) / 100,
            categoryScores: catLookup.get(key) || {},
            rankStatus: unrankedReason ? 'unranked' : 'ranked',
            unrankedReason
        };
    });

    const entries = evaluated.filter(entry => entry.rankStatus === 'ranked');
    const unranked = evaluated
        .filter(entry => entry.rankStatus === 'unranked')
        .map(entry => ({ ...entry, paretoOptimal: false }));

    entries.sort((a, b) => b.efficiencyScore - a.efficiencyScore);

    const frontierPoints = paretoFrontier(
        entries.map(e => ({ model: e.model, host: e.host, quality: e.avgQuality, tokPerSec: e.avgTokPerSec }))
    );
    const frontierKeys = new Set(frontierPoints.map(p => `${p.model}@@${p.host}`));

    for (const e of entries) {
        e.paretoOptimal = frontierKeys.has(`${e.model}@@${e.host}`);
    }

    const unrankedReasonCounts = unranked.reduce((counts, entry) => {
        counts[entry.unrankedReason] = (counts[entry.unrankedReason] || 0) + 1;
        return counts;
    }, {});

    logger.info(
        `[efficiencyMap] Built map: ${entries.length} ranked, ${unranked.length} unranked, ` +
        `${frontierKeys.size} Pareto-optimal`
    );

    return {
        entries,
        unranked,
        frontier: [...frontierKeys],
        meta: {
            totalModels: new Set(evaluated.map(e => e.model)).size,
            totalHosts: new Set(evaluated.map(e => e.host)).size,
            totalTests: evaluated.reduce((sum, e) => sum + e.testCount, 0),
            totalCombinations: evaluated.length,
            rankedModels: new Set(entries.map(e => e.model)).size,
            rankedHosts: new Set(entries.map(e => e.host)).size,
            rankedTests: entries.reduce((sum, e) => sum + e.testCount, 0),
            throughputSamples: entries.reduce((sum, e) => sum + e.throughputTestCount, 0),
            rankedCombinations: entries.length,
            unrankedCombinations: unranked.length,
            unrankedReasonCounts,
            generatedAt: new Date().toISOString()
        }
    };
}

module.exports = {
    harmonicMean,
    efficiencyScore,
    paretoFrontier,
    getEfficiencyMap,
    QUALITY_FLOOR,
    SPEED_CAP,
    MIN_TEST_COUNT
};
