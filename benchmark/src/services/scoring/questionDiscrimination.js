/**
 * Question Discrimination Tracker
 *
 * Computes per-question effective pass rates from decomposed judging results.
 * Raw YES rates are retained separately so inverted questions stay auditable.
 * Questions with >85% pass rate contribute little ranking signal.
 * Questions with <15% pass rate may be too strict or poorly worded.
 *
 * USED BY: routes/benchmark/judges.js (GET /question-discrimination)
 */

'use strict';

const logger = require('../../../config/logger');
const BenchmarkResult = require('../../../models/BenchmarkResult');

/** Questions passing more than this rate are likely non-discriminative */
const HIGH_PASS_THRESHOLD = 0.85;
/** Questions passing less than this rate may be too strict */
const LOW_PASS_THRESHOLD = 0.15;
/** Extremes below these evidence floors are observations, not discrimination findings. */
const MIN_SAMPLE_SIZE = 5;
const MIN_MODEL_COUNT = 2;

/**
 * Compute per-question YES rates from decomposed results.
 *
 * @param {Object} [filter] - Optional MongoDB filter (e.g., { batch_id })
 * @returns {Object} { questions: [...], flagged: [...], stats }
 */
async function computeDiscriminationStats(filter = {}) {
    const baseFilter = {
        scoring_method: 'decomposed',
        decomposed_breakdown: { $ne: null },
        ...filter
    };

    const results = await BenchmarkResult.find(baseFilter)
        .select('scoring_type decomposed_breakdown model')
        .lean();

    if (results.length === 0) {
        return { questions: [], flagged: [], stats: { totalResults: 0, totalQuestions: 0 } };
    }

    // Accumulate both the raw YES/NO answer and the effective scoring outcome.
    // These differ for inverted questions: answering NO to "Are there
    // contradictions?" is a pass even though its raw YES rate is zero.
    const questionStats = {};

    for (const result of results) {
        const category = result.scoring_type || 'unknown';
        const breakdown = result.decomposed_breakdown;

        if (!breakdown || typeof breakdown !== 'object') continue;

        for (const [dimension, questions] of Object.entries(breakdown)) {
            if (!Array.isArray(questions)) continue;

            for (const q of questions) {
                if (!q.question) continue;

                const key = `${category}:${dimension}:${q.question}`;

                if (!questionStats[key]) {
                    questionStats[key] = {
                        category,
                        dimension,
                        question: q.question,
                        weight: q.weight || 0,
                        inverted: q.inverted || false,
                        yes: 0,
                        no: 0,
                        passed: 0,
                        failed: 0,
                        error: 0,
                        total: 0,
                        models: new Set()
                    };
                }

                const stat = questionStats[key];
                stat.total++;
                stat.models.add(result.model || 'unknown');

                if (q.error) {
                    stat.error++;
                } else if (q.contributed !== undefined) {
                    const contributed = q.contributed === true;
                    if (contributed) stat.passed++;
                    else stat.failed++;

                    // New rows persist the raw answer. Reconstruct it for old
                    // rows that only retained `contributed`.
                    const rawAnswer = typeof q.answer === 'boolean'
                        ? q.answer
                        : (q.inverted ? !contributed : contributed);
                    if (rawAnswer) stat.yes++;
                    else stat.no++;
                } else if (q.answer === true) {
                    stat.yes++;
                    if (q.inverted) stat.failed++;
                    else stat.passed++;
                } else if (q.answer === false) {
                    stat.no++;
                    if (q.inverted) stat.passed++;
                    else stat.failed++;
                } else {
                    stat.error++;
                }
            }
        }
    }

    // Convert to array and compute rates
    const questions = Object.values(questionStats).map(stat => {
        const validTotal = stat.passed + stat.failed;
        const rawAnswerTotal = stat.yes + stat.no;
        const passRate = validTotal > 0 ? stat.passed / validTotal : null;
        const rawYesRate = rawAnswerTotal > 0 ? stat.yes / rawAnswerTotal : null;
        const sampleSufficient = validTotal >= MIN_SAMPLE_SIZE
            && stat.models.size >= MIN_MODEL_COUNT;
        const flag = passRate === null
            ? 'no_data'
            : !sampleSufficient
                ? 'insufficient_data'
                : passRate > HIGH_PASS_THRESHOLD
                    ? 'too_easy'
                    : passRate < LOW_PASS_THRESHOLD
                        ? 'too_hard'
                        : null;

        return {
            category: stat.category,
            dimension: stat.dimension,
            question: stat.question,
            weight: stat.weight,
            inverted: stat.inverted,
            yes: stat.yes,
            no: stat.no,
            passed: stat.passed,
            failed: stat.failed,
            error: stat.error,
            total: stat.total,
            model_count: stat.models.size,
            sample_sufficient: sampleSufficient,
            pass_rate: passRate !== null ? Math.round(passRate * 1000) / 1000 : null,
            raw_yes_rate: rawYesRate !== null ? Math.round(rawYesRate * 1000) / 1000 : null,
            discriminative: sampleSufficient
                ? (passRate <= HIGH_PASS_THRESHOLD && passRate >= LOW_PASS_THRESHOLD)
                : null,
            flag
        };
    });

    // Sort by pass rate descending (easiest first)
    questions.sort((a, b) => (b.pass_rate ?? -1) - (a.pass_rate ?? -1));

    const flagged = questions.filter(q => q.flag && q.flag !== 'no_data');

    logger.info('Question discrimination stats computed', {
        totalResults: results.length,
        totalQuestions: questions.length,
        flaggedCount: flagged.length,
        tooEasy: flagged.filter(q => q.flag === 'too_easy').length,
        tooHard: flagged.filter(q => q.flag === 'too_hard').length
    });

    return {
        questions,
        flagged,
        stats: {
            totalResults: results.length,
            totalQuestions: questions.length,
            flaggedCount: flagged.length,
            thresholds: {
                high: HIGH_PASS_THRESHOLD,
                low: LOW_PASS_THRESHOLD,
                minSampleSize: MIN_SAMPLE_SIZE,
                minModelCount: MIN_MODEL_COUNT
            }
        }
    };
}

/**
 * Get a summary grouped by category and dimension.
 *
 * @param {Object} [filter] - Optional MongoDB filter
 * @returns {Object} { categories: { [cat]: { [dim]: { avg_pass_rate, flagged_count, questions } } } }
 */
async function getDiscriminationSummary(filter = {}) {
    const { questions, stats } = await computeDiscriminationStats(filter);

    const categories = {};

    for (const q of questions) {
        if (!categories[q.category]) categories[q.category] = {};
        if (!categories[q.category][q.dimension]) {
            categories[q.category][q.dimension] = { questions: [], flagged_count: 0, total_pass_rate: 0 };
        }

        const dim = categories[q.category][q.dimension];
        dim.questions.push(q);
        if (q.flag && q.flag !== 'no_data') dim.flagged_count++;
        if (q.pass_rate !== null) dim.total_pass_rate += q.pass_rate;
    }

    // Compute averages
    for (const cat of Object.values(categories)) {
        for (const dim of Object.values(cat)) {
            const validQuestions = dim.questions.filter(q => q.pass_rate !== null);
            dim.avg_pass_rate = validQuestions.length > 0
                ? Math.round((dim.total_pass_rate / validQuestions.length) * 1000) / 1000
                : null;
            delete dim.total_pass_rate;
        }
    }

    return { categories, stats };
}

module.exports = {
    computeDiscriminationStats,
    getDiscriminationSummary,
    HIGH_PASS_THRESHOLD,
    LOW_PASS_THRESHOLD,
    MIN_SAMPLE_SIZE,
    MIN_MODEL_COUNT
};
