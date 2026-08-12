#!/usr/bin/env node

/**
 * Fit and audit the category-aware judge-confidence model.
 *
 * Source of truth is the human calibration sprint in Mongo:
 *   judgegroundtruths with judge_score_at_review != null
 *
 * The script is read-only. It joins each ground-truth row to its original
 * benchmarkresult through source_result_id, derives confidence features from
 * the persisted breakdowns, and prints per-category target profiles plus the
 * active model's before/after effect on the corpus.
 *
 * Usage:
 *   node scripts/fit-judge-confidence.js
 *   node scripts/fit-judge-confidence.js --json
 *   node scripts/fit-judge-confidence.js --include-retro
 *   node scripts/fit-judge-confidence.js --apply-corpus
 */

require('dotenv').config({ path: __dirname + '/../.env' });

const mongoose = require('mongoose');
const {
    assess,
    extractConfidenceFeatures,
    CATEGORY_CALIBRATION_PROFILES
} = require('../src/services/judgeConfidence');
const { calculatePearsonCorrelation } = require('../src/services/judgeValidationHelpers');
const { normalizeBenchmarkCategory } = require('../config/categories');

const MONGO_URI = process.env.MONGODB_URI
    || process.env.MONGO_URL
    || 'mongodb://mongo:27017/agentx';

const LLM_SCORING_METHODS = ['decomposed', 'llm_judge', 'reference', 'reference_quick'];

function parseArgs(argv) {
    const flags = new Set();
    const values = {};
    for (const arg of argv.slice(2)) {
        const match = arg.match(/^--([^=]+)(?:=(.*))?$/);
        if (!match) continue;
        if (match[2] === undefined) flags.add(match[1]);
        else values[match[1]] = match[2];
    }
    return { flags, values };
}

function clamp01(value) {
    return Math.max(0, Math.min(1, value));
}

function round(value, digits = 3) {
    if (value === null || value === undefined || !Number.isFinite(Number(value))) return null;
    const factor = 10 ** digits;
    return Math.round(Number(value) * factor) / factor;
}

function mean(values) {
    const nums = values.filter(v => Number.isFinite(v));
    if (nums.length === 0) return null;
    return nums.reduce((sum, value) => sum + value, 0) / nums.length;
}

function weightedMean(rows, selector, weightSelector) {
    let sum = 0;
    let weightSum = 0;
    for (const row of rows) {
        const value = selector(row);
        if (!Number.isFinite(value)) continue;
        const weight = Math.max(0.05, Number(weightSelector(row)) || 0);
        sum += value * weight;
        weightSum += weight;
    }
    return weightSum > 0 ? sum / weightSum : null;
}

function max(values) {
    const nums = values.filter(v => Number.isFinite(v));
    return nums.length > 0 ? Math.max(...nums) : null;
}

function getHumanMatchQuery({ includeRetro }) {
    const query = {
        active: { $ne: false },
        judge_score_at_review: { $ne: null }
    };

    if (!includeRetro) {
        query.created_by = { $ne: 'retro-calibration' };
        query.$or = [
            { source: 'courthouse-review' },
            { source: /^human-validation-sprint/ }
        ];
    }

    return query;
}

async function fetchSprintPairs({ includeRetro = false } = {}) {
    const db = mongoose.connection.db;
    const match = getHumanMatchQuery({ includeRetro });

    const docs = await db.collection('judgegroundtruths').aggregate([
        { $match: match },
        {
            $lookup: {
                from: 'benchmarkresults',
                localField: 'source_result_id',
                foreignField: '_id',
                as: 'result'
            }
        },
        { $unwind: { path: '$result', preserveNullAndEmptyArrays: true } },
        {
            $project: {
                name: 1,
                category: 1,
                difficulty: 1,
                source: 1,
                created_by: 1,
                human: '$expert_scores.overall',
                judge: '$judge_score_at_review',
                source_result_id: 1,
                result: {
                    _id: '$result._id',
                    prompt_category: '$result.prompt_category',
                    prompt_level: '$result.prompt_level',
                    quality_score: '$result.quality_score',
                    quality_breakdown: '$result.quality_breakdown',
                    decomposed_breakdown: '$result.decomposed_breakdown',
                    quality_explanation: '$result.quality_explanation',
                    scoring_method: '$result.scoring_method',
                    scoring_type: '$result.scoring_type',
                    judge_confidence: '$result.judge_confidence',
                    needs_review: '$result.needs_review',
                    review_reason: '$result.review_reason',
                    truncation: '$result.truncation',
                    judge_reliable: '$result.judge_reliable',
                    judge_errors: '$result.judge_errors',
                    failed_dimensions: '$result.failed_dimensions'
                }
            }
        }
    ]).toArray();

    const skipped = [];
    const pairs = [];

    for (const doc of docs) {
        const category = normalizeBenchmarkCategory(doc.category, null);
        const hasResult = !!doc.result?._id;
        if (!category || !hasResult || !Number.isFinite(doc.human) || !Number.isFinite(doc.judge)) {
            skipped.push({
                name: doc.name,
                category: doc.category,
                reason: !hasResult ? 'missing source benchmarkresult' : 'missing numeric category/human/judge'
            });
            continue;
        }

        const scoreResult = buildScoreResult(doc);
        const prompt = buildPromptContext(doc);
        const features = extractConfidenceFeatures(scoreResult, prompt);
        const fitted = assess(scoreResult, prompt);
        const ideal = clamp01(1 - (Math.abs(doc.judge - doc.human) / 10));

        pairs.push({
            name: doc.name,
            category,
            level: prompt.level,
            human: doc.human,
            judge: doc.judge,
            ideal,
            persistedConfidence: Number.isFinite(doc.result.judge_confidence)
                ? doc.result.judge_confidence
                : null,
            persistedNeedsReview: doc.result.needs_review === true,
            fittedConfidence: fitted.judge_confidence,
            fittedNeedsReview: fitted.needs_review,
            reviewReason: fitted.review_reason,
            features
        });
    }

    return { matchedCount: docs.length, pairs, skipped };
}

function buildScoreResult(doc) {
    const result = doc.result || {};
    return {
        quality_score: Number.isFinite(doc.judge) ? doc.judge : result.quality_score,
        decomposed_breakdown: result.decomposed_breakdown || null,
        breakdown: result.quality_breakdown || null,
        explanation: result.quality_explanation || '',
        scoring_method: result.scoring_method || null,
        scoring_type: result.scoring_type || result.prompt_category || doc.category,
        prompt_category: result.prompt_category || doc.category,
        truncation: result.truncation || null,
        judge_reliable: result.judge_reliable,
        judge_errors: result.judge_errors,
        failed_dimensions: result.failed_dimensions
    };
}

function buildPromptContext(doc) {
    const result = doc.result || {};
    return {
        level: result.prompt_level || doc.difficulty || 5,
        category: result.prompt_category || doc.category,
        scoring_type: result.scoring_type || result.prompt_category || doc.category
    };
}

function groupByCategory(rows) {
    const groups = new Map();
    for (const row of rows) {
        if (!groups.has(row.category)) groups.set(row.category, []);
        groups.get(row.category).push(row);
    }
    return [...groups.entries()].sort(([a], [b]) => a.localeCompare(b));
}

function summarizeCategory(category, rows) {
    const judgeScores = rows.map(row => row.judge);
    const humanScores = rows.map(row => row.human);
    const deviations = rows.map(row => Math.abs(row.judge - row.human));
    const highIdealRows = rows.filter(row => row.ideal >= 0.9);
    const spreadSource = highIdealRows.length >= 2 ? highIdealRows : rows;
    const activeProfile = CATEGORY_CALIBRATION_PROFILES[category]?.targets || null;

    return {
        category,
        sample_size: rows.length,
        rho: rows.length >= 2 ? round(calculatePearsonCorrelation(judgeScores, humanScores), 3) : null,
        mae: round(mean(deviations), 2),
        bias: round(mean(rows.map(row => row.judge - row.human)), 2),
        avg_ideal_confidence: round(mean(rows.map(row => row.ideal)), 3),
        persisted_avg_confidence: round(mean(rows.map(row => row.persistedConfidence)), 3),
        fitted_avg_confidence: round(mean(rows.map(row => row.fittedConfidence)), 3),
        persisted_review_rate: round(mean(rows.map(row => row.persistedNeedsReview ? 1 : 0)), 3),
        fitted_review_rate: round(mean(rows.map(row => row.fittedNeedsReview ? 1 : 0)), 3),
        fitted_targets: {
            passRate: round(weightedMean(rows, row => row.features.passRate, row => row.ideal), 2),
            variance: round(weightedMean(rows, row => row.features.variance, row => row.ideal), 2),
            maxDeviation: round(max(spreadSource.map(row => row.features.maxDeviation)), 2),
            outlierIssueThreshold: round(Math.max(
                0.4,
                (max(spreadSource.map(row => row.features.maxDeviation)) || 0) + 0.12
            ), 2)
        },
        active_targets: activeProfile
            ? {
                passRate: activeProfile.passRate,
                variance: activeProfile.variance,
                maxDeviation: activeProfile.maxDeviation,
                outlierIssueThreshold: activeProfile.outlierIssueThreshold
            }
            : null
    };
}

async function fetchCorpusRows(limit = null) {
    const db = mongoose.connection.db;
    const cursor = db.collection('benchmarkresults').find(
        {
            success: true,
            quality_score: { $ne: null },
            judge_confidence: { $ne: null },
            scoring_method: { $in: LLM_SCORING_METHODS },
            excluded_from_leaderboard: { $ne: true }
        },
        {
            projection: {
                prompt_category: 1,
                prompt_level: 1,
                scoring_type: 1,
                scoring_method: 1,
                quality_score: 1,
                quality_breakdown: 1,
                decomposed_breakdown: 1,
                quality_explanation: 1,
                judge_confidence: 1,
                needs_review: 1,
                truncation: 1,
                judge_reliable: 1,
                judge_errors: 1,
                failed_dimensions: 1,
                format_gated: 1,
                review_reason: 1,
                human_review_status: 1
            }
        }
    );

    if (limit) cursor.limit(limit);
    return cursor.toArray();
}

function summarizeCorpus(rows) {
    const byCategory = new Map();

    for (const row of rows) {
        const category = normalizeBenchmarkCategory(row.prompt_category || row.scoring_type, 'unknown');
        const doc = {
            category,
            difficulty: row.prompt_level,
            judge: row.quality_score,
            result: row
        };
        const fitted = assess(buildScoreResult(doc), buildPromptContext(doc));
        if (!byCategory.has(category)) byCategory.set(category, []);
        byCategory.get(category).push({
            oldConfidence: row.judge_confidence,
            newConfidence: fitted.judge_confidence,
            oldNeedsReview: row.needs_review === true,
            newNeedsReview: fitted.needs_review
        });
    }

    return [...byCategory.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([category, values]) => ({
            category,
            sample_size: values.length,
            old_avg_confidence: round(mean(values.map(v => v.oldConfidence)), 3),
            new_avg_confidence: round(mean(values.map(v => v.newConfidence)), 3),
            old_review_rate: round(mean(values.map(v => v.oldNeedsReview ? 1 : 0)), 3),
            new_review_rate: round(mean(values.map(v => v.newNeedsReview ? 1 : 0)), 3)
        }));
}

function mergeReasons(...reasons) {
    const parts = [];
    for (const reason of reasons) {
        if (!reason || typeof reason !== 'string') continue;
        for (const part of reason.split(';')) {
            const trimmed = part.trim();
            if (trimmed && !parts.includes(trimmed)) parts.push(trimmed);
        }
    }
    return parts.length > 0 ? parts.join('; ') : null;
}

function buildCorpusUpdate(row) {
    if (row.human_review_status) {
        return null;
    }

    const category = normalizeBenchmarkCategory(row.prompt_category || row.scoring_type, 'unknown');
    const doc = {
        category,
        difficulty: row.prompt_level,
        judge: row.quality_score,
        result: row
    };
    const fitted = assess(buildScoreResult(doc), buildPromptContext(doc));
    let judgeConfidence = fitted.judge_confidence;
    let needsReview = fitted.needs_review;
    let reviewReason = fitted.review_reason;

    if (row.format_gated === true) {
        judgeConfidence = typeof judgeConfidence === 'number'
            ? Math.min(judgeConfidence, 0.5)
            : 0.5;
        needsReview = true;
        reviewReason = mergeReasons(row.review_reason, 'format-gated row retained for review');
    }

    const currentConfidence = Number.isFinite(row.judge_confidence)
        ? Math.round(row.judge_confidence * 100) / 100
        : null;
    const currentReason = row.review_reason || null;
    if (
        currentConfidence === judgeConfidence
        && row.needs_review === needsReview
        && currentReason === (reviewReason || null)
    ) {
        return null;
    }

    return {
        _id: row._id,
        update: {
            judge_confidence: judgeConfidence,
            needs_review: needsReview,
            review_reason: reviewReason || null,
            prompt_complexity: fitted.prompt_complexity
        }
    };
}

async function applyCorpusRefit(rows) {
    const db = mongoose.connection.db;
    const updates = rows
        .map(buildCorpusUpdate)
        .filter(Boolean);

    if (updates.length === 0) {
        return { scanned: rows.length, updated: 0, skippedReviewed: rows.filter(row => row.human_review_status).length };
    }

    const ops = updates.map(({ _id, update }) => ({
        updateOne: {
            filter: { _id },
            update: {
                $set: {
                    ...update,
                    updated_at: new Date()
                }
            }
        }
    }));
    const result = await db.collection('benchmarkresults').bulkWrite(ops, { ordered: false });
    return {
        scanned: rows.length,
        updated: result.modifiedCount || 0,
        matched: result.matchedCount || 0,
        skippedReviewed: rows.filter(row => row.human_review_status).length
    };
}

function printTable(summary, corpusSummary, meta) {
    console.log('=== judge confidence category refit ===');
    console.log(`Mongo: ${MONGO_URI.replace(/\/\/.*@/, '//<redacted>@')}`);
    console.log(`Ground-truth rows matched: ${meta.matchedCount}`);
    console.log(`Usable source-result pairs: ${meta.pairsCount}`);
    console.log(`Skipped pairs: ${meta.skippedCount}`);
    if (meta.skippedCount > 0) {
        for (const skipped of meta.skipped.slice(0, 8)) {
            console.log(`  skipped ${skipped.name || '(unnamed)'}: ${skipped.reason}`);
        }
    }

    console.log('\ncategory     | n  | rho    | mae  | old conf | new conf | old review | new review');
    console.log('-------------|----|--------|------|----------|----------|------------|-----------');
    for (const row of summary) {
        console.log([
            row.category.padEnd(13),
            String(row.sample_size).padStart(2),
            String(row.rho ?? 'null').padStart(6),
            String(row.mae ?? 'null').padStart(4),
            String(row.persisted_avg_confidence ?? 'null').padStart(8),
            String(row.fitted_avg_confidence ?? 'null').padStart(8),
            String(row.persisted_review_rate ?? 'null').padStart(10),
            String(row.fitted_review_rate ?? 'null').padStart(9)
        ].join(' | '));
    }

    console.log('\nrecommended fitted targets from sprint pairs:');
    for (const row of summary) {
        console.log(`  ${row.category}: ${JSON.stringify(row.fitted_targets)}`);
    }

    console.log('\nactive targets in judgeConfidence.js:');
    for (const row of summary) {
        console.log(`  ${row.category}: ${JSON.stringify(row.active_targets)}`);
    }

    console.log('\n=== current corpus projection with active model ===');
    console.log('category     | n    | old conf | new conf | old review | new review');
    console.log('-------------|------|----------|----------|------------|-----------');
    for (const row of corpusSummary) {
        console.log([
            row.category.padEnd(13),
            String(row.sample_size).padStart(4),
            String(row.old_avg_confidence ?? 'null').padStart(8),
            String(row.new_avg_confidence ?? 'null').padStart(8),
            String(row.old_review_rate ?? 'null').padStart(10),
            String(row.new_review_rate ?? 'null').padStart(9)
        ].join(' | '));
    }
}

async function main() {
    const { flags, values } = parseArgs(process.argv);
    const includeRetro = flags.has('include-retro');
    const corpusLimit = values['corpus-limit'] ? Number(values['corpus-limit']) : null;

    await mongoose.connect(MONGO_URI, { serverSelectionTimeoutMS: 8000 });

    const { matchedCount, pairs, skipped } = await fetchSprintPairs({ includeRetro });
    const summary = groupByCategory(pairs).map(([category, rows]) => summarizeCategory(category, rows));
    const corpusRows = await fetchCorpusRows(Number.isFinite(corpusLimit) ? corpusLimit : null);
    const corpusSummary = summarizeCorpus(corpusRows);
    const applyResult = flags.has('apply-corpus') ? await applyCorpusRefit(corpusRows) : null;

    const payload = {
        source: includeRetro ? 'all judge_score_at_review rows' : 'human judge_score_at_review rows',
        matched_count: matchedCount,
        usable_pairs: pairs.length,
        skipped,
        categories: summary,
        corpus_projection: corpusSummary,
        apply_result: applyResult
    };

    if (flags.has('json')) {
        console.log(JSON.stringify(payload, null, 2));
    } else {
        printTable(summary, corpusSummary, {
            matchedCount,
            pairsCount: pairs.length,
            skippedCount: skipped.length,
            skipped
        });
        if (applyResult) {
            console.log('\n=== corpus apply ===');
            console.log(JSON.stringify(applyResult, null, 2));
        }
    }

    await mongoose.disconnect();
}

main().catch(err => {
    console.error('fit-judge-confidence failed:', err);
    process.exit(1);
});
