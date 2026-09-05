/**
 * BenchmarkBatch Model
 * Batch test execution tracking with progress monitoring
 */

const mongoose = require('mongoose');
const {
    buildIdleCurrentTest,
    buildJudgeableFilter,
    deriveTerminalBatchStatus,
    deriveTerminalBatchOutcome,
    deriveTerminalJudgeStatus
} = require('../src/services/benchmark/batchHelpers');
const {
    TRUST_BATCH_ID_PATTERN,
    createTrustBatchId
} = require('../src/services/benchmark/trustBatchIdentity');

const BenchmarkBatchSchema = new mongoose.Schema({
    // Configuration
    run_name: {
        type: String,
        required: true
    },
    host: {
        type: String,
        required: true,
        default: 'harness'
    },
    models: {
        type: [String],
        required: true,
        validate: {
            validator: function(v) {
                return Array.isArray(v) && v.length > 0;
            },
            message: 'At least one model is required'
        }
    },
    // Provider-neutral execution targets. Legacy batches omit this field and
    // continue to use host + models; new launches persist the normalized
    // BenchmarkTarget v1 objects selected from Ollama or the optional broker.
    targets: {
        type: [mongoose.Schema.Types.Mixed],
        default: []
    },
    campaign_kind: {
        type: String,
        enum: ['model', 'native_agent'],
        default: 'model',
        index: true
    },
    spend_grant: {
        type: mongoose.Schema.Types.Mixed,
        default: null,
        select: false
    },
    quality_cohort_fingerprint: {
        type: String,
        default: null,
        index: true
    },
    batch_contract_fingerprint: {
        type: String,
        default: null,
        index: true
    },
    levels: {
        type: [Number],
        required: true,
        validate: {
            validator: function(v) {
                return Array.isArray(v) && v.length > 0 && v.every(l => l >= 1 && l <= 5);
            },
            message: 'Levels must be between 1 and 5'
        }
    },
    prompt_ids: {
        type: [String],
        default: []
    },
    judge_config: {
        type: Object,
        default: {}
    },
    execution_config: {
        type: Object,
        default: {}
    },
    // Portable receipts bind this opaque immutable identifier, never the
    // MongoDB primary key. Legacy batches receive one only through an explicit
    // migration; every newly created batch gets one at construction time.
    trust_batch_id: {
        type: String,
        immutable: true,
        default: createTrustBatchId,
        match: TRUST_BATCH_ID_PATTERN
    },
    // Content-addressed launch authority. A strict CampaignSpec is consumable
    // exactly once, including when preregistration fails after reservation.
    trust_campaign_spec_id: {
        type: String,
        immutable: true,
        default: null,
        match: /^[0-9a-f]{64}$/
    },
    // Immutable campaign-level inference contract. Resolved once after the
    // benchmark host claim/preflight and reused across every attempt/resume.
    inference_contract_campaign: {
        type: mongoose.Schema.Types.Mixed,
        default: null
    },
    // Product-owned, private source context for BenchmarkTrustReceipt issuance.
    // It is written only by the strict campaign launcher after it freezes every
    // identity and policy before execution. Legacy batches intentionally keep
    // this null and are therefore not eligible for trust-receipt issuance.
    trust_evidence_context: {
        type: mongoose.Schema.Types.Mixed,
        default: null,
        select: false
    },
    // Set only by commitTrustEvidenceContext() while the batch is still
    // pending and empty. This server timestamp, not any caller-supplied date,
    // proves that preregistration preceded execution.
    trust_evidence_committed_at: {
        type: Date,
        default: null,
        select: false
    },
    // Set by finalizeTrustEvidenceBatch() in the same server-owned transition
    // as completed_at. Its presence closes every later model mutation path.
    trust_evidence_finalized_at: {
        type: Date,
        default: null,
        immutable: true,
        select: false
    },
    execution_mode: {
        type: String,
        enum: ['latency', 'throughput'],
        default: 'latency'
    },
    depth_config: {
        type: Object,
        default: null
    },

    // Execution Plan
    plan: {
        exec_hosts: [{
            exec_host: String,
            judge_host: String,
            models: [String],
            tests: Number
        }],
        judge_model: String,
        execution_config: {
            type: Object,
            default: {}
        },
        total_models: Number,
        total_prompts: Number,
        categories: [{
            category: String,
            prompt_count: Number,
            tests: Number
        }]
    },

    // Progress Tracking
    status: {
        type: String,
        enum: ['pending', 'running', 'judging', 'completed', 'failed', 'stopped', 'interrupted'],
        default: 'pending',
        index: true
    },
    // Captured when a batch lands in a terminal failure status. Null otherwise.
    // Populated by markAsCompleted(status, reason) at batch finalization (0209).
    // Known values: 'zero_cells_executed' | 'incomplete_cells' | 'high_failure_rate' | null.
    failure_reason: {
        type: String,
        default: null
    },
    // Singleton slot used to enforce one active benchmark batch at a time.
    // Combined with a partial unique index on active statuses to close race windows.
    active_slot: {
        type: String,
        default: null
    },
    judge_status: {
        type: String,
        enum: ['none', 'pending', 'running', 'completed', 'failed', 'stopped'],
        default: 'none',
        index: true
    },
    total_tests: {
        type: Number,
        required: true,
        min: 0
    },
    completed: {
        type: Number,
        default: 0,
        min: 0
    },
    failed: {
        type: Number,
        default: 0,
        min: 0
    },
    judge_total: {
        type: Number,
        default: 0,
        min: 0
    },
    judge_completed: {
        type: Number,
        default: 0,
        min: 0
    },
    judge_failed: {
        type: Number,
        default: 0,
        min: 0
    },

    // Result Summaries (for quick access)
    results: [{
        model: String,
        host: String,
        judge_host: String,
        prompt_name: String,
        success: Boolean,
        latency: Number,
        error: String,
        response_preview: String
    }],

    // Checkpoint — completed model+prompt keys for resumability
    checkpoint: {
        completed_pairs: { type: [String], default: [] },   // ["model::prompt_name", ...]
        last_model: { type: String, default: null },
        last_prompt: { type: String, default: null },
        updated_at: { type: Date, default: null }
    },

    // Timestamps
    created_at: {
        type: Date,
        default: Date.now,
        index: true
    },
    started_at: {
        type: Date,
        default: null
    },
    execution_started_at: {
        type: Date,
        default: null
    },
    generated_at: {
        type: Date,
        default: null
    },
    completed_at: {
        type: Date,
        default: null
    },

    // Execution metadata
    execution_pid: {
        type: Number,
        default: null
    },
    last_activity_at: {
        type: Date,
        default: null,
        index: true
    },

    // Current test being executed (for real-time visibility)
    current_test: {
        model: { type: String, default: null },
        prompt_id: { type: String, default: null },
        prompt_name: { type: String, default: null },
        prompt_level: { type: Number, default: null },
        prompt_category: { type: String, default: null },
        prompt_text: { type: String, default: null },
        stage: { type: String, enum: ['executing', 'responded', 'judging', 'idle', 'warmup'], default: 'idle' },
        // High-level pipeline phase for UI visibility during pre-test work
        // (preflight/profiling/dedication/claiming/baseline/warmup/judge_warmup/executing/judging).
        // Distinct from `stage` which describes the per-prompt micro-state.
        phase: { type: String, default: null },
        phase_detail: { type: String, default: null },
        started_at: { type: Date, default: null },
        test_number: { type: Number, default: null },
        response_preview: { type: String, default: null },
        latency: { type: Number, default: null },
        tokens: { type: Number, default: null },
        tokens_per_sec: { type: Number, default: null },
        time_to_first_token_ms: { type: Number, default: null },
        prompt_eval_duration_ms: { type: Number, default: null }
    },

    // Detailed execution metrics
    execution_metrics: {
        total_duration_ms: { type: Number, default: null },
        generation_duration_ms: { type: Number, default: null },
        judging_duration_ms: { type: Number, default: null },
        avg_test_duration_ms: { type: Number, default: null },
        avg_judge_duration_ms: { type: Number, default: null },
        tests_per_minute: { type: Number, default: null },
        peak_memory_mb: { type: Number, default: null },
        total_tokens_generated: { type: Number, default: 0 },
        total_tokens_per_sec_avg: { type: Number, default: null }
    },

    // Per-model wall-clock timing (how long each model took to run all prompts)
    model_timings: {
        type: [{
            model: { type: String, required: true },
            started_at: { type: Date, default: null },
            completed_at: { type: Date, default: null },
            duration_ms: { type: Number, default: null },
            early_stopped: { type: Boolean, default: false },
            early_stop_reason: { type: String, default: null },
            early_stop_avg_score: { type: Number, default: null },
            early_stop_judged_count: { type: Number, default: null }
        }],
        default: []
    },

    // Benchmark-owned performance baselines captured per (model, host)
    performance_baselines: {
        type: [{
            model: { type: String, required: true },
            host: { type: String, required: true },
            hostId: { type: String, default: null },
            status: { type: String, default: 'pass' },
            source: { type: String, default: 'benchmark_host_test' },
            persistenceReceipt: { type: String, default: null },
            tokensPerSec: { type: Number, default: null },
            promptEvalTokensPerSec: { type: Number, default: null },
            latencyMs: { type: Number, default: null },
            timeToFirstTokenMs: { type: Number, default: null },
            ttftMeasurement: { type: String, enum: ['streamed_wall_clock'], default: undefined },
            vramUsedMiB: { type: Number, default: null },
            vramTotalMiB: { type: Number, default: null },
            numCtx: { type: Number, default: null },
            numCtxSource: { type: String, default: null },
            testedAt: { type: Date, default: null },
            error: { type: String, default: null }
        }],
        default: []
    },

    // Configuration snapshot (for reproducibility)
    config_snapshot: {
        ollama_version: String,
        agentx_version: String,
        node_version: String,
        os_platform: String,
        cpu_count: Number
    },

    // Tags for categorization
    tags: {
        type: [String],
        default: [],
        index: true
    },

    // Notes/description
    description: {
        type: String,
        default: ''
    },
    // Set only by the Product Trust finalizer (or the receipt store's
    // fail-closed compatibility seal path) through raw internal CAS writes.
    // A sealed batch is immutable evidence; corrections require a new batch.
    trust_evidence_sealed: {
        type: Boolean,
        default: false,
        immutable: true,
        index: true
    }
}, {
    timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' }
});

// Indexes
BenchmarkBatchSchema.index({ status: 1, created_at: -1 });
BenchmarkBatchSchema.index({ execution_started_at: 1 });
BenchmarkBatchSchema.index({ 'models': 1 });
BenchmarkBatchSchema.index({ trust_batch_id: 1, trust_evidence_sealed: 1 });
BenchmarkBatchSchema.index(
    { trust_batch_id: 1 },
    {
        unique: true,
        partialFilterExpression: { trust_batch_id: { $type: 'string' } },
        name: 'uniq_benchmark_batch_trust_batch_id'
    }
);
BenchmarkBatchSchema.index(
    { trust_campaign_spec_id: 1 },
    {
        unique: true,
        partialFilterExpression: { trust_campaign_spec_id: { $type: 'string' } },
        name: 'uniq_benchmark_batch_trust_campaign_spec_id'
    }
);
BenchmarkBatchSchema.index(
    { active_slot: 1 },
    {
        unique: true,
        partialFilterExpression: {
            active_slot: { $type: 'string' },
            $or: [
                { status: { $in: ['running', 'judging'] } },
                { judge_status: 'running' }
            ]
        }
    }
);

// Virtual for progress percentage
BenchmarkBatchSchema.virtual('progress').get(function() {
    if (this.total_tests === 0) return 0;
    return Math.min(Math.round((this.completed / this.total_tests) * 100), 100);
});

BenchmarkBatchSchema.virtual('judge_progress').get(function() {
    if (this.judge_total === 0) return 0;
    return Math.min(Math.round((this.judge_completed / this.judge_total) * 100), 100);
});

BenchmarkBatchSchema.virtual('success_rate').get(function() {
    if (this.completed === 0) return '0%';
    const rate = ((this.completed - this.failed) / this.completed) * 100;
    return rate.toFixed(1) + '%';
});

// Ensure virtuals are included in JSON
BenchmarkBatchSchema.set('toJSON', { virtuals: true });
BenchmarkBatchSchema.set('toObject', { virtuals: true });

// Static helper methods
BenchmarkBatchSchema.statics.getRecent = function(limit = 20) {
    return this.find()
        .sort({ created_at: -1 })
        .limit(limit);
};

BenchmarkBatchSchema.statics.getActive = function() {
    return this.find({
        $or: [
            { status: { $in: ['running', 'judging'] } },
            { judge_status: 'running' }
        ]
    })
        .select('+trust_evidence_context')
        .sort({ created_at: -1 });
};

BenchmarkBatchSchema.statics.getCompleted = function(limit = 20) {
    return this.find({ status: 'completed' })
        .sort({ completed_at: -1 })
        .limit(limit);
};

BenchmarkBatchSchema.statics.getAuthoritativeCounts = async function(batchId) {
    const BenchmarkResult = require('./BenchmarkResult');
    const judgeableFilter = buildJudgeableFilter(batchId);

    const [completed, failed, judge_total, judge_completed, judge_failed] = await Promise.all([
        BenchmarkResult.countDocuments({ batch_id: batchId }),
        BenchmarkResult.countDocuments({ batch_id: batchId, success: false }),
        BenchmarkResult.countDocuments(judgeableFilter),
        BenchmarkResult.countDocuments({
            ...judgeableFilter,
            scoring_method: { $ne: 'pending' }
        }),
        BenchmarkResult.countDocuments({
            ...judgeableFilter,
            scoring_method: 'llm_failed'
        })
    ]);

    return {
        completed,
        failed,
        judge_total,
        judge_completed,
        judge_failed
    };
};

BenchmarkBatchSchema.statics.cleanupStale = async function(inactivityThresholdSeconds = 300) {
    // Only mark batches as stale if they've been inactive for the threshold period
    // This prevents killing active batches on server restart/reload
    const threshold = new Date(Date.now() - (inactivityThresholdSeconds * 1000));

    // A process can stop after consuming a CampaignSpec but before committing
    // its source context. Preserve the one-shot reservation as failed evidence
    // instead of leaving an apparently launchable pending batch forever.
    await this.updateMany({
        status: 'pending',
        trust_campaign_spec_id: { $type: 'string' },
        trust_evidence_context: null,
        created_at: { $lt: threshold }
    }, {
        $set: {
            status: 'failed',
            failure_reason: 'trust_preregistration_abandoned',
            completed_at: new Date(),
            last_activity_at: new Date()
        },
        $unset: { active_slot: 1 }
    });

    // Find stale batches first so we can fix them properly
    const staleBatches = await this.find({
        status: { $in: ['running', 'judging'] },
        $or: [
            { last_activity_at: { $lt: threshold } },
            { last_activity_at: null }
        ]
    }).select('+trust_evidence_context');

    let fixedCount = 0;

    for (const batch of staleBatches) {
        try {
            const counts = await this.getAuthoritativeCounts(batch._id);
            const allTestsFinished = Number(batch.total_tests || 0) > 0
                && counts.completed >= Number(batch.total_tests || 0);
            const judgingFinished = counts.judge_total === 0 || counts.judge_completed >= counts.judge_total;
            const reconciledStatus = allTestsFinished && judgingFinished
                ? 'completed'
                : 'interrupted';

            if (batch.trust_evidence_context) {
                await this.finalizeTrustEvidenceBatch(batch._id, {
                    status: reconciledStatus,
                    failureReason: reconciledStatus === 'completed' ? null : 'stale_runtime_heartbeat',
                    allowUnstarted: reconciledStatus !== 'completed'
                });
            } else {
                await batch.reconcileFromResults({
                    status: reconciledStatus,
                    judgeStatus: deriveTerminalJudgeStatus(batch, counts, reconciledStatus),
                    authoritativeCounts: counts,
                    timelineEvent: 'stale_cleanup',
                    timelineError: 'Batch reconciled after inactivity threshold was exceeded'
                });
            }
            fixedCount++;
        } catch (err) {
            console.error('Failed to cleanup batch', batch._id, err.message);
        }
    }

    return fixedCount;
};

BenchmarkBatchSchema.statics.findStuck = async function(inactivityThresholdSeconds = 300) {
    const threshold = new Date(Date.now() - (inactivityThresholdSeconds * 1000));
    return this.find({
        $and: [
            {
                $or: [
                    { status: { $in: ['running', 'judging'] } },
                    { judge_status: 'running' }
                ]
            },
            {
                $or: [
                    { last_activity_at: { $lt: threshold } },
                    { last_activity_at: null }
                ]
            }
        ]
    })
        .select('+trust_evidence_context')
        .sort({ last_activity_at: 1 });
};

// Instance methods for state transitions
BenchmarkBatchSchema.methods.markAsRunning = function() {
    this.status = 'running';
    if (!this.started_at) {
        this.started_at = new Date();
    }
    return this.save();
};

BenchmarkBatchSchema.methods.markAsJudging = function() {
    this.status = 'judging';
    if (!this.generated_at) {
        this.generated_at = new Date();
    }
    return this.save();
};

BenchmarkBatchSchema.methods.markAsCompleted = function(status = null, failureReason = null) {
    if (status) {
        this.status = status;
    } else {
        const outcome = deriveTerminalBatchOutcome({
            totalTests: this.total_tests,
            completed: this.completed,
            failed: this.failed
        });
        this.status = outcome.status;
        if (!failureReason && outcome.failureReason) failureReason = outcome.failureReason;
    }
    if (this.status === 'failed' && failureReason) {
        this.failure_reason = failureReason;
    }
    this.completed_at = new Date();
    this.active_slot = null;
    return this.save();
};

BenchmarkBatchSchema.methods.markAsFailed = function(error) {
    this.status = 'failed';
    this.completed_at = new Date();
    this.active_slot = null;
    if (error && this.results) {
        this.results.push({
            error: error.message || error.toString(),
            success: false
        });
    }
    return this.save();
};

BenchmarkBatchSchema.methods.reconcileFromResults = async function(options = {}) {
    const BatchModel = mongoose.model('BenchmarkBatch');
    const BenchmarkTimelineEntry = require('./BenchmarkTimelineEntry');
    const terminalStatus = options.status || this.status || 'stopped';
    const counts = options.authoritativeCounts || await BatchModel.getAuthoritativeCounts(this._id);
    const priorState = {
        status: this.status,
        judge_status: this.judge_status
    };

    this.status = terminalStatus;
    this.completed = counts.completed;
    this.failed = counts.failed;
    this.judge_total = counts.judge_total;
    this.judge_completed = counts.judge_completed;
    this.judge_failed = counts.judge_failed;
    this.judge_status = options.judgeStatus || deriveTerminalJudgeStatus(priorState, counts, terminalStatus);
    this.completed_at = new Date();
    this.last_activity_at = new Date();
    this.current_test = buildIdleCurrentTest();
    this.active_slot = null;

    if (options.timelineEvent) {
        await BenchmarkTimelineEntry.create({
            batchId: this._id,
            timestamp: new Date(),
            event: options.timelineEvent,
            success: terminalStatus === 'completed',
            error: options.timelineError || null
        }).catch(() => {}); // best-effort
    }

    return this.save();
};

BenchmarkBatchSchema.methods.markAsStopped = function(options = {}) {
    return this.reconcileFromResults({
        ...options,
        status: 'stopped',
        timelineEvent: options.timelineEvent || 'stop_requested',
        timelineError: options.timelineError || null
    });
};

BenchmarkBatchSchema.methods.markAsInterrupted = function(options = {}) {
    return this.reconcileFromResults({
        ...options,
        status: 'interrupted',
        timelineEvent: options.timelineEvent || 'interrupted',
        timelineError: options.timelineError || null
    });
};

BenchmarkBatchSchema.methods.markJudgingComplete = function() {
    this.judge_status = 'completed';
    return this.save();
};

BenchmarkBatchSchema.methods.incrementProgress = function(success = true) {
    this.completed += 1;
    if (!success) {
        this.failed += 1;
    }
    return this.save();
};

BenchmarkBatchSchema.methods.incrementJudgeProgress = function(success = true) {
    this.judge_completed += 1;
    if (!success) {
        this.judge_failed += 1;
    }
    this.last_activity_at = new Date();
    return this.save();
};

BenchmarkBatchSchema.methods.updateCurrentTest = function(model, promptId, promptName, stage = 'executing', options = {}) {
    const BenchmarkTimelineEntry = require('./BenchmarkTimelineEntry');
    const testNumber = options.testNumber || this.completed + 1;
    const promptLevel = options.promptLevel || null;
    const recordTimeline = options.recordTimeline !== false;
    const update = {
        $set: {
            current_test: {
                model,
                prompt_id: promptId,
                prompt_name: promptName,
                prompt_level: promptLevel,
                prompt_category: options.promptCategory || null,
                prompt_text: options.promptText || null,
                stage,
                started_at: new Date(),
                test_number: testNumber,
                response_preview: options.responsePreview || null,
                latency: options.latency ?? null,
                tokens: options.tokens ?? null,
                tokens_per_sec: options.tokensPerSec ?? null
            },
            last_activity_at: new Date()
        }
    };

    if (recordTimeline) {
        // Fire-and-forget write to the external timeline collection
        BenchmarkTimelineEntry.create({
            batchId: this._id,
            timestamp: new Date(),
            event: stage === 'executing' ? 'test_start' : 'judge_start',
            model,
            prompt_id: promptId,
            prompt_level: promptLevel,
            success: null
        }).catch(() => {}); // best-effort
    }

    // Use direct MongoDB update to avoid loading entire document into memory
    return mongoose.model('BenchmarkBatch').updateOne({ _id: this._id }, update);
};

// Partial update — preserves existing current_test fields (e.g. prompt_text)
// while transitioning stage and adding response data
BenchmarkBatchSchema.methods.updateCurrentTestStage = function(stage, extraFields = {}) {
    const setFields = { 'current_test.stage': stage, last_activity_at: new Date() };
    for (const [key, val] of Object.entries(extraFields)) {
        setFields[`current_test.${key}`] = val;
    }
    return mongoose.model('BenchmarkBatch').updateOne({ _id: this._id }, { $set: setFields });
};

BenchmarkBatchSchema.methods.recordTestComplete = function(model, promptId, durationMs, success = true, error = null, promptLevel = null, host = null, tokensPerSec = null) {
    const BenchmarkTimelineEntry = require('./BenchmarkTimelineEntry');
    // Write timeline event to the external collection (fire-and-forget)
    BenchmarkTimelineEntry.create({
        batchId: this._id,
        timestamp: new Date(),
        event: success ? 'test_complete' : 'error',
        model,
        host,
        prompt_id: promptId,
        prompt_level: promptLevel,
        duration_ms: durationMs,
        tokens_per_sec: tokensPerSec,
        success,
        error: error ? error.message || error.toString() : null
    }).catch(() => {}); // best-effort

    return mongoose.model('BenchmarkBatch').updateOne(
        { _id: this._id },
        { $set: { last_activity_at: new Date() } }
    );
};

BenchmarkBatchSchema.methods.recordJudgeComplete = function(model, promptId, durationMs, success = true, promptLevel = null) {
    const BenchmarkTimelineEntry = require('./BenchmarkTimelineEntry');
    // Write timeline event to the external collection (fire-and-forget)
    BenchmarkTimelineEntry.create({
        batchId: this._id,
        timestamp: new Date(),
        event: 'judge_complete',
        model,
        prompt_id: promptId,
        prompt_level: promptLevel,
        duration_ms: durationMs,
        success
    }).catch(() => {}); // best-effort

    return mongoose.model('BenchmarkBatch').updateOne(
        { _id: this._id },
        { $set: { last_activity_at: new Date() } }
    );
};

BenchmarkBatchSchema.methods.clearCurrentTest = function() {
    this.current_test = buildIdleCurrentTest();
    return this.save();
};

BenchmarkBatchSchema.methods.heartbeat = function() {
    this.last_activity_at = new Date();
    return this.save();
};

BenchmarkBatchSchema.methods.addResult = function(resultSummary) {
    this.results.push(resultSummary);
    return this.save();
};

BenchmarkBatchSchema.methods.lockForExecution = function(pid) {
    this.execution_started_at = new Date();
    this.execution_pid = pid;
    return this.save();
};

BenchmarkBatchSchema.methods.calculateMetrics = async function() {
    const BenchmarkResult = require('./BenchmarkResult');

    // Use aggregation pipeline instead of loading all results into memory
    const [stats] = await BenchmarkResult.aggregate([
        { $match: { batch_id: this._id } },
        { $group: {
            _id: null,
            count: { $sum: 1 },
            avgLatency: { $avg: { $cond: [{ $gt: ['$latency', 0] }, '$latency', null] } },
            avgScoringTime: { $avg: { $cond: [{ $gt: ['$scoring_time_ms', 0] }, '$scoring_time_ms', null] } },
            totalTokens: { $sum: { $ifNull: ['$tokens', 0] } },
            tokPerSecValues: {
                $push: {
                    $cond: [
                        { $gt: [{ $ifNull: ['$tokens_per_sec', 0] }, 0] },
                        '$tokens_per_sec',
                        '$$REMOVE'
                    ]
                }
            }
        }},
        { $project: {
            _id: 0, count: 1, avgLatency: 1, avgScoringTime: 1, totalTokens: 1, tokPerSecValues: 1
        }}
    ]);

    if (!stats || stats.count === 0) return this;

    // Calculate durations from batch timestamps
    if (this.started_at && this.completed_at) {
        this.execution_metrics.total_duration_ms = this.completed_at - this.started_at;
    }
    if (this.started_at && this.generated_at) {
        this.execution_metrics.generation_duration_ms = this.generated_at - this.started_at;
    }
    if (this.generated_at && this.completed_at) {
        this.execution_metrics.judging_duration_ms = this.completed_at - this.generated_at;
    }

    if (stats.avgLatency) {
        this.execution_metrics.avg_test_duration_ms = Math.round(stats.avgLatency);
    }
    if (stats.avgScoringTime) {
        this.execution_metrics.avg_judge_duration_ms = Math.round(stats.avgScoringTime);
    }
    if (this.execution_metrics.generation_duration_ms > 0) {
        this.execution_metrics.tests_per_minute = Math.round(
            (this.completed * 60000) / this.execution_metrics.generation_duration_ms
        );
    }
    if (stats.totalTokens > 0) {
        this.execution_metrics.total_tokens_generated = stats.totalTokens;
    }

    const validTokPerSec = (stats.tokPerSecValues || []).filter(v => typeof v === 'number' && !isNaN(v));
    if (validTokPerSec.length > 0) {
        this.execution_metrics.total_tokens_per_sec_avg =
            (validTokPerSec.reduce((a, b) => a + b, 0) / validTokPerSec.length).toFixed(2);
    }

    return this.save();
};

BenchmarkBatchSchema.methods.captureSystemSnapshot = function() {
    const os = require('os');
    const packageJson = require('../package.json');

    this.config_snapshot = {
        agentx_version: packageJson.version || '1.3.2',
        node_version: process.version,
        os_platform: os.platform(),
        cpu_count: os.cpus().length
    };

    return this;
};

function protectedBatchEvidenceError(operation) {
    const error = new Error(`Benchmark batch evidence is sealed by an append-only trust receipt; ${operation} is forbidden`);
    error.code = 'BENCHMARK_TRUST_BATCH_EVIDENCE_SEALED';
    error.statusCode = 409;
    return error;
}

function protectedBatchContextError(operation) {
    const error = new Error(`Benchmark trust source context is immutable and server-committed; ${operation} is forbidden`);
    error.code = 'BENCHMARK_TRUST_SOURCE_CONTEXT_IMMUTABLE';
    error.statusCode = 409;
    return error;
}

const TRUST_TERMINAL_BATCH_STATUSES = new Set(['completed', 'failed', 'stopped', 'interrupted']);

function aggregateContainsWriteStage(value) {
    if (Array.isArray(value)) return value.some(aggregateContainsWriteStage);
    if (!value || typeof value !== 'object') return false;
    return Object.entries(value).some(([key, entry]) => (
        key === '$merge' || key === '$out' || aggregateContainsWriteStage(entry)
    ));
}

BenchmarkBatchSchema.pre('aggregate', function blockBatchAggregateWrites() {
    if (aggregateContainsWriteStage(this.pipeline())) {
        throw protectedBatchEvidenceError('aggregate write stage');
    }
});

for (const operation of [
    'updateOne',
    'updateMany',
    'replaceOne',
    'findOneAndUpdate',
    'findOneAndReplace',
    'deleteOne',
    'deleteMany',
    'findOneAndDelete',
    'findOneAndRemove'
]) {
    BenchmarkBatchSchema.pre(operation, async function blockSealedBatchQueryMutation() {
        if (this.getOptions()?.upsert === true) {
            throw protectedBatchContextError(`${operation} with upsert`);
        }
        const update = this.getUpdate() || {};
        if (Array.isArray(update)) {
            throw protectedBatchEvidenceError(`${operation} with update pipeline`);
        }
        if (['replaceOne', 'findOneAndReplace'].includes(operation)) {
            throw protectedBatchEvidenceError(operation);
        }
        const pathMatches = (path, roots) => {
            if (typeof path !== 'string') return false;
            const normalized = path.startsWith('$') ? path.slice(1) : path;
            return roots.some(root => normalized === root || normalized.startsWith(`${root}.`));
        };
        const operators = Object.entries(update)
            .filter(([key, value]) => key.startsWith('$') && value && typeof value === 'object')
            .map(([, value]) => value);
        const directPaths = Object.keys(update).filter(key => !key.startsWith('$'));
        const operatorPaths = operators.flatMap(value => Object.keys(value));
        const renameTargets = Object.entries(update.$rename || {}).flatMap(([from, to]) => [from, to]);
        const touchedPaths = [...directPaths, ...operatorPaths, ...renameTargets];
        const touchesTrustBatchId = touchedPaths.some(path => pathMatches(path, ['trust_batch_id']));
        const touchesTrustCampaignSpecId = touchedPaths.some(path => pathMatches(path, ['trust_campaign_spec_id']));
        const touchesTrustSeal = touchedPaths.some(path => pathMatches(path, ['trust_evidence_sealed']));
        const touchesTrustContext = touchedPaths.some(path => (
            path === 'trust_evidence_context'
            || path.startsWith('trust_evidence_context.')
            || path === 'trust_evidence_committed_at'
            || path.startsWith('trust_evidence_committed_at.')
            || path === 'trust_evidence_finalized_at'
            || path.startsWith('trust_evidence_finalized_at.')
        ));
        if (touchesTrustBatchId) {
            throw protectedBatchEvidenceError(`${operation} changing trust_batch_id`);
        }
        if (touchesTrustCampaignSpecId) {
            throw protectedBatchContextError(`${operation} changing trust_campaign_spec_id`);
        }
        if (touchesTrustSeal) {
            throw protectedBatchEvidenceError(`${operation} changing server evidence seal`);
        }
        if (touchesTrustContext) {
            throw protectedBatchContextError(`${operation} changing trust source context`);
        }
        const originalFilter = this.getFilter() || {};
        const isDeleteOperation = operation.startsWith('delete')
            || operation.includes('Delete')
            || operation.includes('Remove');
        if (isDeleteOperation) {
            const trustContextMatch = await this.model.exists({
                $and: [
                    originalFilter,
                    {
                        $or: [
                            { trust_evidence_context: { $ne: null } },
                            { trust_campaign_spec_id: { $type: 'string' } }
                        ]
                    }
                ]
            });
            if (trustContextMatch) {
                throw protectedBatchContextError(`${operation} committed Trust batch`);
            }
        }
        const requestedStatus = update.$set?.status ?? update.status;
        const touchesStatus = touchedPaths.some(path => pathMatches(path, ['status']));
        const touchesCompletedAt = touchedPaths.some(path => pathMatches(path, ['completed_at']));
        const statusUsesUnsafeOperator = Object.entries(update).some(([operator, value]) => (
            operator.startsWith('$')
            && operator !== '$set'
            && value && typeof value === 'object'
            && Object.keys(value).some(path => pathMatches(path, ['status']))
        ));
        const isTerminalTransition = TRUST_TERMINAL_BATCH_STATUSES.has(requestedStatus)
            || touchesCompletedAt
            || statusUsesUnsafeOperator
            || (touchesStatus && requestedStatus == null);
        if (isTerminalTransition) {
            const trustContextMatch = await this.model.exists({
                $and: [originalFilter, { trust_evidence_context: { $ne: null } }]
            });
            if (trustContextMatch) {
                throw protectedBatchContextError(`${operation} terminal transition outside Trust finalizer`);
            }
        }
        const sealedMatch = await this.model.exists({
            $and: [originalFilter, { trust_evidence_sealed: true }]
        });
        if (sealedMatch) throw protectedBatchEvidenceError(operation);
        const finalizedMatch = await this.model.exists({
            $and: [originalFilter, { trust_evidence_finalized_at: { $ne: null } }]
        });
        if (finalizedMatch) throw protectedBatchEvidenceError(`${operation} after Trust finalization`);
        const atomicGuards = [
            { trust_evidence_sealed: { $ne: true } },
            { trust_evidence_finalized_at: null }
        ];
        if (isTerminalTransition) atomicGuards.push({ trust_evidence_context: null });
        if (isDeleteOperation) {
            atomicGuards.push(
                { trust_evidence_context: null },
                { trust_campaign_spec_id: null }
            );
        }
        this.setQuery({ $and: [originalFilter, ...atomicGuards] });
    });
}

BenchmarkBatchSchema.pre('save', async function serializeBatchDocumentSave() {
    if (this.isNew) {
        if (this.trust_evidence_context != null
            || this.trust_evidence_committed_at != null
            || this.trust_evidence_finalized_at != null
            || this.trust_evidence_sealed === true) {
            throw protectedBatchContextError('document creation with caller-supplied trust source context');
        }
        return;
    }
    if (this.isModified('trust_evidence_context')
        || this.isModified('trust_campaign_spec_id')
        || this.isModified('trust_evidence_committed_at')
        || this.isModified('trust_evidence_finalized_at')
        || this.isModified('trust_evidence_sealed')) {
        throw protectedBatchContextError('document.save changing trust source context');
    }
    const isTerminalSave = (this.isModified('status') && TRUST_TERMINAL_BATCH_STATUSES.has(this.status))
        || this.isModified('completed_at');
    if (isTerminalSave) {
        const trustContextMatch = await this.constructor.exists({
            _id: this._id,
            trust_evidence_context: { $ne: null }
        });
        if (trustContextMatch) {
            throw protectedBatchContextError('document.save terminal transition outside Trust finalizer');
        }
    }
    this.$where = {
        ...(this.$where || {}),
        trust_evidence_sealed: { $ne: true },
        trust_evidence_finalized_at: null,
        ...(isTerminalSave ? { trust_evidence_context: null } : {})
    };
    const sealed = await this.constructor.exists({
        _id: this._id,
        trust_evidence_sealed: true
    });
    if (sealed) throw protectedBatchEvidenceError('document.save');
    const finalized = await this.constructor.exists({
        _id: this._id,
        trust_evidence_finalized_at: { $ne: null }
    });
    if (finalized) throw protectedBatchEvidenceError('document.save after Trust finalization');
});

BenchmarkBatchSchema.pre('deleteOne', { document: true, query: false }, function blockBatchDocumentDelete() {
    throw protectedBatchEvidenceError('document.deleteOne');
});

const BenchmarkBatch = mongoose.models.BenchmarkBatch
    || mongoose.model('BenchmarkBatch', BenchmarkBatchSchema);

BenchmarkBatch.commitTrustEvidenceContext = async function commitTrustEvidenceContext(batchId, rawContext) {
    const { withBenchmarkTrustEvidenceLock } = require('../src/services/benchmark/benchmarkTrustEvidenceLock');
    const { normalizeSourceContext } = require('../src/services/benchmark/benchmarkTrustSourceEvidence');
    const BenchmarkResult = require('./BenchmarkResult');
    const context = normalizeSourceContext(rawContext);

    return withBenchmarkTrustEvidenceLock('commit-benchmark-trust-source-context', async () => {
        const batch = await this.findById(batchId)
            .select('_id status started_at execution_started_at trust_batch_id trust_evidence_sealed +trust_evidence_context +trust_evidence_committed_at +trust_evidence_finalized_at')
            .lean();
        if (!batch || String(batch.trust_batch_id || '') !== context.sourceBatchId) {
            throw protectedBatchContextError('commit for a different or missing source batch');
        }
        if (batch.status !== 'pending' || batch.started_at != null || batch.execution_started_at != null) {
            throw protectedBatchContextError('commit after batch start');
        }
        if (batch.trust_evidence_context != null || batch.trust_evidence_committed_at != null) {
            throw protectedBatchContextError('second context commit');
        }
        if (batch.trust_evidence_sealed === true
            || batch.trust_evidence_finalized_at != null
            || await BenchmarkResult.exists({ batch_id: batch._id })) {
            throw protectedBatchContextError('commit after result evidence exists');
        }

        const committedAt = new Date();
        const update = await this.collection.updateOne(
            {
                _id: batch._id,
                status: 'pending',
                started_at: null,
                execution_started_at: null,
                trust_evidence_sealed: { $ne: true },
                trust_evidence_finalized_at: null,
                trust_evidence_context: null,
                trust_evidence_committed_at: null
            },
            {
                $set: {
                    trust_evidence_context: context,
                    trust_evidence_committed_at: committedAt
                }
            }
        );
        if (update.matchedCount !== 1) {
            throw protectedBatchContextError('context commit lost an ordering race');
        }
        return { context, committedAt };
    }, { waitMs: 30_000 });
};

BenchmarkBatch.commitAndStartTrustEvidenceBatch = async function commitAndStartTrustEvidenceBatch(batchId, rawContext) {
    const { withBenchmarkTrustEvidenceLock } = require('../src/services/benchmark/benchmarkTrustEvidenceLock');
    const { normalizeSourceContext } = require('../src/services/benchmark/benchmarkTrustSourceEvidence');
    const BenchmarkResult = require('./BenchmarkResult');
    const context = normalizeSourceContext(rawContext);

    return withBenchmarkTrustEvidenceLock('commit-and-start-benchmark-trust-source-context', async () => {
        const batch = await this.findById(batchId)
            .select('_id status started_at execution_started_at trust_batch_id trust_evidence_sealed +trust_evidence_context +trust_evidence_committed_at +trust_evidence_finalized_at')
            .lean();
        if (!batch || String(batch.trust_batch_id || '') !== context.sourceBatchId) {
            throw protectedBatchContextError('atomic start for a different or missing source batch');
        }
        if (batch.status !== 'pending'
            || batch.started_at != null
            || batch.execution_started_at != null
            || batch.trust_evidence_context != null
            || batch.trust_evidence_committed_at != null
            || batch.trust_evidence_sealed === true
            || batch.trust_evidence_finalized_at != null
            || await BenchmarkResult.exists({ batch_id: batch._id })) {
            throw protectedBatchContextError('atomic start after campaign evidence or execution state exists');
        }
        const committedAt = new Date();
        const update = await this.collection.updateOne(
            {
                _id: batch._id,
                status: 'pending',
                started_at: null,
                execution_started_at: null,
                trust_evidence_context: null,
                trust_evidence_committed_at: null,
                trust_evidence_sealed: { $ne: true },
                trust_evidence_finalized_at: null
            },
            {
                $set: {
                    trust_evidence_context: context,
                    trust_evidence_committed_at: committedAt,
                    status: 'running',
                    started_at: committedAt,
                    last_activity_at: committedAt
                }
            }
        );
        if (update.matchedCount !== 1) {
            throw protectedBatchContextError('atomic context/start transition lost a race');
        }
        return { context, committedAt };
    }, { waitMs: 30_000 });
};

BenchmarkBatch.finalizeTrustEvidenceBatch = async function finalizeTrustEvidenceBatch(batchId, options = {}) {
    const { withBenchmarkTrustEvidenceLock } = require('../src/services/benchmark/benchmarkTrustEvidenceLock');
    const { buildBenchmarkTrustSourceProjection } = require('../src/services/benchmark/benchmarkTrustSourceEvidence');
    const BenchmarkResult = require('./BenchmarkResult');
    const terminalStatus = options.status || 'completed';
    if (!TRUST_TERMINAL_BATCH_STATUSES.has(terminalStatus)) {
        throw protectedBatchContextError('Trust finalizer with non-terminal status');
    }
    return withBenchmarkTrustEvidenceLock('finalize-benchmark-trust-source-batch', async () => {
        const batch = await this.findById(batchId)
            .select('_id status total_tests started_at execution_started_at trust_evidence_sealed +trust_evidence_context +trust_evidence_finalized_at')
            .lean();
        if (!batch?.trust_evidence_context) {
            throw protectedBatchContextError('Trust finalizer without committed context');
        }
        if (TRUST_TERMINAL_BATCH_STATUSES.has(batch.status)
            && batch.trust_evidence_sealed === true
            && batch.trust_evidence_finalized_at != null
            && batch.status === terminalStatus) {
            return this.findById(batch._id)
                .select('+trust_evidence_context +trust_evidence_committed_at +trust_evidence_finalized_at');
        }
        if (TRUST_TERMINAL_BATCH_STATUSES.has(batch.status)
            || batch.trust_evidence_sealed === true
            || batch.trust_evidence_finalized_at != null) {
            throw protectedBatchContextError('Trust finalizer after terminal or sealed state');
        }
        if (batch.started_at == null
            || (batch.execution_started_at == null && options.allowUnstarted !== true)) {
            throw protectedBatchContextError('Trust finalizer before execution start');
        }
        if (options.allowUnstarted === true && terminalStatus === 'completed') {
            throw protectedBatchContextError('completed Trust finalizer cannot allow an unstarted batch');
        }
        if (terminalStatus === 'completed') {
            const terminalResults = await BenchmarkResult.find({ batch_id: batch._id })
                .select('+trust_execution_receipt +trust_judge_receipt')
                .lean();
            try {
                buildBenchmarkTrustSourceProjection({
                    context: batch.trust_evidence_context,
                    results: terminalResults,
                    sourceBatchId: batch.trust_evidence_context.sourceBatchId
                });
            } catch (_error) {
                throw protectedBatchContextError('completed Trust finalizer requires the exact canonical inventory');
            }
        }
        const resultFinalization = await BenchmarkResult.collection.updateMany(
            {
                batch_id: batch._id,
                trust_evidence_sealed: { $ne: true }
            },
            { $set: { trust_evidence_sealed: true } }
        );
        const [resultCount, succeededCount, sealedResultCount, judgedResultCount, sealedTerminalResults] = await Promise.all([
            BenchmarkResult.countDocuments({ batch_id: batch._id }),
            BenchmarkResult.countDocuments({ batch_id: batch._id, success: true }),
            BenchmarkResult.countDocuments({ batch_id: batch._id, trust_evidence_sealed: true }),
            BenchmarkResult.countDocuments({
                batch_id: batch._id,
                success: true,
                scoring_method: 'llm_judge',
                trust_judge_receipt: { $type: 'object' }
            }),
            terminalStatus === 'completed'
                ? BenchmarkResult.find({ batch_id: batch._id })
                    .select('+trust_execution_receipt +trust_judge_receipt')
                    .lean()
                : Promise.resolve(null)
        ]);

        let finalizationFailure = null;
        if (resultFinalization.matchedCount > resultCount || sealedResultCount !== resultCount) {
            finalizationFailure = 'Trust finalizer lost a result mutation race';
        }
        if (!finalizationFailure && terminalStatus === 'completed') {
            try {
                buildBenchmarkTrustSourceProjection({
                    context: batch.trust_evidence_context,
                    results: sealedTerminalResults,
                    sourceBatchId: batch.trust_evidence_context.sourceBatchId
                });
            } catch (_error) {
                finalizationFailure = 'Trust evidence changed during finalization';
            }
        }
        if (!finalizationFailure && terminalStatus === 'completed'
            && (resultCount !== Number(batch.total_tests)
                || succeededCount !== resultCount
                || judgedResultCount !== resultCount)) {
            finalizationFailure = 'completed Trust finalizer requires the exact successful and judge-receipted inventory';
        }
        if (finalizationFailure) {
            const failedAt = new Date();
            const failedUpdate = await this.collection.updateOne(
                {
                    _id: batch._id,
                    trust_evidence_sealed: { $ne: true },
                    trust_evidence_finalized_at: null,
                    trust_evidence_context: { $ne: null }
                },
                {
                    $set: {
                        status: 'failed',
                        completed_at: failedAt,
                        completed: succeededCount,
                        failed: resultCount - succeededCount,
                        failure_reason: 'trust_evidence_changed_during_finalization',
                        judge_status: 'failed',
                        last_activity_at: failedAt,
                        active_slot: null,
                        execution_pid: null,
                        trust_evidence_sealed: true,
                        trust_evidence_finalized_at: failedAt,
                        updated_at: failedAt
                    }
                }
            );
            if (failedUpdate.matchedCount !== 1) {
                throw protectedBatchContextError('Trust finalizer lost a fail-closed state transition');
            }
            throw protectedBatchContextError(finalizationFailure);
        }
        const completedAt = new Date();
        const update = await this.collection.updateOne(
            {
                _id: batch._id,
                trust_evidence_sealed: { $ne: true },
                trust_evidence_finalized_at: null,
                trust_evidence_context: { $ne: null }
            },
            {
                $set: {
                    status: terminalStatus,
                    completed_at: completedAt,
                    completed: resultCount,
                    failed: resultCount - succeededCount,
                    failure_reason: options.failureReason || null,
                    judge_status: terminalStatus === 'completed'
                        ? 'completed'
                        : (terminalStatus === 'stopped' || terminalStatus === 'interrupted')
                            ? 'stopped'
                            : 'failed',
                    last_activity_at: completedAt,
                    active_slot: null,
                    execution_pid: null,
                    trust_evidence_sealed: true,
                    trust_evidence_finalized_at: completedAt,
                    updated_at: completedAt
                }
            }
        );
        if (update.matchedCount !== 1) {
            throw protectedBatchContextError('Trust finalizer lost a state transition race');
        }
        return this.findById(batch._id)
            .select('+trust_evidence_context +trust_evidence_committed_at +trust_evidence_finalized_at');
    }, { waitMs: 30_000 });
};

BenchmarkBatch.bulkWrite = async function blockedBenchmarkBatchBulkWrite() {
    throw protectedBatchEvidenceError('bulkWrite');
};

const unguardedBenchmarkBatchInsertMany = BenchmarkBatch.insertMany.bind(BenchmarkBatch);
BenchmarkBatch.insertMany = async function guardedBenchmarkBatchInsertMany(documents, options) {
    const rows = Array.isArray(documents) ? documents : [documents];
    if (rows.some(row => row?.trust_evidence_context != null
        || row?.trust_evidence_committed_at != null
        || row?.trust_evidence_finalized_at != null
        || row?.trust_evidence_sealed === true)) {
        throw protectedBatchContextError('insertMany with caller-supplied trust source context');
    }
    return unguardedBenchmarkBatchInsertMany(documents, options);
};

BenchmarkBatch.PROTECTED_EVIDENCE_ERROR_CODE = 'BENCHMARK_TRUST_BATCH_EVIDENCE_SEALED';
BenchmarkBatch.PROTECTED_CONTEXT_ERROR_CODE = 'BENCHMARK_TRUST_SOURCE_CONTEXT_IMMUTABLE';

module.exports = BenchmarkBatch;
