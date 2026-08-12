/**
 * Question Discrimination Tracker
 *
 * Computes per-question YES rates from decomposed judging results.
 * Questions with >85% YES rate contribute noise, not signal.
 * Questions with <15% YES rate may be too strict or poorly worded.
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

    // Accumulate per-question stats: { "category:dimension:questionText" → { yes, no, error, total } }
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
                    // contributed=true means the question helped the score
                    // For normal questions: contributed=true means YES
                    // For inverted questions: contributed=true means NO (inverted YES)
                    if (q.inverted) {
                        if (q.contributed) stat.no++;  // inverted + contributed = answer was NO
                        else stat.yes++;               // inverted + not contributed = answer was YES
                    } else {
                        if (q.contributed) stat.yes++;
                        else stat.no++;
                    }
                } else if (q.answer === true) {
                    stat.yes++;
                } else if (q.answer === false) {
                    stat.no++;
                } else {
                    stat.error++;
                }
            }
        }
    }

    // Convert to array and compute rates
    const questions = Object.values(questionStats).map(stat => {
        const validTotal = stat.yes + stat.no;
        const passRate = validTotal > 0 ? stat.yes / validTotal : null;

        return {
            category: stat.category,
            dimension: stat.dimension,
            question: stat.question,
            weight: stat.weight,
            inverted: stat.inverted,
            yes: stat.yes,
            no: stat.no,
            error: stat.error,
            total: stat.total,
            model_count: stat.models.size,
            pass_rate: passRate !== null ? Math.round(passRate * 1000) / 1000 : null,
            discriminative: passRate !== null
                ? (passRate <= HIGH_PASS_THRESHOLD && passRate >= LOW_PASS_THRESHOLD)
                : null,
            flag: passRate !== null
                ? (passRate > HIGH_PASS_THRESHOLD ? 'too_easy' : (passRate < LOW_PASS_THRESHOLD ? 'too_hard' : null))
                : 'no_data'
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
            thresholds: { high: HIGH_PASS_THRESHOLD, low: LOW_PASS_THRESHOLD }
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
    LOW_PASS_THRESHOLD
};
