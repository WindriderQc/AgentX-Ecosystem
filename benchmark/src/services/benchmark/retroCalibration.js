/**
 * Retro-Calibration Service
 * Expands ground truth by sampling batch results across score strata,
 * re-scoring with a reference judge, and creating JudgeGroundTruth entries.
 */

const logger = require('../../../config/logger');
const mongoose = require('mongoose');
const path = require('path');
const fs = require('fs');
const BenchmarkResult = require('../../../models/BenchmarkResult');
const BenchmarkBatch = require('../../../models/BenchmarkBatch');
const JudgeGroundTruth = require('../../../models/JudgeGroundTruth');
const { scoreResponse } = require('../qualityScorer');
const { normalizeScoringCategory, DEFAULT_SCORING_CATEGORY } = require('../scoring/scoringConfigs');
const { throwIfJudgeCancelled } = require('../scoring/judgeCall');
const {
    verifyStoredAttestedHumanGroundTruth
} = require('./humanGroundTruthImport');

// 0129 calibration loop — sources that count as "human-derived ground truth"
// when unioning with the static config goldset for calibration.
const HUMAN_SOURCE_TAG = 'courthouse-review';
const SPRINT_SOURCE_PREFIX = 'human-validation-sprint-';
const QUALIFIED_HUMAN_REVIEW_LANES = Object.freeze([
    Object.freeze({
        provenance_class: 'independent_human_score',
        review_protocol: { $in: ['blind_independent', 'blind_double_review'] }
    }),
    Object.freeze({
        provenance_class: 'adjudicated_human_score',
        review_protocol: 'adjudicated'
    })
]);

const SCORE_BUCKETS = [
    { label: '0-2', min: 0, max: 2 },
    { label: '2-4', min: 2.01, max: 4 },
    { label: '4-6', min: 4.01, max: 6 },
    { label: '6-8', min: 6.01, max: 8 },
    { label: '8-10', min: 8.01, max: 10 }
];

const CATEGORIES = ['coding', 'reasoning', 'math', 'knowledge', 'instruction', 'creative', 'translation'];

/**
 * Build a stratified sample of results from a batch.
 * Samples N results per (score_bucket x category) cell.
 * @param {string} batchId - Batch ID to sample from
 * @param {number} perCell - Samples per cell (default 3)
 * @returns {Array} Sampled results
 */
async function buildStratifiedSample(batchId, perCell = 3) {
    const batchOid = new mongoose.Types.ObjectId(batchId);
    const samples = [];

    for (const category of CATEGORIES) {
        for (const bucket of SCORE_BUCKETS) {
            const results = await BenchmarkResult.aggregate([
                {
                    $match: {
                        batch_id: batchOid,
                        prompt_category: category,
                        needs_review: { $ne: true },
                        excluded_from_leaderboard: { $ne: true },
                        quality_score: { $gte: bucket.min, $lte: bucket.max },
                        scoring_method: { $nin: ['empty_response', 'skipped', 'llm_failed', 'pending'] }
                    }
                },
                { $sample: { size: perCell } }
            ]);

            for (const r of results) {
                samples.push({
                    ...r,
                    _score_bucket: bucket.label,
                    _original_score: r.quality_score
                });
            }
        }
    }

    logger.info('Stratified sample built', {
        batchId,
        perCell,
        totalSamples: samples.length,
        categories: [...new Set(samples.map(s => s.prompt_category))].length,
        buckets: [...new Set(samples.map(s => s._score_bucket))].length
    });

    return samples;
}

/**
 * Score samples with a reference judge and create ground truth entries.
 * @param {Array} samples - From buildStratifiedSample
 * @param {Object} referenceJudgeConfig - { model, host, timeout }
 * @param {Object} options - { dryRun, skipExisting }
 * @returns {Object} { created, skipped, errors, total }
 */
async function scoreAndPromote(samples, referenceJudgeConfig, options = {}) {
    const { dryRun = false, skipExisting = true } = options;
    const cancellationConfig = {
        ...referenceJudgeConfig,
        cancelSignal: options.cancelSignal || referenceJudgeConfig.cancelSignal || null
    };
    const assertAuthorityActive = options.assertAuthorityActive || null;
    let created = 0;
    let skipped = 0;
    let errors = 0;

    for (const sample of samples) {
        throwIfJudgeCancelled(cancellationConfig);
        assertAuthorityActive?.();
        const name = `retro-${sample.batch_id}-${sample._id}`;

        // Skip if ground truth already exists for this result
        if (skipExisting) {
            const existing = await JudgeGroundTruth.findOne({ name });
            if (existing) {
                skipped++;
                continue;
            }
        }

        try {
            // Score with reference judge.
            // Contract §2.3 (delta 0115 row 19): `scoring_type` is normalized
            // here so `routeScoring`'s shared `getCategoryDimensionWeights`
            // helper resolves category-aware dimension weights when the
            // decomposed path is taken. Without this, retro-calibration would
            // produce an unweighted-mean score that disagrees with the
            // original batch's category-weighted score.
            const result = await scoreResponse({
                response: sample.response,
                prompt: {
                    prompt: sample.prompt,
                    expected_answer: sample.expected_answer || '',
                    category: sample.prompt_category,
                    scoring_type: normalizeScoringCategory(sample.prompt_category, DEFAULT_SCORING_CATEGORY),
                    level: sample.prompt_level
                },
                judgeConfig: cancellationConfig
            });
            throwIfJudgeCancelled(cancellationConfig);
            assertAuthorityActive?.();

            if (result.quality_score === null) {
                logger.warn('Reference judge returned null score', {
                    name,
                    method: result.scoring_method,
                    error: result.error
                });
                errors++;
                continue;
            }

            if (dryRun) {
                logger.info('Dry run: would create ground truth', {
                    name,
                    category: sample.prompt_category,
                    original_score: sample._original_score,
                    reference_score: result.quality_score
                });
                created++;
                continue;
            }

            const id = new mongoose.Types.ObjectId();
            const payload = {
                _id: id,
                name,
                prompt: sample.prompt,
                response: sample.response,
                category: sample.prompt_category,
                expected_answer: sample.expected_answer || null,
                expert_scores: {
                    overall: result.quality_score,
                    dimensions: result.breakdown && typeof result.breakdown === 'object'
                        ? new Map(Object.entries(result.breakdown).filter(([, v]) => typeof v === 'number'))
                        : new Map()
                },
                expert_rationale: `Reference judge (${referenceJudgeConfig.model}) scored ${result.quality_score}/10 via ${result.scoring_method}. Original batch score: ${sample._original_score}. ${result.explanation || ''}`.substring(0, 2000),
                created_by: 'retro-calibration',
                difficulty: sample.prompt_level || 3,
                tags: ['retro', 'auto-generated', `batch:${sample.batch_id}`],
                active: true
            };
            try {
                if (cancellationConfig.cancelSignal) {
                    await JudgeGroundTruth.create([payload], { signal: cancellationConfig.cancelSignal });
                } else {
                    await JudgeGroundTruth.create(payload);
                }
                throwIfJudgeCancelled(cancellationConfig);
                assertAuthorityActive?.();
            } catch (writeError) {
                if (cancellationConfig.cancelSignal?.aborted
                    || writeError?.code === 'BENCHMARK_CLAIM_LOST'
                    || writeError?.code === 'BENCHMARK_CLAIM_STOPPED') {
                    try {
                        await JudgeGroundTruth.updateOne(
                            { _id: id },
                            {
                                $set: {
                                    active: false,
                                    authority_state: 'authority_invalidated',
                                    authority_reconciliation_reason: 'retro-calibration raced workload admission loss'
                                }
                            },
                            { upsert: true }
                        );
                        writeError.authorityCompensated = true;
                    } catch (compensationError) {
                        writeError.compensationError = compensationError;
                        writeError.retainAdmission = true;
                        writeError.code = 'GROUND_TRUTH_RECONCILIATION_PENDING';
                    }
                }
                throw writeError;
            }

            created++;

            logger.debug('Ground truth created', {
                name,
                category: sample.prompt_category,
                difficulty: sample.prompt_level,
                reference_score: result.quality_score,
                original_score: sample._original_score
            });
        } catch (err) {
            if (cancellationConfig.cancelSignal?.aborted
                || err?.code === 'BENCHMARK_CLAIM_LOST'
                || err?.code === 'BENCHMARK_CLAIM_STOPPED'
                || err?.retainAdmission === true) {
                throw err;
            }
            // Handle duplicate key gracefully
            if (err.code === 11000) {
                skipped++;
                continue;
            }
            logger.warn('Failed to create ground truth entry', {
                name,
                error: err.message
            });
            errors++;
        }
    }

    const summary = { created, skipped, errors, total: samples.length };
    logger.info('Retro-calibration complete', summary);
    return summary;
}

/**
 * Run full retro-calibration pipeline.
 * @param {string} batchId - Batch to sample from
 * @param {Object} referenceJudgeConfig - { model, host }
 * @param {Object} options - { perCell, dryRun }
 * @returns {Object} { samples, results }
 */
async function runRetroCalibration(batchId, referenceJudgeConfig, options = {}) {
    const { perCell = 3, dryRun = false, cancelSignal = null, assertAuthorityActive = null } = options;
    const cancellationConfig = { ...referenceJudgeConfig, cancelSignal };
    throwIfJudgeCancelled(cancellationConfig);
    assertAuthorityActive?.();

    const batch = await BenchmarkBatch.findById(batchId)
        .select('trust_campaign_spec_id +trust_evidence_context')
        .lean();
    if (!batch) {
        const error = new Error('Batch not found');
        error.statusCode = 404;
        throw error;
    }
    if (batch.trust_evidence_context
        || /^[a-f0-9]{64}$/i.test(String(batch.trust_campaign_spec_id || ''))) {
        const error = new Error('Strict Benchmark Trust evidence cannot be consumed by legacy retro-calibration');
        error.code = 'BENCHMARK_TRUST_RETRO_CALIBRATION_FORBIDDEN';
        error.statusCode = 409;
        throw error;
    }

    const samples = await buildStratifiedSample(batchId, perCell);
    throwIfJudgeCancelled(cancellationConfig);
    assertAuthorityActive?.();

    if (samples.length === 0) {
        return {
            samples: 0,
            results: { created: 0, skipped: 0, errors: 0, total: 0 },
            message: 'No samples matched the stratification criteria'
        };
    }

    const results = await scoreAndPromote(samples, cancellationConfig, {
        dryRun,
        cancelSignal,
        assertAuthorityActive
    });

    return {
        samples: samples.length,
        results,
        message: dryRun
            ? `Dry run: ${results.created} entries would be created`
            : `Created ${results.created} ground truth entries (${results.skipped} skipped, ${results.errors} errors)`
    };
}

/**
 * Get ground truth coverage statistics.
 * @returns {Object} Coverage matrix by category x difficulty
 */
async function getCoverageStats() {
    const [coverage, qualifiedHumanRows] = await Promise.all([
        JudgeGroundTruth.aggregate([
            { $match: { active: true } },
            {
                $group: {
                    _id: { category: '$category', difficulty: '$difficulty' },
                    count: { $sum: 1 },
                    retro_count: {
                        $sum: { $cond: [{ $eq: ['$created_by', 'retro-calibration'] }, 1, 0] }
                    },
                    seed_count: {
                        $sum: { $cond: [{ $eq: ['$created_by', 'seed-script'] }, 1, 0] }
                    }
                }
            },
            { $sort: { '_id.category': 1, '_id.difficulty': 1 } }
        ]),
        // Coverage is an operational trust signal, so its qualified counts
        // must traverse the same current signature/revocation verification as
        // judge calibration and drift decisions. The aggregate above remains
        // intentionally raw so all_count/retro_count stay observable.
        loadQualifiedHumanGroundTruth({ includePromptAuthority: true })
    ]);

    const qualifiedPromptsByCell = new Map();
    const cellByPromptFingerprint = new Map();
    for (const row of qualifiedHumanRows) {
        const key = `${row.category}\u0000${Number(row.difficulty)}`;
        const promptFingerprint = row.qualified_prompt_fingerprint;
        const priorCell = cellByPromptFingerprint.get(promptFingerprint);
        if (priorCell && priorCell !== key) {
            const error = new Error('one qualified prompt authority is assigned to multiple coverage cells');
            error.code = 'HUMAN_EVIDENCE_PROMPT_CELL_CONFLICT';
            error.statusCode = 409;
            throw error;
        }
        cellByPromptFingerprint.set(promptFingerprint, key);
        if (!qualifiedPromptsByCell.has(key)) qualifiedPromptsByCell.set(key, new Set());
        qualifiedPromptsByCell.get(key).add(promptFingerprint);
    }

    const allByCategory = {};
    const humanByCategory = {};
    let humanEntries = 0;
    let retroEntries = 0;
    let totalAllEntries = 0;
    const targetPerCell = 5;
    let cellsMeetingTarget = 0;
    let cellsMeetingTargetWithRetro = 0;
    const totalCells = CATEGORIES.length * 5; // 7 categories x 5 difficulty levels

    // Only provenance/protocol pairs accepted by the qualified-human loader
    // count toward judge qualification. Judge-visible endorsements, legacy
    // rows and retro-calibration re-scores remain visible in all_count but
    // cannot inflate meets_target or coverage_percent.
    for (const row of coverage) {
        const cat = row._id.category;
        const key = `${cat}\u0000${Number(row._id.difficulty)}`;
        const humanCount = qualifiedPromptsByCell.get(key)?.size || 0;
        if (!allByCategory[cat]) allByCategory[cat] = 0;
        if (!humanByCategory[cat]) humanByCategory[cat] = 0;
        allByCategory[cat] += row.count;
        humanByCategory[cat] += humanCount;
        humanEntries += humanCount;
        retroEntries += Number(row.retro_count) || 0;
        totalAllEntries += row.count;
        if (humanCount >= targetPerCell) cellsMeetingTarget++;
        if (row.count >= targetPerCell) cellsMeetingTargetWithRetro++;
    }

    return {
        cells: coverage.map(r => {
            const key = `${r._id.category}\u0000${Number(r._id.difficulty)}`;
            const humanCount = qualifiedPromptsByCell.get(key)?.size || 0;
            return {
                category: r._id.category,
                difficulty: r._id.difficulty,
                // Compatibility fields keep the original human-only coverage
                // contract while the explicit fields expose both views.
                count: humanCount,
                all_count: r.count,
                human: humanCount,
                retro: r.retro_count,
                unqualified_or_other: r.count - humanCount - r.retro_count,
                seed: r.seed_count,
                meets_target: humanCount >= targetPerCell,
                meets_target_with_retro: r.count >= targetPerCell
            };
        }),
        by_category: humanByCategory,
        by_category_human: humanByCategory,
        by_category_all: allByCategory,
        total_entries: humanEntries,
        total_all_entries: totalAllEntries,
        human_entries: humanEntries,
        retro_entries: retroEntries,
        unqualified_or_other_entries: totalAllEntries - humanEntries - retroEntries,
        cells_meeting_target: cellsMeetingTarget,
        cells_meeting_target_with_retro: cellsMeetingTargetWithRetro,
        total_cells: totalCells,
        coverage_percent: Math.round((cellsMeetingTarget / totalCells) * 100),
        coverage_percent_with_retro: Math.round((cellsMeetingTargetWithRetro / totalCells) * 100)
    };
}

/**
 * 0129 — Load the static config goldset from data/judge-calibration-set.json.
 * Returned entries are normalized to the shape retroCalibration consumers
 * expect: { _id, name, category, prompt, response, expected_answer,
 *           expert_scores.overall, source, difficulty }
 *
 * These are NOT written to Mongo — we read them at call time.
 *
 * @param {string} [filePath] override path (tests)
 * @returns {Array}
 */
function loadConfigGoldset(filePath) {
    const resolved = filePath
        || path.join(__dirname, '..', '..', '..', 'data', 'judge-calibration-set.json');
    try {
        if (!fs.existsSync(resolved)) return [];
        const raw = fs.readFileSync(resolved, 'utf8');
        const parsed = JSON.parse(raw);
        if (!Array.isArray(parsed)) return [];
        return parsed.map(item => ({
            _id: `cfg-${item.id}`,
            name: `config-goldset-${item.id}`,
            category: item.category,
            prompt: item.prompt,
            response: item.response,
            expected_answer: item.expected_answer || null,
            expert_scores: { overall: item.gold_score },
            expert_rationale: item.notes || `Static config goldset ${item.id} (${item.tier || 'untiered'})`,
            difficulty: item.difficulty || 3,
            source: 'config-goldset',
            tags: ['config-goldset', ...(item.tier ? [item.tier] : [])],
            _config_tier: item.tier || null,
            _config_notes: item.notes || null
        }));
    } catch (err) {
        logger.warn('loadConfigGoldset failed', { error: err.message, path: resolved });
        return [];
    }
}

/**
 * 0129 — Load human-derived ground truth from JudgeGroundTruth, covering:
 * - source == 'courthouse-review'
 * - source starts with 'human-validation-sprint-'
 *
 * @param {Object} [options] - { category, limit }
 * @returns {Array} plain objects
 */
async function loadHumanReviewGroundTruth(options = {}) {
    const query = {
        active: true,
        $or: [
            { source: HUMAN_SOURCE_TAG },
            { source: { $regex: `^${SPRINT_SOURCE_PREFIX}` } }
        ]
    };
    if (options.category) query.category = options.category;

    let q = JudgeGroundTruth.find(query);
    if (options.limit) q = q.limit(options.limit);
    q = q.sort({ reviewed_at: -1, createdAt: -1 });
    return q.lean();
}

/**
 * Load only entries whose provenance contract proves that the score was
 * authored independently of the production judge or was adjudicated from
 * independent reviews. When an exact judge identity is supplied, MongoDB also
 * excludes every unbound legacy row instead of mixing judge/runtime evidence.
 */
async function loadQualifiedHumanGroundTruth(options = {}) {
    const query = {
        active: true,
        human_attestation_fingerprint: { $type: 'string' },
        human_attestation: { $ne: null },
        $or: QUALIFIED_HUMAN_REVIEW_LANES.map(lane => ({
            ...lane,
            review_protocol: typeof lane.review_protocol === 'object'
                ? { $in: [...lane.review_protocol.$in] }
                : lane.review_protocol
        }))
    };
    if (options.category) query.category = options.category;
    if (options.judge_identity_fingerprint) {
        query.judge_identity_fingerprint = options.judge_identity_fingerprint;
    }

    const rows = await JudgeGroundTruth.find(query)
        .select('+human_attestation')
        .sort({ reviewed_at: -1, createdAt: -1 })
        .lean();
    const verified = [];
    const verifiedSourceResultIds = new Set();
    for (const row of rows) {
        try {
            const attestation = await verifyStoredAttestedHumanGroundTruth(row);
            const sourceResultId = String(row.source_result_id);
            if (verifiedSourceResultIds.has(sourceResultId)) {
                const error = new Error('multiple current human attestations bind the same source result');
                error.code = 'HUMAN_EVIDENCE_DUPLICATE_SOURCE';
                error.statusCode = 409;
                throw error;
            }
            verifiedSourceResultIds.add(sourceResultId);
            const { human_attestation: _privateAttestation, ...publicRow } = row;
            if (options.includePromptAuthority === true) {
                const promptFingerprint = attestation?.source?.promptFingerprint;
                if (typeof promptFingerprint !== 'string' || !/^[0-9a-f]{64}$/.test(promptFingerprint)) {
                    const error = new Error('qualified human evidence lacks a verified prompt authority fingerprint');
                    error.code = 'HUMAN_EVIDENCE_PROMPT_AUTHORITY_MISSING';
                    error.statusCode = 409;
                    throw error;
                }
                publicRow.qualified_prompt_fingerprint = promptFingerprint;
            }
            verified.push(publicRow);
        } catch (error) {
            if (['HUMAN_EVIDENCE_ATTESTATION_EXPIRED', 'HUMAN_EVIDENCE_ATTESTATION_REVOKED']
                .includes(error.code)) {
                logger.warn('Excluded no-longer-qualified human evidence', {
                    code: error.code,
                    attestationFingerprint: row.human_attestation_fingerprint
                });
                continue;
            }
            throw error;
        }
    }
    return options.limit ? verified.slice(0, options.limit) : verified;
}

/**
 * 0129 — Union the config goldset and human-derived ground truth. Dedupe by
 * `name` (stable identifier across both sources). If a config goldset entry
 * shares a name with a human-review entry, the human-review wins (more recent
 * signal).
 *
 * Does NOT mutate either source. Reads at call time — the config goldset is
 * never migrated into Mongo (per 0129 constraint).
 *
 * @param {Object} [options] - { includeConfig=true, includeHuman=true, category, configPath }
 * @returns {Array}
 */
async function loadUnionedGoldset(options = {}) {
    const {
        includeConfig = true,
        includeHuman = true,
        category = null,
        configPath = null
    } = options;

    let config = [];
    if (includeConfig) {
        config = loadConfigGoldset(configPath);
        if (category) config = config.filter(e => e.category === category);
    }

    let human = [];
    if (includeHuman) {
        human = await loadHumanReviewGroundTruth({ category });
    }

    // Dedupe by `name`; human entries take precedence.
    const byName = new Map();
    for (const e of config) byName.set(e.name, e);
    for (const e of human) byName.set(e.name, e);

    const unioned = Array.from(byName.values());
    logger.info('retroCalibration union built', {
        config_count: config.length,
        human_count: human.length,
        unioned_count: unioned.length
    });
    return unioned;
}

module.exports = {
    buildStratifiedSample,
    scoreAndPromote,
    runRetroCalibration,
    getCoverageStats,
    loadConfigGoldset,
    loadHumanReviewGroundTruth,
    loadQualifiedHumanGroundTruth,
    loadUnionedGoldset,
    HUMAN_SOURCE_TAG,
    SPRINT_SOURCE_PREFIX,
    QUALIFIED_HUMAN_REVIEW_LANES,
    SCORE_BUCKETS,
    CATEGORIES
};
