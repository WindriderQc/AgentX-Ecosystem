/**
 * JudgeGroundTruth Model
 * Curated test dataset for validating judge model performance
 * Contains responses with expert-assigned reference scores
 */

const mongoose = require('mongoose');

const JUDGE_IDENTITY_FINGERPRINT_PATTERN = /^[0-9a-f]{64}$/;
const SCORE_MIN = 0;
const SCORE_MAX = 10;
const GROUND_TRUTH_CATEGORIES = Object.freeze([
    'coding', 'reasoning', 'math', 'knowledge', 'instruction', 'creative', 'translation', 'factual'
]);
const JUDGE_IDENTITY_IMMUTABLE_ERROR_CODE = 'JUDGE_IDENTITY_FINGERPRINT_IMMUTABLE';
const QUALIFIED_JUDGE_GROUND_TRUTH_IMMUTABLE_ERROR_CODE = 'QUALIFIED_JUDGE_GROUND_TRUTH_IMMUTABLE';
const QUALIFIED_REVIEW_CONDITIONS = [
    {
        provenance_class: 'independent_human_score',
        review_protocol: { $in: ['blind_independent', 'blind_double_review'] }
    },
    {
        provenance_class: 'adjudicated_human_score',
        review_protocol: 'adjudicated'
    }
];
const QUALIFIED_DECISION_PATHS = new Set([
    'name',
    'prompt',
    'response',
    'category',
    'expected_answer',
    'expert_scores',
    'expert_rationale',
    'created_by',
    'source',
    'provenance_class',
    'review_protocol',
    'reviewer',
    'reviewed_at',
    'source_result_id',
    'judge_score_at_review',
    'judge_identity_fingerprint',
    'difficulty',
    'judge_criteria',
    'tags',
    'active'
]);

function judgeIdentityImmutableError(operation) {
    const detail = operation.includes('not allowed') ? operation : `${operation} is forbidden`;
    const error = new Error(`judge_identity_fingerprint is immutable; ${detail}`);
    error.code = JUDGE_IDENTITY_IMMUTABLE_ERROR_CODE;
    error.statusCode = 409;
    return error;
}

function qualifiedGroundTruthImmutableError(operation) {
    const error = new Error(
        `qualified JudgeGroundTruth evidence is append-only; ${operation} is forbidden; create a new row/version`
    );
    error.code = QUALIFIED_JUDGE_GROUND_TRUTH_IMMUTABLE_ERROR_CODE;
    error.statusCode = 409;
    return error;
}

function qualifiedReviewFilter() {
    return { $or: QUALIFIED_REVIEW_CONDITIONS };
}

function excludesQualifiedReviewFilter() {
    return { $nor: QUALIFIED_REVIEW_CONDITIONS };
}

function isQualifiedReviewPair(provenanceClass, reviewProtocol) {
    return (
        provenanceClass === 'independent_human_score'
        && ['blind_independent', 'blind_double_review'].includes(reviewProtocol)
    ) || (
        provenanceClass === 'adjudicated_human_score'
        && reviewProtocol === 'adjudicated'
    );
}

function pathTouchesQualifiedDecisionContent(path) {
    return [...QUALIFIED_DECISION_PATHS].some(protectedPath => (
        path === protectedPath || path.startsWith(`${protectedPath}.`)
    ));
}

function pathTouchesQualifiedReviewPair(path) {
    return path === 'provenance_class'
        || path.startsWith('provenance_class.')
        || path === 'review_protocol'
        || path.startsWith('review_protocol.');
}

function mutationPaths(update) {
    const directPaths = Object.keys(update).filter(key => !key.startsWith('$'));
    const operatorPaths = Object.entries(update)
        .filter(([key, value]) => key !== '$setOnInsert' && key.startsWith('$')
            && value && typeof value === 'object' && !Array.isArray(value))
        .flatMap(([, value]) => Object.keys(value));
    const renamePaths = Object.entries(update.$rename || {}).flatMap(([from, to]) => [from, to]);
    return [...directPaths, ...operatorPaths, ...renamePaths];
}

function updateTouchesQualifiedDecisionContent(update) {
    return mutationPaths(update).some(pathTouchesQualifiedDecisionContent);
}

function updateTouchesQualifiedReviewPairOutsideSet(update) {
    const nonSetOperatorPaths = Object.entries(update)
        .filter(([operator, value]) => operator.startsWith('$')
            && operator !== '$set'
            && operator !== '$setOnInsert'
            && value && typeof value === 'object' && !Array.isArray(value))
        .flatMap(([operator, value]) => (
            operator === '$rename'
                ? Object.entries(value).flatMap(([from, to]) => [from, to])
                : Object.keys(value)
        ));
    return nonSetOperatorPaths.some(pathTouchesQualifiedReviewPair);
}

function setOnInsertTouchesQualifiedReviewPair(update) {
    return Object.keys(update.$setOnInsert || {}).some(pathTouchesQualifiedReviewPair);
}

function aggregateContainsWriteStage(value) {
    if (Array.isArray(value)) return value.some(aggregateContainsWriteStage);
    if (!value || typeof value !== 'object') return false;
    return Object.entries(value).some(([key, entry]) => (
        key === '$merge' || key === '$out' || aggregateContainsWriteStage(entry)
    ));
}

function exactFilterValue(filter, path) {
    if (!filter || typeof filter !== 'object' || Array.isArray(filter)) return undefined;
    if (typeof filter[path] === 'string') return filter[path];
    if (!Array.isArray(filter.$and)) return undefined;
    for (const entry of filter.$and) {
        const value = exactFilterValue(entry, path);
        if (value !== undefined) return value;
    }
    return undefined;
}

function filterSeedsQualifiedReviewPair(filter) {
    return isQualifiedReviewPair(
        exactFilterValue(filter, 'provenance_class'),
        exactFilterValue(filter, 'review_protocol')
    );
}

function filterMentionsPath(filter, targetPath) {
    if (Array.isArray(filter)) return filter.some(entry => filterMentionsPath(entry, targetPath));
    if (!filter || typeof filter !== 'object') return false;
    return Object.entries(filter).some(([path, value]) => (
        path === targetPath || filterMentionsPath(value, targetPath)
    ));
}

function filterBindsExactJudgeIdentity(filter, fingerprint) {
    if (!filter || typeof filter !== 'object' || Array.isArray(filter)) return false;
    if (filter.judge_identity_fingerprint === fingerprint) return true;
    return Array.isArray(filter.$and)
        && filter.$and.some(entry => filterBindsExactJudgeIdentity(entry, fingerprint));
}

function updateTouchesJudgeIdentity(update) {
    const directPaths = Object.keys(update).filter(key => !key.startsWith('$'));
    const operatorPaths = Object.entries(update)
        .filter(([key, value]) => key !== '$setOnInsert' && key.startsWith('$')
            && value && typeof value === 'object' && !Array.isArray(value))
        .flatMap(([, value]) => Object.keys(value));
    const renamePaths = Object.entries(update.$rename || {}).flatMap(([from, to]) => [from, to]);
    return [...directPaths, ...operatorPaths, ...renamePaths].some(path => (
        path === 'judge_identity_fingerprint'
        || path.startsWith('judge_identity_fingerprint.')
    ));
}

function qualifiedReviewPairIsValid(provenanceClass, reviewProtocol) {
    if (['independent_human_score', 'adjudicated_human_score'].includes(provenanceClass)) {
        return isQualifiedReviewPair(provenanceClass, reviewProtocol);
    }
    return true;
}

function qualifiedReviewValidationError(message) {
    const error = new mongoose.Error.ValidationError();
    error.addError('review_protocol', new mongoose.Error.ValidatorError({
        path: 'review_protocol',
        message
    }));
    return error;
}

function scoreIsFiniteAndInRange(value) {
    return Number.isFinite(value) && value >= SCORE_MIN && value <= SCORE_MAX;
}

function scoreMapIsFiniteAndInRange(value) {
    if (value === null || value === undefined) return true;
    const values = value instanceof Map ? [...value.values()] : Object.values(value);
    return values.every(scoreIsFiniteAndInRange);
}

function assertGroundTruthScores(document, operation) {
    if (!scoreIsFiniteAndInRange(document.expert_scores?.overall)) {
        throw qualifiedReviewValidationError(
            `${operation} requires expert_scores.overall to be a finite score from 0 through 10`
        );
    }
    if (!scoreMapIsFiniteAndInRange(document.expert_scores?.dimensions)) {
        throw qualifiedReviewValidationError(
            `${operation} requires every expert dimension score to be finite and from 0 through 10`
        );
    }
    if (document.judge_score_at_review !== null
        && document.judge_score_at_review !== undefined
        && !scoreIsFiniteAndInRange(document.judge_score_at_review)) {
        throw qualifiedReviewValidationError(
            `${operation} requires judge_score_at_review to be a finite score from 0 through 10`
        );
    }
}

function assertNewGroundTruthSafety(document, operation) {
    assertGroundTruthScores(document, operation);
    if (['independent_human_score', 'adjudicated_human_score'].includes(document.provenance_class)
        && !isQualifiedReviewPair(document.provenance_class, document.review_protocol)) {
        throw qualifiedReviewValidationError(
            `${operation} qualified provenance requires its matching blind or adjudicated review protocol`
        );
    }
    if (isQualifiedReviewPair(document.provenance_class, document.review_protocol)) {
        const requiredText = ['name', 'prompt', 'response', 'expert_rationale'];
        if (requiredText.some(path => (
            typeof document[path] !== 'string' || document[path].trim().length === 0
        )) || !GROUND_TRUTH_CATEGORIES.includes(document.category)) {
            throw qualifiedReviewValidationError(
                `${operation} qualified evidence requires non-empty name, prompt, response, expert_rationale, and a known category`
            );
        }
        if (!JUDGE_IDENTITY_FINGERPRINT_PATTERN.test(document.judge_identity_fingerprint || '')) {
            throw qualifiedReviewValidationError(
                `${operation} qualified evidence requires an exact judge_identity_fingerprint`
            );
        }
        if (document.active !== true || !scoreIsFiniteAndInRange(document.judge_score_at_review)) {
            throw qualifiedReviewValidationError(
                `${operation} qualified evidence must be active and carry a finite judge score from 0 through 10`
            );
        }
        throw qualifiedGroundTruthImmutableError(
            `${operation} creating qualified evidence without an authorized attested import authority`
        );
    }
}

function pathTouchesDecisionScore(path) {
    return path === 'judge_score_at_review'
        || path === 'expert_scores'
        || path.startsWith('expert_scores.');
}

function assignedScoreIsValid(path, value) {
    if (path === 'judge_score_at_review' || path === 'expert_scores.overall') {
        return value === null || value === undefined || scoreIsFiniteAndInRange(value);
    }
    if (path === 'expert_scores') {
        return value && scoreIsFiniteAndInRange(value.overall)
            && scoreMapIsFiniteAndInRange(value.dimensions);
    }
    if (path === 'expert_scores.dimensions') return scoreMapIsFiniteAndInRange(value);
    if (path.startsWith('expert_scores.dimensions.')) return scoreIsFiniteAndInRange(value);
    return true;
}

function assertQueryScoreMutationIsSafe(update, operation) {
    for (const [operator, assignments] of Object.entries(update)) {
        if (operator.startsWith('$')) {
            if (!assignments || typeof assignments !== 'object' || Array.isArray(assignments)) continue;
            for (const [path, value] of Object.entries(assignments)) {
                const touchesScore = pathTouchesDecisionScore(path)
                    || (operator === '$rename'
                        && typeof value === 'string'
                        && pathTouchesDecisionScore(value));
                if (!touchesScore) continue;
                const exactAssignmentIsSafe = ['$set', '$setOnInsert'].includes(operator)
                    && assignedScoreIsValid(path, value);
                if (!exactAssignmentIsSafe) {
                    throw qualifiedReviewValidationError(
                        `${operation} cannot apply an unbounded or invalid numeric mutation to decision scores`
                    );
                }
            }
        } else if (pathTouchesDecisionScore(operator)
            && !assignedScoreIsValid(operator, assignments)) {
            throw qualifiedReviewValidationError(
                `${operation} cannot assign an invalid decision score`
            );
        }
    }
}

const JudgeGroundTruthSchema = new mongoose.Schema({
    // Unique identifier for this ground truth entry
    name: {
        type: String,
        required: true,
        unique: true,
        index: true
    },

    // The prompt/task that was given
    prompt: {
        type: String,
        required: true
    },

    // The response to evaluate
    response: {
        type: String,
        required: true
    },

    // Category for this evaluation
    category: {
        type: String,
        enum: [
            ...GROUND_TRUTH_CATEGORIES
        ],
        required: true,
        index: true
    },

    // Expected answer (if applicable)
    expected_answer: {
        type: String,
        default: null
    },

    // Human expert scores (reference truth) - 0-10 scale
    expert_scores: {
        overall: {
            type: Number,
            min: 0,
            max: 10,
            required: true,
            validate: {
                validator: scoreIsFiniteAndInRange,
                message: 'expert_scores.overall must be a finite score from 0 through 10'
            }
        },
        // Dimension scores vary by category, stored as object
        dimensions: {
            type: Map,
            of: Number,
            default: {},
            validate: {
                validator: scoreMapIsFiniteAndInRange,
                message: 'expert score dimensions must be finite scores from 0 through 10'
            }
        }
    },

    // Expert's rationale for the scores
    expert_rationale: {
        type: String,
        required: true
    },

    // Metadata about who created this ground truth
    created_by: {
        type: String,
        default: 'system'
    },

    // 0129 calibration loop — provenance tag for where this entry came from.
    // - 'config-goldset'        — seeded from data/judge-calibration-set.json (virtual at read time)
    // - 'courthouse-review'     — written by a courthouse human-review submit
    // - 'human-validation-sprint-YYYY-MM-DD[-rN]' — from a 0128-style sprint
    // - 'retro-calibration'     — auto-generated by retroCalibration.js
    source: {
        type: String,
        default: null,
        index: true
    },

    // Qualification provenance is deliberately separate from the historical
    // `source` label. A Courthouse row can be human-approved while its score
    // still comes directly from the judge; source alone must never certify an
    // independent human label.
    provenance_class: {
        type: String,
        enum: [
            'endorsed_judge_score',
            'human_override_visible_judge',
            'independent_human_score',
            'adjudicated_human_score',
            'legacy_unverified'
        ],
        default: 'legacy_unverified',
        index: true
    },

    review_protocol: {
        type: String,
        enum: [
            'judge_visible_single_review',
            'blind_independent',
            'blind_double_review',
            'adjudicated',
            'legacy_unknown'
        ],
        default: 'legacy_unknown',
        validate: {
            validator: function reviewProtocolMatchesProvenance(reviewProtocol) {
                return qualifiedReviewPairIsValid(this.provenance_class, reviewProtocol);
            },
            message: 'qualified human provenance requires a matching blind or adjudicated review protocol'
        }
    },

    // 0129 — reviewer user id (for courthouse-review entries)
    reviewer: {
        type: String,
        default: null
    },

    // 0129 — when the review/sprint produced this entry
    reviewed_at: {
        type: Date,
        default: null
    },

    // 0129 — original BenchmarkResult._id for courthouse-review entries
    source_result_id: {
        type: mongoose.Schema.Types.ObjectId,
        default: null,
        index: true
    },

    // 0129 — the judge's score at the time of review (for drift computation)
    judge_score_at_review: {
        type: Number,
        default: null,
        min: 0,
        max: 10,
        validate: {
            validator: value => value === null || value === undefined || scoreIsFiniteAndInRange(value),
            message: 'judge_score_at_review must be a finite score from 0 through 10'
        }
    },

    // Exact immutable identity of the judge that produced
    // `judge_score_at_review`. Legacy rows omit it and are intentionally
    // ineligible for identity-scoped drift calculations.
    judge_identity_fingerprint: {
        type: String,
        default: null,
        immutable: true,
        match: JUDGE_IDENTITY_FINGERPRINT_PATTERN,
        index: true
    },

    // Difficulty level (1-5)
    difficulty: {
        type: Number,
        min: 1,
        max: 5,
        default: 3
    },

    // Per-prompt evaluation criteria, copied from the source benchmark prompt
    // when the entry was promoted. Consumed by decomposedJudge as the
    // `specific_criteria` dimension (task 0197) so calibration runs go through
    // the same code path as live batches. Optional; goldset entries created
    // before 0197 may not have it (backfill via scripts/backfill-goldset-judge-criteria.js).
    judge_criteria: [{
        type: String
    }],

    // Tags for filtering
    tags: [{
        type: String,
        index: true
    }],

    // Whether this entry is active for validation
    active: {
        type: Boolean,
        default: true,
        index: true
    },

    // Validation run history (last N runs)
    validation_history: [{
        judge_model: String,
        judge_score: Number,
        dimension_scores: Object,
        deviation: Number,  // Absolute difference from expert_scores.overall
        timestamp: { type: Date, default: Date.now }
    }],

    // Aggregate stats from validation runs
    validation_stats: {
        total_runs: { type: Number, default: 0 },
        avg_deviation: { type: Number, default: null },
        max_deviation: { type: Number, default: null },
        min_deviation: { type: Number, default: null },
        last_validated: { type: Date, default: null }
    }
}, {
    timestamps: true
});

// Index for efficient validation queries
JudgeGroundTruthSchema.index({ category: 1, active: 1 });
JudgeGroundTruthSchema.index({ difficulty: 1, active: 1 });
JudgeGroundTruthSchema.index({ provenance_class: 1, active: 1, category: 1 });
JudgeGroundTruthSchema.index({ judge_identity_fingerprint: 1, active: 1, category: 1 });

for (const operation of ['updateOne', 'updateMany', 'findOneAndUpdate', 'findOneAndReplace', 'replaceOne']) {
    JudgeGroundTruthSchema.pre(operation, async function validateQualifiedReviewPairOnQueryUpdate() {
        const update = this.getUpdate() || {};
        const originalFilter = this.getFilter() || {};
        if (operation === 'replaceOne' || operation === 'findOneAndReplace') {
            throw judgeIdentityImmutableError(operation);
        }
        if (Array.isArray(update)) {
            throw judgeIdentityImmutableError(`update pipelines are not allowed; ${operation} pipeline`);
        }
        if (updateTouchesJudgeIdentity(update)) {
            throw judgeIdentityImmutableError(`${operation} changing judge identity`);
        }
        if (Object.prototype.hasOwnProperty.call(update.$setOnInsert || {}, 'judge_identity_fingerprint')) {
            const insertedIdentity = update.$setOnInsert.judge_identity_fingerprint;
            if (!filterBindsExactJudgeIdentity(originalFilter, insertedIdentity)) {
                throw judgeIdentityImmutableError(`${operation} with unbound judge identity insert`);
            }
        }
        if (setOnInsertTouchesQualifiedReviewPair(update)) {
            throw qualifiedReviewValidationError(
                'JudgeGroundTruth provenance cannot be changed through $setOnInsert'
            );
        }
        if (this.getOptions().upsert
            && (filterMentionsPath(originalFilter, 'provenance_class')
                || filterMentionsPath(originalFilter, 'review_protocol'))) {
            throw qualifiedGroundTruthImmutableError(
                `${operation} upsert with provenance or review protocol in its filter`
            );
        }
        const set = update.$set || update;
        const unset = update.$unset || {};
        const touchesPair = mutationPaths(update).some(pathTouchesQualifiedReviewPair);
        if (updateTouchesQualifiedReviewPairOutsideSet(update)) {
            throw qualifiedGroundTruthImmutableError(
                `${operation} changing provenance or review protocol through a non-$set operator`
            );
        }
        if (filterSeedsQualifiedReviewPair(originalFilter)
            || (touchesPair && isQualifiedReviewPair(set.provenance_class, set.review_protocol))) {
            throw qualifiedGroundTruthImmutableError(`${operation} transition to qualified evidence`);
        }

        if (touchesPair) {
            // Treat provenance and review protocol as one atomic evidence claim.
            // Qualified evidence cannot be assembled by updating a legacy row;
            // it must be created atomically as a new append-only row.
            const hasCompletePair = Object.prototype.hasOwnProperty.call(set, 'provenance_class')
                && Object.prototype.hasOwnProperty.call(set, 'review_protocol')
                && !Object.keys(unset).some(pathTouchesQualifiedReviewPair);
            if (!hasCompletePair || !qualifiedReviewPairIsValid(set.provenance_class, set.review_protocol)) {
                throw qualifiedReviewValidationError(
                    'JudgeGroundTruth provenance updates require one complete, internally consistent review pair'
                );
            }
        }

        if (updateTouchesQualifiedDecisionContent(update)) {
            const matchedQualified = await this.model.exists({
                $and: [originalFilter, qualifiedReviewFilter()]
            });
            if (matchedQualified) {
                throw qualifiedGroundTruthImmutableError(`${operation} changing qualified evidence`);
            }

            // Keep the mutation fail-closed if another writer qualifies the row
            // between the pre-read and MongoDB's atomic update match.
            this.setQuery({
                $and: [originalFilter, excludesQualifiedReviewFilter()]
            });
        }
        assertQueryScoreMutationIsSafe(update, operation);
    });
}

JudgeGroundTruthSchema.pre('save', async function protectQualifiedGroundTruthOnDocumentSave() {
    if (this.isNew) {
        // `save({ validateBeforeSave: false })` must not be an escape hatch for
        // incomplete or numerically invalid decision evidence.
        await this.validate();
        assertNewGroundTruthSafety(this, 'document.save');
    }
    if (!this.isNew && this.modifiedPaths().some(pathTouchesDecisionScore)) {
        assertGroundTruthScores(this, 'document.save');
    }
    if (!this.isNew && this.isModified('judge_identity_fingerprint')) {
        throw judgeIdentityImmutableError('document.save changing judge identity');
    }
    if (this.isNew) return;

    const touchesDecisionContent = this.modifiedPaths().some(pathTouchesQualifiedDecisionContent);
    if (!touchesDecisionContent) return;

    const persisted = await this.constructor.collection.findOne(
        { _id: this._id },
        { projection: { provenance_class: 1, review_protocol: 1 } }
    );
    if (isQualifiedReviewPair(persisted?.provenance_class, persisted?.review_protocol)) {
        throw qualifiedGroundTruthImmutableError('document.save changing qualified evidence');
    }
    if (isQualifiedReviewPair(this.provenance_class, this.review_protocol)) {
        throw qualifiedGroundTruthImmutableError('document.save transition to qualified evidence');
    }

    // Mongoose includes `$where` in the atomic save predicate. This closes the
    // pre-read/save race without preventing validation-history-only saves.
    this.$where = {
        ...(this.$where || {}),
        ...excludesQualifiedReviewFilter()
    };
});

for (const operation of ['deleteOne', 'deleteMany', 'findOneAndDelete', 'findOneAndRemove']) {
    JudgeGroundTruthSchema.pre(operation, async function protectQualifiedGroundTruthOnQueryDeletion() {
        const originalFilter = this.getFilter() || {};
        const matchedQualified = await this.model.exists({
            $and: [originalFilter, qualifiedReviewFilter()]
        });
        if (matchedQualified) {
            throw qualifiedGroundTruthImmutableError(`${operation} deleting qualified evidence`);
        }
        this.setQuery({
            $and: [originalFilter, excludesQualifiedReviewFilter()]
        });
    });
}

JudgeGroundTruthSchema.pre('deleteOne', { document: true, query: false }, function blockDocumentDeletion() {
    throw qualifiedGroundTruthImmutableError('document.deleteOne is not an authorized deletion surface');
});

JudgeGroundTruthSchema.pre('aggregate', function blockGroundTruthAggregateWrites() {
    if (aggregateContainsWriteStage(this.pipeline())) {
        throw qualifiedGroundTruthImmutableError('aggregate write stage');
    }
});
JudgeGroundTruthSchema.index({ 'validation_stats.avg_deviation': 1 });

/**
 * Get active ground truth entries for validation
 */
JudgeGroundTruthSchema.statics.getForValidation = function(options = {}) {
    const query = { active: true };

    if (options.category) {
        query.category = options.category;
    }

    if (options.difficulty) {
        query.difficulty = options.difficulty;
    }

    if (options.tags && options.tags.length > 0) {
        query.tags = { $in: options.tags };
    }

    let q = this.find(query);

    if (options.limit) {
        q = q.limit(options.limit);
    }

    if (options.random) {
        // MongoDB random sampling
        return this.aggregate([
            { $match: query },
            { $sample: { size: options.limit || 10 } }
        ]);
    }

    return q.sort({ difficulty: 1, createdAt: -1 });
};

/**
 * Record a validation run result
 */
JudgeGroundTruthSchema.methods.recordValidation = async function(result) {
    const deviation = Math.abs(this.expert_scores.overall - result.judge_score);

    // Add to history (keep last 50 runs)
    this.validation_history.push({
        judge_model: result.judge_model,
        judge_score: result.judge_score,
        dimension_scores: result.dimension_scores || {},
        deviation,
        timestamp: new Date()
    });

    if (this.validation_history.length > 50) {
        this.validation_history = this.validation_history.slice(-50);
    }

    // Update aggregate stats
    const deviations = this.validation_history.map(h => h.deviation);
    this.validation_stats.total_runs = this.validation_history.length;
    this.validation_stats.avg_deviation = deviations.reduce((a, b) => a + b, 0) / deviations.length;
    this.validation_stats.max_deviation = Math.max(...deviations);
    this.validation_stats.min_deviation = Math.min(...deviations);
    this.validation_stats.last_validated = new Date();

    return this.save();
};

/**
 * Get entries with highest deviation (problematic for judge)
 */
JudgeGroundTruthSchema.statics.getHighDeviation = function(threshold = 2.0, limit = 20) {
    return this.find({
        active: true,
        'validation_stats.avg_deviation': { $gte: threshold }
    })
    .sort({ 'validation_stats.avg_deviation': -1 })
    .limit(limit);
};

/**
 * Get validation accuracy summary
 */
JudgeGroundTruthSchema.statics.getAccuracySummary = async function() {
    // Validated entries: those with at least one accuracy run
    const validated = await this.aggregate([
        { $match: { active: true, 'validation_stats.total_runs': { $gt: 0 } } },
        {
            $group: {
                _id: '$category',
                count: { $sum: 1 },
                avg_deviation: { $avg: '$validation_stats.avg_deviation' },
                max_deviation: { $max: '$validation_stats.max_deviation' },
                min_deviation: { $min: '$validation_stats.min_deviation' },
                total_runs: { $sum: '$validation_stats.total_runs' }
            }
        },
        { $sort: { avg_deviation: -1 } }
    ]);

    // Inventory: every active entry, validated or not — what the dashboard expects
    const inventory = await this.aggregate([
        { $match: { active: true } },
        { $group: { _id: '$category', count: { $sum: 1 } } },
        { $sort: { _id: 1 } }
    ]);

    const validatedByCat = new Map(validated.map(r => [r._id, r]));
    const by_category = inventory.map(inv => {
        const v = validatedByCat.get(inv._id);
        return {
            _id: inv._id,
            count: inv.count,
            validated_count: v ? v.count : 0,
            avg_deviation: v ? v.avg_deviation : null,
            max_deviation: v ? v.max_deviation : null,
            min_deviation: v ? v.min_deviation : null,
            total_runs: v ? v.total_runs : 0
        };
    });

    const validatedTotal = await this.aggregate([
        { $match: { active: true, 'validation_stats.total_runs': { $gt: 0 } } },
        {
            $group: {
                _id: null,
                validated_entries: { $sum: 1 },
                avg_deviation: { $avg: '$validation_stats.avg_deviation' },
                total_runs: { $sum: '$validation_stats.total_runs' }
            }
        }
    ]);

    const totalActive = await this.countDocuments({ active: true });

    return {
        by_category,
        overall: {
            total_entries: totalActive,
            validated_entries: validatedTotal[0]?.validated_entries || 0,
            avg_deviation: validatedTotal[0]?.avg_deviation || null,
            total_runs: validatedTotal[0]?.total_runs || 0
        }
    };
};

const JudgeGroundTruth = mongoose.models.JudgeGroundTruth
    || mongoose.model('JudgeGroundTruth', JudgeGroundTruthSchema);

const unguardedJudgeGroundTruthInsertMany = JudgeGroundTruth.insertMany.bind(JudgeGroundTruth);
JudgeGroundTruth.insertMany = async function guardedJudgeGroundTruthInsertMany(documents, options = {}) {
    if (options?.lean === true) {
        throw qualifiedReviewValidationError('insertMany lean/raw validation bypass is forbidden');
    }
    const rows = Array.isArray(documents) ? documents : [documents];
    const validatedRows = rows.map(row => (
        row instanceof JudgeGroundTruth ? row : new JudgeGroundTruth(row)
    ));
    for (const row of validatedRows) {
        await row.validate();
        assertNewGroundTruthSafety(row, 'insertMany');
    }
    return unguardedJudgeGroundTruthInsertMany(validatedRows, {
        ...options,
        lean: false
    });
};

JudgeGroundTruth.bulkWrite = async function blockedJudgeGroundTruthBulkWrite() {
    throw judgeIdentityImmutableError('bulkWrite is not allowed');
};

JudgeGroundTruth.JUDGE_IDENTITY_IMMUTABLE_ERROR_CODE = JUDGE_IDENTITY_IMMUTABLE_ERROR_CODE;
JudgeGroundTruth.QUALIFIED_IMMUTABLE_ERROR_CODE = QUALIFIED_JUDGE_GROUND_TRUTH_IMMUTABLE_ERROR_CODE;

module.exports = JudgeGroundTruth;
