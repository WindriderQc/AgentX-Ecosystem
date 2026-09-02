/**
 * Benchmark Routes - Results
 * Result CRUD, advanced query, rejudge, human review
 */

const express = require('express');
const router = express.Router();
const logger = require('../../config/logger');
const benchmarkService = require('../../src/services/benchmark');
const { judgeResult } = require('../../src/services/benchmark/judging');
const { validateObjectId } = require('../../src/helpers/objectIdValidator');
const BenchmarkResult = require('../../models/BenchmarkResult');
const JudgeGroundTruth = require('../../models/JudgeGroundTruth');
const { calculateCompositeScore } = require('../../src/services/scoring/compositeScorer');
const { DEFAULT_SCORING_CATEGORY } = require('../../src/services/scoring/scoringConfigs');
const {
    resolveReadyJudgeTarget,
    judgeUnavailablePayload
} = require('../../src/services/benchmark/judgeReadiness');
const {
    RESULTS_EXPLORER_EVIDENCE_POLICY,
    EVIDENCE_ERAS,
    getEvidenceEraFilter,
    projectResultsExplorerEvidence,
    combineMongoFilters
} = require('../../src/services/benchmark/resultsExplorerEvidence');
const { DIVERGENCE_THRESHOLD } = require('../../src/services/benchmark/multiJudge');

const ADVANCED_RESULTS_MAX_LIMIT = 5000;
const ADVANCED_RESULTS_DEFAULT_LIMIT = 1000;
const ADVANCED_RESULTS_SORT_FIELDS = new Set([
    'timestamp',
    'latency',
    'tokens_per_sec',
    'time_to_first_token_ms',
    'quality_score',
    'composite_score',
    'prompt_level',
    'prompt_category',
    'model',
    'host',
    'tokens',
    'success',
    'batch_id',
    'scoring_method',
    'hardware_snapshot.backend',
    'hardware_snapshot.quantization',
    'scoring_time_ms'
]);

const JUDGE_SCORED_METHODS = new Set([
    'llm_judge', 'decomposed', 'reference', 'reference_quick', 'reasoning', 'hybrid'
]);
const DETERMINISTIC_ONLY_METHODS = new Set([
    'deterministic', 'deterministic_fallback', 'quick', 'pattern',
    'empty_response', 'response_contract_failed'
]);

function scoreEvidenceKind(result = {}) {
    const method = String(result.scoring_method || '').toLowerCase();
    const hasDeterministic = result.deterministic_score !== null
        && result.deterministic_score !== undefined;
    const hasJudge = result.subjective_score !== null
        && result.subjective_score !== undefined;
    if (hasDeterministic && hasJudge) return 'hybrid';
    if (hasDeterministic || DETERMINISTIC_ONLY_METHODS.has(method)) return 'deterministic_only';
    if (hasJudge || JUDGE_SCORED_METHODS.has(method)
        || (!!result.judge_model && !['pending', 'llm_failed', 'skipped', 'disabled'].includes(method))) {
        return 'judge_scored';
    }
    return 'unscored';
}

function rejectStrictTrustResultMutation(res, result) {
    if (!result?.trust_candidate_id && !result?.trust_prompt_id) return false;
    res.status(409).json({
        status: 'error',
        code: 'BENCHMARK_TRUST_RESULT_MUTATION_FORBIDDEN',
        error: 'Strict Benchmark Trust evidence cannot be reviewed, rejudged, or promoted in place'
    });
    return true;
}

/**
 * GET /api/benchmark/results
 * Get all test results (paginated)
 * Query: page (1-based, default 1), limit (default 50, max 200)
 */
router.get('/results', async (req, res) => {
    try {
        const page = parseInt(req.query.page, 10) || 1;
        const limit = parseInt(req.query.limit, 10) || 50;

        const { results, total, totalPages, page: safePage, limit: safeLimit } =
            await benchmarkService.getResults({ page, limit });

        res.json({
            status: 'success',
            data: { results, total, page: safePage, limit: safeLimit, totalPages }
        });
    } catch (err) {
        logger.error('Failed to fetch results', { error: err.message });
        res.status(500).json({ status: 'error', error: err.message });
    }
});

/**
 * GET /api/benchmark/results/advanced
 * Advanced filtering and querying for Results Explorer
 */
router.get('/results/advanced', async (req, res) => {
    try {
        const evidenceAsOf = new Date();

        // Build query object
        let query = {};

        // Date range
        if (req.query.dateFrom || req.query.dateTo) {
            query.timestamp = {};
            if (req.query.dateFrom) {
                const d = new Date(req.query.dateFrom);
                if (isNaN(d.getTime())) return res.status(400).json({ status: 'error', error: 'Invalid dateFrom format' });
                query.timestamp.$gte = d;
            }
            if (req.query.dateTo) {
                const dateTo = new Date(req.query.dateTo);
                if (isNaN(dateTo.getTime())) return res.status(400).json({ status: 'error', error: 'Invalid dateTo format' });
                dateTo.setHours(23, 59, 59, 999);
                query.timestamp.$lte = dateTo;
            }
        }

        // Model filter
        if (req.query.models) {
            const models = req.query.models.split(',').map(m => m.trim());
            query.model = { $in: models };
        }

        // Category filter
        if (req.query.categories) {
            const categories = req.query.categories.split(',').map(c => c.trim());
            query.prompt_category = { $in: categories };
        }

        // Level range
        if (req.query.levelMin || req.query.levelMax) {
            query.prompt_level = {};
            if (req.query.levelMin) {
                query.prompt_level.$gte = parseInt(req.query.levelMin, 10);
            }
            if (req.query.levelMax) {
                query.prompt_level.$lte = parseInt(req.query.levelMax, 10);
            }
        }

        // Quality range
        if (req.query.qualityMin || req.query.qualityMax) {
            query.quality_score = { $ne: null };
            if (req.query.qualityMin) {
                query.quality_score.$gte = parseFloat(req.query.qualityMin);
            }
            if (req.query.qualityMax) {
                query.quality_score.$lte = parseFloat(req.query.qualityMax);
            }
        }

        // Host filter
        if (req.query.host) {
            query.host = req.query.host;
        }

        // Backend filter
        if (req.query.backend) {
            query['hardware_snapshot.backend'] = req.query.backend;
        }

        // Quantization filter
        if (req.query.quantization) {
            query['hardware_snapshot.quantization'] = req.query.quantization;
        }

        // Success filter
        if (req.query.success !== undefined && req.query.success !== '') {
            query.success = req.query.success === 'true';
        }

        // Batch ID filter
        if (req.query.batchId) {
            query.batch_id = req.query.batchId;
        }

        // Scoring method filter
        if (req.query.scoringMethod) {
            query.scoring_method = req.query.scoringMethod;
        }

        // Evidence age is deliberately derived only from the persisted result
        // timestamp. It does not infer a legacy schema or scoring contract.
        if (req.query.evidenceEra) {
            const evidenceEra = String(req.query.evidenceEra).toLowerCase();
            if (!EVIDENCE_ERAS.has(evidenceEra)) {
                return res.status(400).json({ status: 'error', error: 'Invalid evidenceEra' });
            }
            query = combineMongoFilters(query, getEvidenceEraFilter(evidenceEra, evidenceAsOf));
        }

        // Pagination and sorting
        const parsedLimit = parseInt(req.query.limit, 10);
        const limit = Number.isFinite(parsedLimit)
            ? Math.max(1, Math.min(parsedLimit, ADVANCED_RESULTS_MAX_LIMIT))
            : ADVANCED_RESULTS_DEFAULT_LIMIT;
        const parsedOffset = parseInt(req.query.offset, 10);
        const offset = Number.isFinite(parsedOffset)
            ? Math.max(0, parsedOffset)
            : 0;
        const requestedSortField = String(req.query.sort || 'timestamp');
        const sortField = ADVANCED_RESULTS_SORT_FIELDS.has(requestedSortField)
            ? requestedSortField
            : 'timestamp';
        const sortDir = req.query.sortDir === 'asc' ? 1 : -1;

        // Execute query
        const sortSpec = { [sortField]: sortDir };
        if (sortField !== '_id') sortSpec._id = sortDir;
        const includeFacets = req.query.includeFacets === 'true';
        const includeEvidenceMeta = includeFacets || req.query.includeEvidenceMeta === 'true';
        const eraFilters = {
            recent: getEvidenceEraFilter('recent', evidenceAsOf),
            aging: getEvidenceEraFilter('aging', evidenceAsOf),
            historical: getEvidenceEraFilter('historical', evidenceAsOf),
            undated: getEvidenceEraFilter('undated', evidenceAsOf)
        };

        const [
            results,
            total,
            archiveTotal,
            recentCount,
            agingCount,
            historicalCount,
            undatedCount,
            legacyScoringCount,
            facets
        ] = await Promise.all([
            BenchmarkResult.find(query)
                .sort(sortSpec)
                .skip(offset)
                .limit(limit)
                .lean(),
            BenchmarkResult.countDocuments(query),
            includeEvidenceMeta ? BenchmarkResult.countDocuments({}) : Promise.resolve(null),
            includeEvidenceMeta
                ? BenchmarkResult.countDocuments(combineMongoFilters(query, eraFilters.recent))
                : Promise.resolve(null),
            includeEvidenceMeta
                ? BenchmarkResult.countDocuments(combineMongoFilters(query, eraFilters.aging))
                : Promise.resolve(null),
            includeEvidenceMeta
                ? BenchmarkResult.countDocuments(combineMongoFilters(query, eraFilters.historical))
                : Promise.resolve(null),
            includeEvidenceMeta
                ? BenchmarkResult.countDocuments(combineMongoFilters(query, eraFilters.undated))
                : Promise.resolve(null),
            includeEvidenceMeta
                ? BenchmarkResult.countDocuments(combineMongoFilters(query, { composite_formula: 'legacy' }))
                : Promise.resolve(null),
            includeFacets
                ? Promise.all([
                    BenchmarkResult.distinct('model'),
                    BenchmarkResult.distinct('host'),
                    BenchmarkResult.distinct('hardware_snapshot.backend'),
                    BenchmarkResult.distinct('hardware_snapshot.quantization'),
                    BenchmarkResult.distinct('scoring_method')
                ]).then(([models, hosts, backends, quantizations, scoringMethods]) => ({
                    models,
                    hosts,
                    backends,
                    quantizations,
                    scoring_methods: scoringMethods
                }))
                : Promise.resolve(null)
        ]);

        const totalPages = total > 0 ? Math.ceil(total / limit) : 0;

        res.json({
            status: 'success',
            data: {
                results: results.map((result) => ({
                    ...projectResultsExplorerEvidence(result, evidenceAsOf),
                    evidence_mode: scoreEvidenceKind(result)
                })),
                total,
                limit,
                offset,
                page: Math.floor(offset / limit) + 1,
                totalPages,
                returned: results.length,
                sort: sortField,
                sortDir: sortDir === 1 ? 'asc' : 'desc',
                hasMore: (offset + results.length) < total,
                ...(includeEvidenceMeta ? {
                    archiveTotal,
                    evidencePolicy: {
                        ...RESULTS_EXPLORER_EVIDENCE_POLICY,
                        as_of: evidenceAsOf.toISOString()
                    },
                    evidenceCounts: {
                        recent: recentCount,
                        aging: agingCount,
                        historical: historicalCount,
                        undated: undatedCount,
                        legacy_scoring: legacyScoringCount
                    }
                } : {}),
                ...(facets ? { facets } : {})
            }
        });
    } catch (err) {
        logger.error('Failed to fetch advanced results', { error: err.message, query: req.query });
        res.status(500).json({ status: 'error', error: err.message });
    }
});

/**
 * GET /api/benchmark/results/needs-review
 * Get results flagged for manual review due to low judge confidence
 */
router.get('/results/needs-review', async (req, res) => {
    try {
        const { limit = 50, batch_id, model, min_confidence, max_confidence } = req.query;

        const filter = { needs_review: true };

        if (batch_id) filter.batch_id = batch_id;
        if (model) filter.model = model;
        if (min_confidence !== undefined) {
            filter.judge_confidence = { ...filter.judge_confidence, $gte: parseFloat(min_confidence) };
        }
        if (max_confidence !== undefined) {
            filter.judge_confidence = { ...filter.judge_confidence, $lte: parseFloat(max_confidence) };
        }

        const results = await BenchmarkResult.find(filter)
            .sort({ judge_confidence: 1, timestamp: -1 })
            .limit(parseInt(limit))
            .select({
                model: 1,
                prompt: 1,
                prompt_name: 1,
                prompt_level: 1,
                prompt_category: 1,
                expected_answer: 1,
                response: 1,
                quality_score: 1,
                quality_explanation: 1,
                quality_breakdown: 1,
                scoring_method: 1,
                judge_model: 1,
                judge_confidence: 1,
                judge_consensus: 1,
                judge_divergence: 1,
                judge_scores: 1,
                deterministic_score: 1,
                deterministic_pass: 1,
                subjective_score: 1,
                composite_formula: 1,
                needs_review: 1,
                review_reason: 1,
                human_score: 1,
                human_reviewed_at: 1,
                batch_id: 1,
                timestamp: 1
            })
            .lean();

        // Get aggregate stats
        const stats = await BenchmarkResult.aggregate([
            { $match: { needs_review: true } },
            {
                $group: {
                    _id: null,
                    total: { $sum: 1 },
                    reviewed: { $sum: { $cond: [{ $ne: ['$human_score', null] }, 1, 0] } },
                    avg_confidence: { $avg: '$judge_confidence' }
                }
            }
        ]);

        res.json({
            status: 'success',
            data: {
                results: results.map((result) => ({
                    ...result,
                    // A stable boolean makes the review-queue counter
                    // authoritative. The UI must not infer a reassuring zero
                    // from an omitted numeric field.
                    judge_divergent: Number.isFinite(Number(result.judge_divergence))
                        ? Number(result.judge_divergence) > DIVERGENCE_THRESHOLD
                        : ['divergent_unresolved', 'tiebreaker_resolved'].includes(result.judge_consensus),
                    evidence_mode: scoreEvidenceKind(result)
                })),
                stats: stats[0] || { total: 0, reviewed: 0, avg_confidence: null },
                limit: parseInt(limit)
            }
        });
    } catch (err) {
        logger.error('Failed to fetch results needing review', { error: err.message });
        res.status(500).json({ status: 'error', error: err.message });
    }
});

/**
 * POST /api/benchmark/results/:id/human-review
 * Submit a human review score for a result
 */
router.post('/results/:id/human-review', async (req, res) => {
    try {
        const { action, human_score, reviewer, notes } = req.body;

        if (!validateObjectId(req.params.id, res, 'Result ID')) return;

        const result = await BenchmarkResult.findById(req.params.id);
        if (!result) {
            return res.status(404).json({
                status: 'error',
                error: 'Result not found'
            });
        }
        if (rejectStrictTrustResultMutation(res, result)) return;

        const updateFields = {
            human_reviewed_at: new Date(),
            human_reviewer: reviewer || 'anonymous'
        };
        if (notes) updateFields.human_notes = String(notes).slice(0, 2000);

        const effectiveAction = action || ((human_score !== undefined && human_score !== null) ? 'override' : 'approve');

        if (result.evaluation_authority === 'executable'
            && (effectiveAction === 'approve' || effectiveAction === 'override')) {
            return res.status(409).json({
                status: 'error',
                code: 'EXECUTABLE_VERIFICATION_REQUIRED',
                error: `Result correctness is owned by executable fixture ${result.executable_fixture_id || '(missing fixture id)'}; a human review cannot make this advisory row leaderboard-eligible`
            });
        }

        switch (effectiveAction) {
        case 'approve':
            if (result.quality_score === null || result.quality_score === undefined) {
                return res.status(400).json({
                    status: 'error',
                    error: 'Cannot approve a result without score evidence (quality_score)'
                });
            }
            updateFields.human_review_status = 'approved';
            updateFields.human_score = result.quality_score;
            updateFields.needs_review = false;
            updateFields.review_reason = null;
            updateFields.excluded_from_leaderboard = false;
            break;
        case 'override': {
            if (human_score === undefined || human_score === null || human_score < 0 || human_score > 10) {
                return res.status(400).json({
                    status: 'error',
                    error: 'human_score must be between 0 and 10 for override'
                });
            }
            const overrideValue = parseFloat(human_score);
            updateFields.human_review_status = 'overridden';
            updateFields.human_score = overrideValue;
            updateFields.needs_review = false;
            updateFields.review_reason = null;
            updateFields.excluded_from_leaderboard = false;
            // Effective leaderboard score: replace quality_score with the
            // human override. Preserve judge_quality_score only when the
            // source actually contains judge-scored evidence; deterministic
            // scores must never be relabelled as judge drift evidence.
            const sourceEvidenceKind = scoreEvidenceKind(result);
            if ((sourceEvidenceKind === 'judge_scored' || sourceEvidenceKind === 'hybrid')
                && (result.judge_quality_score === null || result.judge_quality_score === undefined)) {
                updateFields.judge_quality_score = result.quality_score;
            }
            updateFields.quality_score = overrideValue;
            // Composite must be recomputed with the new quality. Reuses the
            // same scorer the post-judging pipeline uses.
            const overrideComposite = calculateCompositeScore({
                latency: result.latency,
                tokens_per_sec: result.tokens_per_sec,
                time_to_first_token_ms: result.time_to_first_token_ms,
                performance_baseline: result.performance_baseline || null,
                quality_score: overrideValue
            }, result.prompt_category || DEFAULT_SCORING_CATEGORY);
            updateFields.composite_score = overrideComposite.composite_score;
            updateFields.composite_profile_used = overrideComposite.composite_profile_used;
            updateFields.normalized_scores = overrideComposite.normalized;
            break;
        }
        case 'reject':
            updateFields.human_review_status = 'rejected';
            updateFields.human_score = null;
            updateFields.needs_review = false;
            updateFields.review_reason = notes
                ? `Rejected by human review: ${String(notes).slice(0, 400)}`
                : 'Rejected by human review';
            updateFields.excluded_from_leaderboard = true;
            break;
        default:
            return res.status(400).json({
                status: 'error',
                error: 'action must be one of: approve, override, reject'
            });
        }

        const updated = await BenchmarkResult.findByIdAndUpdate(
            req.params.id,
            { $set: updateFields },
            { new: true }
        );

        // 0129: Calibration loop — write courthouse reviews to JudgeGroundTruth
        // so retroCalibration + drift detector can consume them. We only write
        // approve/override (rejected reviews carry no usable human_score).
        // Idempotent on re-review via unique `name` field + findOneAndUpdate upsert.
        let groundTruthId = null;
        try {
            if ((effectiveAction === 'approve' || effectiveAction === 'override')
                && updated.human_score !== null && updated.human_score !== undefined
                && updated.response && updated.prompt) {
                const gtName = `courthouse-review-${updated._id}`;
                const rationaleBase = notes
                    ? `Courthouse review by ${updateFields.human_reviewer}: ${String(notes).slice(0, 400)}`
                    : `Courthouse ${effectiveAction} by ${updateFields.human_reviewer}`;
                const evidenceKind = scoreEvidenceKind(updated);
                const hasJudgeEvidence = evidenceKind === 'judge_scored' || evidenceKind === 'hybrid';
                // The current Courthouse UI is judge-visible. Approval copies
                // the judge score and override is still a single visible
                // review; neither may be relabelled as independent human
                // ground truth for Benchmark Trust qualification.
                const provenanceClass = effectiveAction === 'approve'
                    ? 'endorsed_judge_score'
                    : 'human_override_visible_judge';
                const gtDoc = await JudgeGroundTruth.findOneAndUpdate(
                    { name: gtName },
                    {
                        $set: {
                            name: gtName,
                            prompt: updated.prompt,
                            response: updated.response,
                            category: updated.prompt_category || 'knowledge',
                            expected_answer: updated.expected_answer || null,
                            expert_scores: {
                                overall: updated.human_score,
                                dimensions: {}
                            },
                            expert_rationale: rationaleBase,
                            created_by: 'courthouse-review',
                            source: 'courthouse-review',
                            provenance_class: provenanceClass,
                            review_protocol: 'judge_visible_single_review',
                            reviewer: updateFields.human_reviewer,
                            reviewed_at: updateFields.human_reviewed_at,
                            source_result_id: updated._id,
                            // Only judge-scored/hybrid rows have a meaningful
                            // judge score at review. Deterministic-only ground
                            // truth deliberately stores null here.
                            judge_score_at_review: hasJudgeEvidence
                                ? (updated.judge_quality_score ?? updated.quality_score)
                                : null,
                            difficulty: updated.prompt_level || 3,
                            tags: ['courthouse', 'courthouse-review', effectiveAction, evidenceKind],
                            active: true
                        }
                    },
                    { upsert: true, new: true, setDefaultsOnInsert: true }
                );
                groundTruthId = gtDoc && gtDoc._id;
            }
        } catch (gtErr) {
            // Don't fail the review because of ground-truth bookkeeping.
            logger.warn('Courthouse review accepted but ground truth write failed', {
                error: gtErr.message, id: req.params.id
            });
        }

        res.json({
            status: 'success',
            data: {
                id: updated._id,
                action: updated.human_review_status,
                human_score: updated.human_score,
                human_notes: updated.human_notes,
                human_reviewed_at: updated.human_reviewed_at,
                quality_score: updated.quality_score,
                evidence_mode: scoreEvidenceKind(updated),
                judge_confidence: updated.judge_confidence,
                excluded_from_leaderboard: updated.excluded_from_leaderboard,
                ground_truth_id: groundTruthId
            }
        });
    } catch (err) {
        logger.error('Failed to submit human review', { error: err.message, id: req.params.id });
        res.status(err.statusCode || 500).json({ status: 'error', code: err.code, error: err.message });
    }
});

/**
 * GET /api/benchmark/results/:id
 * Get full details for a single test result (for Test Inspector)
 */
router.get('/results/:id', async (req, res) => {
    try {

        if (!validateObjectId(req.params.id, res, 'Result ID')) return;

        const result = await BenchmarkResult.findById(req.params.id).lean();

        if (!result) {
            return res.status(404).json({
                status: 'error',
                error: 'Result not found'
            });
        }

        res.json({
            status: 'success',
            data: {
                ...projectResultsExplorerEvidence(result),
                evidence_mode: scoreEvidenceKind(result)
            }
        });
    } catch (err) {
        logger.error('Failed to fetch result details', { error: err.message, id: req.params.id });
        res.status(500).json({ status: 'error', error: err.message });
    }
});

/**
 * POST /api/benchmark/results/:id/rejudge
 * Re-run judging on a single result that has pending/failed scoring
 */
router.post('/results/:id/rejudge', async (req, res) => {
    try {
        if (!validateObjectId(req.params.id, res, 'Result ID')) return;

        const readiness = await resolveReadyJudgeTarget({
            model: req.body.judge_model,
            host: req.body.judge_host
        });
        if (!readiness.ready) {
            return res.status(503).json(judgeUnavailablePayload(readiness, 'Re-judge'));
        }
        const judgeConfig = {
            model: readiness.target.model,
            host: readiness.target.host
        };

        logger.info('Re-judging result', { resultId: req.params.id, judgeConfig });

        const result = await judgeResult(req.params.id, judgeConfig);

        res.json({
            status: 'success',
            data: result
        });
    } catch (err) {
        logger.error('Failed to rejudge result', { error: err.message, id: req.params.id });
        const statusCode = err.statusCode || (err.message.includes('not found') ? 404
            : err.message.includes('Cannot judge') || err.message.includes('No response') ? 400
            : 500);
        res.status(statusCode).json({ status: 'error', code: err.code, error: err.message });
    }
});

/**
 * DELETE /api/benchmark/results
 * Clear all results (requires confirmation)
 */
router.delete('/results', async (req, res) => {
    try {
        if (req.body?.confirm !== 'DELETE_ALL') {
            return res.status(400).json({ status: 'error', error: 'Confirmation required: send { confirm: "DELETE_ALL" } in request body' });
        }
        const count = await benchmarkService.clearResults();

        res.json({
            status: 'success',
            message: `Cleared ${count} results`
        });
    } catch (err) {
        logger.error('Failed to clear results', { error: err.message });
        res.status(err.statusCode || 500).json({ status: 'error', code: err.code, error: err.message });
    }
});

/**
 * DELETE /api/benchmark/results/failed
 * Clear failed results only (requires confirmation)
 */
router.delete('/results/failed', async (req, res) => {
    try {
        if (req.body?.confirm !== 'DELETE_FAILED') {
            return res.status(400).json({ status: 'error', error: 'Confirmation required: send { confirm: "DELETE_FAILED" } in request body' });
        }
        const count = await benchmarkService.clearFailedResults();

        res.json({
            status: 'success',
            message: `Cleared ${count} failed results`
        });
    } catch (err) {
        logger.error('Failed to clear failed results', { error: err.message });
        res.status(err.statusCode || 500).json({ status: 'error', code: err.code, error: err.message });
    }
});

/**
 * POST /api/benchmark/results/:id/promote-ground-truth
 * Promote a reviewed result to a ground truth entry
 */
router.post('/results/:id/promote-ground-truth', async (req, res) => {
    try {
        const { id } = req.params;
        const { expert_score, expert_rationale } = req.body;

        if (expert_score === undefined || expert_score === null) {
            return res.status(400).json({
                status: 'error',
                error: 'expert_score is required'
            });
        }

        if (!expert_rationale) {
            return res.status(400).json({
                status: 'error',
                error: 'expert_rationale is required'
            });
        }

        const result = await BenchmarkResult.findById(id).lean();
        if (!result) {
            return res.status(404).json({ status: 'error', error: 'Result not found' });
        }
        if (rejectStrictTrustResultMutation(res, result)) return;

        const name = `promoted-${id}-${Date.now()}`;

        // Copy judge_criteria from the source result so calibration runs
        // exercise the same per-prompt criteria path as live batches (0197).
        // Falls through to an empty array when the source doesn't have it.
        const judgeCriteria = Array.isArray(result.judge_criteria)
            ? result.judge_criteria.filter(c => typeof c === 'string' && c.trim())
            : [];
        const evidenceKind = scoreEvidenceKind(result);
        const hasJudgeEvidence = evidenceKind === 'judge_scored' || evidenceKind === 'hybrid';

        const entry = await JudgeGroundTruth.create({
            name,
            prompt: result.prompt || '',
            response: result.response || '',
            category: result.prompt_category || 'knowledge',
            expected_answer: result.expected_answer || null,
            judge_criteria: judgeCriteria,
            expert_scores: {
                overall: expert_score,
                dimensions: result.quality_breakdown || {}
            },
            expert_rationale,
            difficulty: result.prompt_level || 3,
            tags: ['promoted', 'courthouse', evidenceKind],
            created_by: 'courthouse-review',
            source: 'courthouse-review',
            reviewer: req.body.reviewer || 'anonymous',
            reviewed_at: new Date(),
            source_result_id: result._id,
            judge_score_at_review: hasJudgeEvidence
                ? (result.judge_quality_score ?? result.quality_score)
                : null,
            active: true
        });

        logger.info('Result promoted to ground truth', {
            result_id: id, ground_truth_id: entry._id
        });

        res.status(201).json({ status: 'success', data: entry });
    } catch (err) {
        if (err.code === 11000) {
            return res.status(400).json({ status: 'error', error: 'Already promoted' });
        }
        logger.error('Failed to promote result', { error: err.message });
        res.status(500).json({ status: 'error', error: err.message });
    }
});

module.exports = router;
