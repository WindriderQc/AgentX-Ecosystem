/**
 * CalibrationBaseline Model
 *
 * Stores per-category Pearson ρ (judge_score vs human_score) baselines from a
 * 0128-style human-validation sprint. Used by the drift detector to compare
 * current rolling ρ against the last ratified baseline.
 *
 * Baselines are NEVER auto-updated. A new baseline only lands when a sprint
 * explicitly ratifies one (via POST /api/benchmark/drift/baseline).
 */

const mongoose = require('mongoose');

const JUDGE_IDENTITY_FINGERPRINT_PATTERN = /^[0-9a-f]{64}$/;
const CALIBRATION_CATEGORIES = Object.freeze([
    'coding', 'reasoning', 'math', 'knowledge', 'instruction', 'creative', 'translation'
]);
const MIN_CATEGORY_SAMPLE_SIZE = 5;
const JUDGE_IDENTITY_IMMUTABLE_ERROR_CODE = 'JUDGE_IDENTITY_FINGERPRINT_IMMUTABLE';
const CALIBRATION_BASELINE_STATE_IMMUTABLE_ERROR_CODE = 'CALIBRATION_BASELINE_STATE_IMMUTABLE';
const CALIBRATION_BASELINE_CONTENT_IMMUTABLE_ERROR_CODE = 'CALIBRATION_BASELINE_CONTENT_IMMUTABLE';
const CALIBRATION_BASELINE_IDENTITY_MISMATCH_ERROR_CODE = 'CALIBRATION_BASELINE_IDENTITY_MISMATCH';
const CALIBRATION_BASELINE_CONFLICT_ERROR_CODE = 'CALIBRATION_BASELINE_CONFLICT';
const PROTECTED_RATIFICATION_PATHS = new Set([
    'active',
    'active_slot',
    'identity_active_slot'
]);
const IMMUTABLE_CONTENT_PATHS = new Set([
    'label',
    'source_sprint',
    'overall_rho',
    'overall_sample_size',
    'categories',
    'notes'
]);

function judgeIdentityImmutableError(operation) {
    const detail = operation.includes('not allowed') ? operation : `${operation} is forbidden`;
    const error = new Error(`judge_identity_fingerprint is immutable; ${detail}`);
    error.code = JUDGE_IDENTITY_IMMUTABLE_ERROR_CODE;
    error.statusCode = 409;
    return error;
}

function calibrationBaselineStateImmutableError(operation) {
    const error = new Error(`calibration baseline ratification state is immutable; ${operation} is forbidden`);
    error.code = CALIBRATION_BASELINE_STATE_IMMUTABLE_ERROR_CODE;
    error.statusCode = 409;
    return error;
}

function calibrationBaselineContentImmutableError(operation) {
    const error = new Error(`calibration baseline content is append-only; ${operation} is forbidden`);
    error.code = CALIBRATION_BASELINE_CONTENT_IMMUTABLE_ERROR_CODE;
    error.statusCode = 409;
    return error;
}

function calibrationBaselineIdentityMismatchError() {
    const error = new Error('calibration baseline label belongs to a different judge identity');
    error.code = CALIBRATION_BASELINE_IDENTITY_MISMATCH_ERROR_CODE;
    error.statusCode = 409;
    return error;
}

function calibrationBaselineConflictError(message) {
    const error = new Error(message);
    error.code = CALIBRATION_BASELINE_CONFLICT_ERROR_CODE;
    error.statusCode = 409;
    return error;
}

function pathTouchesProtectedRatificationState(path) {
    return [...PROTECTED_RATIFICATION_PATHS].some(protectedPath => (
        path === protectedPath || path.startsWith(`${protectedPath}.`)
    ));
}

function pathTouchesImmutableContent(path) {
    return [...IMMUTABLE_CONTENT_PATHS].some(protectedPath => (
        path === protectedPath || path.startsWith(`${protectedPath}.`)
    ));
}

function updateTouchesProtectedRatificationState(update) {
    const directPaths = Object.keys(update).filter(key => !key.startsWith('$'));
    const operatorPaths = Object.entries(update)
        .filter(([key, value]) => key.startsWith('$')
            && value && typeof value === 'object' && !Array.isArray(value))
        .flatMap(([, value]) => Object.keys(value));
    const renamePaths = Object.entries(update.$rename || {}).flatMap(([from, to]) => [from, to]);
    return [...directPaths, ...operatorPaths, ...renamePaths]
        .some(pathTouchesProtectedRatificationState);
}

function updateTouchesImmutableContent(update) {
    const directPaths = Object.keys(update).filter(key => !key.startsWith('$'));
    const operatorPaths = Object.entries(update)
        .filter(([key, value]) => key !== '$setOnInsert' && key.startsWith('$')
            && value && typeof value === 'object' && !Array.isArray(value))
        .flatMap(([, value]) => Object.keys(value));
    const renamePaths = Object.entries(update.$rename || {}).flatMap(([from, to]) => [from, to]);
    return [...directPaths, ...operatorPaths, ...renamePaths]
        .some(pathTouchesImmutableContent);
}

function inputSuppliesProtectedRatificationState(document) {
    if (!document || typeof document !== 'object') return false;
    if (document instanceof mongoose.Document) {
        return !document.$isDefault('active')
            || document.active_slot !== undefined
            || document.identity_active_slot !== undefined;
    }
    return [...PROTECTED_RATIFICATION_PATHS]
        .some(path => Object.prototype.hasOwnProperty.call(document, path));
}

function filterTouchesProtectedRatificationState(filter) {
    if (Array.isArray(filter)) {
        return filter.some(filterTouchesProtectedRatificationState);
    }
    if (!filter || typeof filter !== 'object') return false;
    return Object.entries(filter).some(([path, value]) => (
        pathTouchesProtectedRatificationState(path)
        || filterTouchesProtectedRatificationState(value)
    ));
}

function normalizeImmutableBaselineContent(document) {
    return {
        label: document.label,
        judge_identity_fingerprint: document.judge_identity_fingerprint,
        source_sprint: document.source_sprint ?? null,
        overall_rho: document.overall_rho ?? null,
        overall_sample_size: document.overall_sample_size ?? 0,
        categories: (document.categories || []).map(category => ({
            category: category.category,
            rho: category.rho,
            sample_size: category.sample_size,
            mae: category.mae ?? null,
            bias: category.bias ?? null
        })),
        notes: document.notes ?? null
    };
}

function baselineContentsMatch(left, right) {
    return JSON.stringify(normalizeImmutableBaselineContent(left))
        === JSON.stringify(normalizeImmutableBaselineContent(right));
}

function aggregateContainsWriteStage(value) {
    if (Array.isArray(value)) return value.some(aggregateContainsWriteStage);
    if (!value || typeof value !== 'object') return false;
    return Object.entries(value).some(([key, entry]) => (
        key === '$merge' || key === '$out' || aggregateContainsWriteStage(entry)
    ));
}

function filterBindsExactJudgeIdentity(filter, fingerprint) {
    if (!filter || typeof filter !== 'object' || Array.isArray(filter)) return false;
    if (filter.judge_identity_fingerprint === fingerprint) return true;
    return Array.isArray(filter.$and)
        && filter.$and.some(entry => filterBindsExactJudgeIdentity(entry, fingerprint));
}

function finiteCorrelationOrNull(value) {
    return value === null || value === undefined
        || (Number.isFinite(value) && value >= -1 && value <= 1);
}

function finiteMetricOrNull(value) {
    return value === null || value === undefined || Number.isFinite(value);
}

function finiteNonNegativeMetricOrNull(value) {
    return value === null || value === undefined || (Number.isFinite(value) && value >= 0);
}

function nonNegativeSafeInteger(value) {
    return Number.isSafeInteger(value) && value >= 0;
}

function categorySampleSizeIsValid(value) {
    return Number.isSafeInteger(value) && value >= MIN_CATEGORY_SAMPLE_SIZE;
}

function categoriesAreUniqueAndKnown(categories) {
    if (!Array.isArray(categories)) return false;
    const names = categories.map(row => row?.category);
    return names.every(name => CALIBRATION_CATEGORIES.includes(name))
        && new Set(names).size === names.length;
}

function assertDraftBaselineMetrics(document, operation) {
    if (typeof document.label !== 'string' || document.label.trim().length === 0
        || (document.judge_identity_fingerprint !== null
            && document.judge_identity_fingerprint !== undefined
            && !JUDGE_IDENTITY_FINGERPRINT_PATTERN.test(document.judge_identity_fingerprint))
        || !finiteCorrelationOrNull(document.overall_rho)
        || !nonNegativeSafeInteger(document.overall_sample_size)
        || !categoriesAreUniqueAndKnown(document.categories)
        || document.categories.some(row => (
            !finiteCorrelationOrNull(row.rho)
            || row.rho === null
            || row.rho === undefined
            || !categorySampleSizeIsValid(row.sample_size)
            || !finiteNonNegativeMetricOrNull(row.mae)
            || !finiteMetricOrNull(row.bias)
        ))) {
        const error = new mongoose.Error.ValidationError();
        error.addError('categories', new mongoose.Error.ValidatorError({
            path: 'categories',
            message: `${operation} baseline metrics must be finite, bounded, uniquely categorized, and carry valid sample sizes`
        }));
        throw error;
    }
}

function ratifiableBaselineContractIsValid(document) {
    if (!finiteCorrelationOrNull(document.overall_rho) || document.overall_rho === null
        || document.overall_rho === undefined) return false;
    if (!categoriesAreUniqueAndKnown(document.categories)) return false;
    const names = new Set(document.categories.map(row => row.category));
    if (names.size !== CALIBRATION_CATEGORIES.length
        || CALIBRATION_CATEGORIES.some(category => !names.has(category))) return false;
    if (document.categories.some(row => !categorySampleSizeIsValid(row.sample_size))) return false;
    const expectedOverallSampleSize = document.categories
        .reduce((total, row) => total + row.sample_size, 0);
    return nonNegativeSafeInteger(document.overall_sample_size)
        && document.overall_sample_size === expectedOverallSampleSize;
}

function invalidRatifiableBaselineError() {
    const error = new mongoose.Error.ValidationError();
    error.addError('categories', new mongoose.Error.ValidatorError({
        path: 'categories',
        message: 'ratified baseline requires exactly one known category row each, finite rho values, category sample sizes >= 5, and overall_sample_size equal to their sum'
    }));
    return error;
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

const PerCategoryBaselineSchema = new mongoose.Schema({
    category: { type: String, required: true, enum: CALIBRATION_CATEGORIES },
    rho: {
        type: Number,
        required: true,
        min: -1,
        max: 1,
        validate: {
            validator: value => value !== null && value !== undefined && finiteCorrelationOrNull(value),
            message: 'category rho must be finite and between -1 and 1'
        }
    },
    sample_size: {
        type: Number,
        required: true,
        min: MIN_CATEGORY_SAMPLE_SIZE,
        validate: {
            validator: categorySampleSizeIsValid,
            message: 'category sample_size must be a safe integer of at least 5'
        }
    },
    mae: {
        type: Number,
        default: null,
        min: 0,
        validate: {
            validator: finiteNonNegativeMetricOrNull,
            message: 'category mae must be finite and non-negative'
        }
    },
    bias: {
        type: Number,
        default: null,
        validate: {
            validator: finiteMetricOrNull,
            message: 'category bias must be finite'
        }
    }
}, { _id: false });

const CalibrationBaselineSchema = new mongoose.Schema({
    // Human-friendly label, e.g. '0128-r7-2026-04-22'
    label: {
        type: String,
        required: true,
        immutable: true,
        unique: true,
        index: true
    },

    // A baseline is meaningful only for the exact judge identity that
    // produced it. Legacy baselines without this field remain readable but
    // cannot be selected by the identity-scoped drift service.
    judge_identity_fingerprint: {
        type: String,
        default: null,
        immutable: true,
        match: JUDGE_IDENTITY_FINGERPRINT_PATTERN,
        index: true
    },

    // Overall ρ across all categories (for dashboard summary)
    overall_rho: {
        type: Number,
        default: null,
        immutable: true,
        min: -1,
        max: 1,
        validate: {
            validator: finiteCorrelationOrNull,
            message: 'overall_rho must be finite and between -1 and 1'
        }
    },
    overall_sample_size: {
        type: Number,
        default: 0,
        immutable: true,
        min: 0,
        validate: {
            validator: nonNegativeSafeInteger,
            message: 'overall_sample_size must be a non-negative safe integer'
        }
    },

    // Per-category breakdown
    categories: {
        type: [PerCategoryBaselineSchema],
        default: [],
        immutable: true,
        validate: {
            validator: categoriesAreUniqueAndKnown,
            message: 'baseline categories must be known and unique'
        }
    },

    // Sprint / source metadata
    source_sprint: { type: String, default: null, immutable: true }, // e.g. 'human-validation-sprint-2026-04-22-r7'
    notes: { type: String, default: null, immutable: true },

    // Whether this is the currently ratified baseline to compare against
    active: {
        type: Boolean,
        default: false,
        immutable: true,
        index: true
    },

    // Legacy constant-valued slot retained for backwards compatibility.
    // New exact-identity baselines use `identity_active_slot` below.
    active_slot: {
        type: String,
        enum: ['active'],
        default: undefined,
        immutable: true
    },

    // New identity-scoped ratifications use one unique slot per exact judge.
    // The legacy `active_slot` remains readable so existing documents and
    // indexes do not need an unsafe in-place rewrite.
    identity_active_slot: {
        type: String,
        default: undefined,
        immutable: true,
        match: JUDGE_IDENTITY_FINGERPRINT_PATTERN
    }
}, {
    timestamps: true
});

CalibrationBaselineSchema.index({ active: 1, createdAt: -1 });
CalibrationBaselineSchema.index({ judge_identity_fingerprint: 1, active: 1, createdAt: -1 });
CalibrationBaselineSchema.index(
    { active_slot: 1 },
    {
        unique: true,
        partialFilterExpression: { active_slot: 'active' },
        name: 'uniq_active_calibration_baseline'
    }
);
CalibrationBaselineSchema.index(
    { identity_active_slot: 1 },
    {
        unique: true,
        partialFilterExpression: { identity_active_slot: { $type: 'string' } },
        name: 'uniq_active_calibration_baseline_by_identity'
    }
);

for (const operation of ['updateOne', 'updateMany', 'findOneAndUpdate', 'findOneAndReplace', 'replaceOne']) {
    CalibrationBaselineSchema.pre(operation, function protectCalibrationBaselineOnQueryMutation() {
        const update = this.getUpdate() || {};
        if (operation === 'replaceOne' || operation === 'findOneAndReplace') {
            throw judgeIdentityImmutableError(operation);
        }
        if (Array.isArray(update)) {
            throw judgeIdentityImmutableError(`update pipelines are not allowed; ${operation} pipeline`);
        }
        if (this.getOptions().upsert
            && filterTouchesProtectedRatificationState(this.getFilter())) {
            throw calibrationBaselineStateImmutableError(`${operation} upsert with ratification state in filter`);
        }
        if (updateTouchesProtectedRatificationState(update)) {
            throw calibrationBaselineStateImmutableError(`${operation} changing ratification state`);
        }
        if (updateTouchesImmutableContent(update)) {
            throw calibrationBaselineContentImmutableError(`${operation} changing baseline content`);
        }
        if (updateTouchesJudgeIdentity(update)) {
            throw judgeIdentityImmutableError(`${operation} changing judge identity`);
        }
        if (Object.prototype.hasOwnProperty.call(update.$setOnInsert || {}, 'judge_identity_fingerprint')) {
            const insertedIdentity = update.$setOnInsert.judge_identity_fingerprint;
            if (!filterBindsExactJudgeIdentity(this.getFilter(), insertedIdentity)) {
                throw judgeIdentityImmutableError(`${operation} with unbound judge identity insert`);
            }
        }
        if (this.getOptions().upsert) {
            throw calibrationBaselineContentImmutableError(
                `${operation} ordinary upsert; use the controlled ratification authority`
            );
        }
    });
}

for (const operation of ['deleteOne', 'deleteMany', 'findOneAndDelete', 'findOneAndRemove']) {
    CalibrationBaselineSchema.pre(operation, function blockCalibrationBaselineQueryDeletion() {
        throw calibrationBaselineStateImmutableError(`${operation} deletion`);
    });
}

CalibrationBaselineSchema.pre('deleteOne', { document: true, query: false }, function blockCalibrationBaselineDocumentDeletion() {
    throw calibrationBaselineStateImmutableError('document.deleteOne deletion');
});

CalibrationBaselineSchema.pre('aggregate', function blockCalibrationBaselineAggregateWrites() {
    if (aggregateContainsWriteStage(this.pipeline())) {
        throw calibrationBaselineStateImmutableError('aggregate write stage');
    }
});

CalibrationBaselineSchema.pre('save', async function protectJudgeIdentityOnDocumentSave() {
    if (this.isNew) {
        await this.validate();
        assertDraftBaselineMetrics(this, 'document.save');
    }
    if (this.isNew) {
        if (!this.$isDefault('active')
            || this.active_slot !== undefined
            || this.identity_active_slot !== undefined) {
            throw calibrationBaselineStateImmutableError('document creation with caller-supplied ratification state');
        }
    } else if ([...PROTECTED_RATIFICATION_PATHS].some(path => this.isModified(path))) {
        throw calibrationBaselineStateImmutableError('document.save changing ratification state');
    }
    if (!this.isNew && this.modifiedPaths().some(pathTouchesImmutableContent)) {
        throw calibrationBaselineContentImmutableError('document.save changing baseline content');
    }
    if (!this.isNew && this.isModified('judge_identity_fingerprint')) {
        throw judgeIdentityImmutableError('document.save changing judge identity');
    }
});

/**
 * Get the currently active baseline (most recently ratified).
 */
CalibrationBaselineSchema.statics.getActive = async function(judgeIdentityFingerprint) {
    if (!JUDGE_IDENTITY_FINGERPRINT_PATTERN.test(judgeIdentityFingerprint || '')) {
        const error = new Error('judge_identity_fingerprint must be a 64-character lowercase SHA-256 fingerprint');
        error.code = 'INVALID_JUDGE_IDENTITY_FINGERPRINT';
        error.statusCode = 400;
        throw error;
    }

    await this.init();
    const candidates = await this.find({
        $or: [
            { judge_identity_fingerprint: judgeIdentityFingerprint, active: true },
            { judge_identity_fingerprint: judgeIdentityFingerprint, identity_active_slot: { $exists: true } },
            { judge_identity_fingerprint: judgeIdentityFingerprint, active_slot: { $exists: true } },
            { identity_active_slot: judgeIdentityFingerprint }
        ]
    }).lean();

    if (candidates.length === 0) return null;
    const canonical = candidates.filter(candidate => (
        candidate.active === true
        && candidate.judge_identity_fingerprint === judgeIdentityFingerprint
        && candidate.identity_active_slot === judgeIdentityFingerprint
        && candidate.active_slot === undefined
    ));
    if (candidates.length !== 1 || canonical.length !== 1) {
        throw calibrationBaselineConflictError(
            'active calibration baseline state is missing, duplicated, or inconsistent for the exact judge identity'
        );
    }
    return canonical[0];
};

/**
 * The sole model-authorized ratification transition. Ordinary Mongoose writes
 * cannot mutate the three protected state fields; this method uses the raw
 * collection internally so no caller-provided option can forge authority.
 */
CalibrationBaselineSchema.statics.ratifyExactIdentity = async function(input) {
    const label = input?.label;
    const judgeIdentityFingerprint = input?.judge_identity_fingerprint;
    if (!label) throw new Error('label required');
    if (!Array.isArray(input.categories)) throw new Error('categories[] required');
    if (!JUDGE_IDENTITY_FINGERPRINT_PATTERN.test(judgeIdentityFingerprint || '')) {
        const error = new Error('judge_identity_fingerprint must be a 64-character lowercase SHA-256 fingerprint');
        error.code = 'INVALID_JUDGE_IDENTITY_FINGERPRINT';
        error.statusCode = 400;
        throw error;
    }

    const candidate = new this({
        label,
        judge_identity_fingerprint: judgeIdentityFingerprint,
        source_sprint: input.source_sprint || null,
        overall_rho: input.overall_rho ?? null,
        overall_sample_size: input.overall_sample_size ?? 0,
        categories: input.categories,
        notes: input.notes || null
    });
    await candidate.validate();
    if (!ratifiableBaselineContractIsValid(candidate)) {
        throw invalidRatifiableBaselineError();
    }
    // Unique-index readiness is part of the authorization boundary: no raw
    // ratification write may run before the identity-scoped slot exists.
    await this.init();
    const validated = candidate.toObject({ depopulate: true, versionKey: false });
    const content = {
        label: validated.label,
        judge_identity_fingerprint: validated.judge_identity_fingerprint,
        source_sprint: validated.source_sprint,
        overall_rho: validated.overall_rho,
        overall_sample_size: validated.overall_sample_size,
        categories: validated.categories,
        notes: validated.notes
    };

    const existing = await this.collection.findOne({ label });
    if (existing && existing.judge_identity_fingerprint !== judgeIdentityFingerprint) {
        throw calibrationBaselineIdentityMismatchError();
    }
    if (existing && !baselineContentsMatch(existing, content)) {
        throw calibrationBaselineConflictError(
            'calibration baseline content is append-only for an existing label'
        );
    }
    if (existing?.active === true
        && existing.identity_active_slot === judgeIdentityFingerprint
        && existing.active_slot === undefined) {
        const canonical = await this.getActive(judgeIdentityFingerprint);
        if (!canonical || String(canonical._id) !== String(existing._id)) {
            throw calibrationBaselineConflictError(
                'active calibration baseline changed during exact replay'
            );
        }
        return canonical;
    }

    const materializedAt = new Date();
    try {
        await this.collection.updateOne(
            {
                label,
                judge_identity_fingerprint: judgeIdentityFingerprint
            },
            {
                $setOnInsert: {
                    ...content,
                    active: false,
                    createdAt: materializedAt,
                    updatedAt: materializedAt
                }
            },
            { upsert: true }
        );
    } catch (error) {
        if (error?.code !== 11000) throw error;
        const conflict = await this.collection.findOne(
            { label },
            { projection: { judge_identity_fingerprint: 1 } }
        );
        if (conflict && conflict.judge_identity_fingerprint !== judgeIdentityFingerprint) {
            throw calibrationBaselineIdentityMismatchError();
        }
        throw calibrationBaselineConflictError(
            'another calibration baseline won concurrent materialization'
        );
    }

    const target = await this.collection.findOne({
        label,
        judge_identity_fingerprint: judgeIdentityFingerprint
    });
    if (!target) {
        throw calibrationBaselineConflictError('calibration baseline materialization was not durable');
    }
    if (!baselineContentsMatch(target, content)) {
        throw calibrationBaselineConflictError(
            'calibration baseline content lost a concurrent append-only race'
        );
    }
    if (target.active === true
        && target.identity_active_slot === judgeIdentityFingerprint
        && target.active_slot === undefined) {
        const canonical = await this.getActive(judgeIdentityFingerprint);
        if (!canonical || String(canonical._id) !== String(target._id)) {
            throw calibrationBaselineConflictError(
                'active calibration baseline changed during concurrent ratification'
            );
        }
        return canonical;
    }

    const ratifiedAt = new Date();
    await this.collection.updateMany(
        {
            _id: { $ne: target._id },
            active: true,
            judge_identity_fingerprint: judgeIdentityFingerprint
        },
        {
            $set: { active: false, updatedAt: ratifiedAt },
            $unset: { active_slot: '', identity_active_slot: '' }
        }
    );

    try {
        const activation = await this.collection.updateOne(
            {
                _id: target._id,
                judge_identity_fingerprint: judgeIdentityFingerprint
            },
            {
                $set: {
                    active: true,
                    identity_active_slot: judgeIdentityFingerprint,
                    updatedAt: ratifiedAt
                },
                $unset: { active_slot: '' }
            }
        );
        if (activation.matchedCount !== 1) {
            throw calibrationBaselineConflictError('calibration baseline activation lost its identity guard');
        }
    } catch (error) {
        if (error?.code !== 11000) throw error;
        throw calibrationBaselineConflictError(
            'another calibration baseline won concurrent ratification'
        );
    }

    const canonical = await this.getActive(judgeIdentityFingerprint);
    if (!canonical || String(canonical._id) !== String(target._id)) {
        throw calibrationBaselineConflictError(
            'calibration baseline activation did not remain canonical after ratification'
        );
    }
    return canonical;
};

const CalibrationBaseline = mongoose.models.CalibrationBaseline
    || mongoose.model('CalibrationBaseline', CalibrationBaselineSchema);

CalibrationBaseline.bulkWrite = async function blockedCalibrationBaselineBulkWrite() {
    throw calibrationBaselineStateImmutableError('bulkWrite');
};

const unguardedCalibrationBaselineInsertMany = CalibrationBaseline.insertMany.bind(CalibrationBaseline);
CalibrationBaseline.insertMany = async function guardedCalibrationBaselineInsertMany(documents, options) {
    const rows = Array.isArray(documents) ? documents : [documents];
    if (rows.some(inputSuppliesProtectedRatificationState)) {
        throw calibrationBaselineStateImmutableError('insertMany with caller-supplied ratification state');
    }
    if (options?.lean === true) {
        throw calibrationBaselineContentImmutableError('insertMany lean/raw validation bypass');
    }
    const validatedRows = rows.map(row => (
        row instanceof CalibrationBaseline ? row : new CalibrationBaseline(row)
    ));
    for (const row of validatedRows) {
        await row.validate();
        assertDraftBaselineMetrics(row, 'insertMany');
    }
    return unguardedCalibrationBaselineInsertMany(validatedRows, {
        ...options,
        lean: false
    });
};

CalibrationBaseline.JUDGE_IDENTITY_IMMUTABLE_ERROR_CODE = JUDGE_IDENTITY_IMMUTABLE_ERROR_CODE;
CalibrationBaseline.STATE_IMMUTABLE_ERROR_CODE = CALIBRATION_BASELINE_STATE_IMMUTABLE_ERROR_CODE;
CalibrationBaseline.CONTENT_IMMUTABLE_ERROR_CODE = CALIBRATION_BASELINE_CONTENT_IMMUTABLE_ERROR_CODE;

module.exports = CalibrationBaseline;
