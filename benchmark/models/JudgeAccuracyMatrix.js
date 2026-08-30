/**
 * JudgeAccuracyMatrix Model
 * Stores agreement results: how closely a judge scores vs. a distinct
 * reference judge. This is not direct human-score accuracy evidence.
 */

const mongoose = require('mongoose');

const CellSchema = new mongoose.Schema({
    category: { type: String, required: true },
    difficulty: { type: Number, min: 1, max: 5, required: true },
    avg_deviation: { type: Number, required: true },
    sample_count: { type: Number, required: true },
    pass: { type: Boolean, required: true }
}, { _id: false });

const JudgeAccuracyMatrixSchema = new mongoose.Schema({
    judge_model: { type: String, required: true, index: true },
    judge_host: { type: String, default: null },
    reference_model: { type: String, required: true },
    reference_host: { type: String, default: null },
    calibrated_at: { type: Date, default: Date.now, index: true },
    cells: [CellSchema],
    overall_avg_deviation: { type: Number, required: true },
    pass_threshold: { type: Number, default: 1.5 },
    pass_rate: { type: Number, default: 0 },
    cell_pass_rate: { type: Number, default: null },
    scored_entry_count: { type: Number, default: 0 },
    comparison_kind: {
        type: String,
        enum: ['reference_judge_agreement'],
        default: 'reference_judge_agreement'
    },
    ground_truth_count: { type: Number, default: 0 }
}, { timestamps: true });

JudgeAccuracyMatrixSchema.index({ judge_model: 1, judge_host: 1, calibrated_at: -1 });

/**
 * Get the most recent accuracy matrix for a judge model
 */
JudgeAccuracyMatrixSchema.statics.getLatest = function (judgeModel, judgeHost = null) {
    const query = { judge_model: judgeModel };
    if (judgeHost) query.judge_host = String(judgeHost).trim().replace(/\/+$/, '');
    return this.findOne(query)
        .sort({ calibrated_at: -1 });
};

/**
 * Check if a judge has been calibrated (any matrix exists)
 */
JudgeAccuracyMatrixSchema.statics.isCalibrated = async function (judgeModel, judgeHost = null) {
    const query = { judge_model: judgeModel };
    if (judgeHost) query.judge_host = String(judgeHost).trim().replace(/\/+$/, '');
    const count = await this.countDocuments(query);
    return count > 0;
};

module.exports = mongoose.model('JudgeAccuracyMatrix', JudgeAccuracyMatrixSchema);
