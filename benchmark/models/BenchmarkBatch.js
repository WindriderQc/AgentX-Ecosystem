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
    // Immutable campaign-level inference contract. Resolved once after the
    // benchmark host claim/preflight and reused across every attempt/resume.
    inference_contract_campaign: {
        type: mongoose.Schema.Types.Mixed,
        default: null
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
        time_to_first_token_ms: { type: Number, default: null }
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
            tokensPerSec: { type: Number, default: null },
            promptEvalTokensPerSec: { type: Number, default: null },
            latencyMs: { type: Number, default: null },
            timeToFirstTokenMs: { type: Number, default: null },
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
    // Set only by the trust-receipt store after terminal source verification.
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
    }).sort({ created_at: -1 });
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

    // Find stale batches first so we can fix them properly
    const staleBatches = await this.find({
        status: { $in: ['running', 'judging'] },
        $or: [
            { last_activity_at: { $lt: threshold } },
            { last_activity_at: null }
        ]
    });

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

            await batch.reconcileFromResults({
                status: reconciledStatus,
                judgeStatus: deriveTerminalJudgeStatus(batch, counts, reconciledStatus),
                authoritativeCounts: counts,
                timelineEvent: 'stale_cleanup',
                timelineError: 'Batch reconciled after inactivity threshold was exceeded'
            });
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
    }).sort({ last_activity_at: 1 });
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
        const update = this.getUpdate() || {};
        if (['replaceOne', 'findOneAndReplace'].includes(operation)) {
            throw protectedBatchEvidenceError(operation);
        }
        const touchesTrustBatchId = JSON.stringify(update).includes('"trust_batch_id"');
        if (touchesTrustBatchId) {
            throw protectedBatchEvidenceError(`${operation} changing trust_batch_id`);
        }
        const originalFilter = this.getFilter() || {};
        const sealedMatch = await this.model.exists({
            $and: [originalFilter, { trust_evidence_sealed: true }]
        });
        if (sealedMatch) throw protectedBatchEvidenceError(operation);
        this.setQuery({
            $and: [originalFilter, { trust_evidence_sealed: { $ne: true } }]
        });
    });
}

BenchmarkBatchSchema.pre('save', async function serializeBatchDocumentSave() {
    if (this.isNew) return;
    this.$where = {
        ...(this.$where || {}),
        trust_evidence_sealed: { $ne: true }
    };
    const sealed = await this.constructor.exists({
        _id: this._id,
        trust_evidence_sealed: true
    });
    if (sealed) throw protectedBatchEvidenceError('document.save');
});

BenchmarkBatchSchema.pre('deleteOne', { document: true, query: false }, function blockBatchDocumentDelete() {
    throw protectedBatchEvidenceError('document.deleteOne');
});

const BenchmarkBatch = mongoose.models.BenchmarkBatch
    || mongoose.model('BenchmarkBatch', BenchmarkBatchSchema);

BenchmarkBatch.bulkWrite = async function blockedBenchmarkBatchBulkWrite() {
    throw protectedBatchEvidenceError('bulkWrite');
};

BenchmarkBatch.PROTECTED_EVIDENCE_ERROR_CODE = 'BENCHMARK_TRUST_BATCH_EVIDENCE_SEALED';

module.exports = BenchmarkBatch;
