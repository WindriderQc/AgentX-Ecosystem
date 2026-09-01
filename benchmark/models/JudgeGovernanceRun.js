/**
 * JudgeGovernanceRun Model
 *
 * One document per governance-loop execution. Composes outputs from the
 * existing judge validation building blocks (feedback stats, auto-promote,
 * optional retro-calibration, matrix calibration, drift detection) into a
 * single operator-facing summary artifact.
 *
 * Sub-step outcomes are first-class: each records status = ok | skipped |
 * failed so partial failures are visible rather than silently swallowed.
 *
 * The Benchmark service owns this collection.
 */

const mongoose = require('mongoose');

const SubStepSchema = new mongoose.Schema({
    name: { type: String, required: true },
    status: {
        type: String,
        enum: ['ok', 'skipped', 'failed'],
        required: true
    },
    started_at: { type: Date },
    finished_at: { type: Date },
    duration_ms: { type: Number, default: 0 },
    error: { type: String, default: null },
    // Sub-step payload lives under `output`. Schema intentionally loose —
    // governance observes existing services; changing their shape should not
    // require a migration here.
    output: { type: mongoose.Schema.Types.Mixed, default: null }
}, { _id: false });

const JudgeGovernanceRunSchema = new mongoose.Schema({
    batch_id: { type: String, default: null, index: true },
    judge_model: { type: String, default: null, index: true },
    judge_host: { type: String, default: null },
    reference_model: { type: String, default: null },
    reference_host: { type: String, default: null },
    triggered_by: { type: String, default: 'manual' },  // manual | cron | api
    started_at: { type: Date, default: Date.now, index: true },
    finished_at: { type: Date, default: null },
    duration_ms: { type: Number, default: 0 },
    // Aggregate status: ok only when orchestration succeeds and drift evidence
    // is conclusive, partial when a step fails or mandatory drift is unknown,
    // failed if orchestration itself threw before the summary assembled.
    status: {
        type: String,
        enum: ['ok', 'partial', 'failed'],
        required: true,
        default: 'ok'
    },
    sub_steps: { type: [SubStepSchema], default: [] },
    // Headline metrics surfaced at the top of the operator report.
    headline: {
        feedback_overall_count: { type: Number, default: 0 },
        feedback_high_divergence_rate: { type: Number, default: 0 },
        auto_promoted: { type: Number, default: 0 },
        retro_created: { type: Number, default: 0 },
        matrix_pass_rate: { type: Number, default: null },
        matrix_overall_deviation: { type: Number, default: null },
        drift_status: {
            type: String,
            enum: ['ok', 'alert', 'insufficient_data', 'no_baseline', 'skipped', 'failed', 'unknown'],
            default: 'unknown'
        },
        drift_detected: { type: Boolean, default: null },
        drift_reasons: { type: [String], default: [] }
    },
    notes: { type: String, default: null }
}, { timestamps: true });

JudgeGovernanceRunSchema.index({ started_at: -1 });
JudgeGovernanceRunSchema.index({ judge_model: 1, started_at: -1 });

/**
 * Get the most recent governance run (optionally filtered by judge model).
 */
JudgeGovernanceRunSchema.statics.getLatest = function (judgeModel = null) {
    const query = judgeModel ? { judge_model: judgeModel } : {};
    return this.findOne(query).sort({ started_at: -1 });
};

module.exports = mongoose.model('JudgeGovernanceRun', JudgeGovernanceRunSchema);
