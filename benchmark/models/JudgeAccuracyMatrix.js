/**
 * JudgeAccuracyMatrix Model
 * Stores calibration results: how well a judge scores vs. a reference judge
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
    ground_truth_count: { type: Number, default: 0 }
}, { timestamps: true });

JudgeAccuracyMatrixSchema.index({ judge_model: 1, calibrated_at: -1 });

/**
 * Get the most recent accuracy matrix for a judge model
 */
JudgeAccuracyMatrixSchema.statics.getLatest = function (judgeModel) {
    return this.findOne({ judge_model: judgeModel })
        .sort({ calibrated_at: -1 });
};

/**
 * Check if a judge has been calibrated (any matrix exists)
 */
JudgeAccuracyMatrixSchema.statics.isCalibrated = async function (judgeModel) {
    const count = await this.countDocuments({ judge_model: judgeModel });
    return count > 0;
};

module.exports = mongoose.model('JudgeAccuracyMatrix', JudgeAccuracyMatrixSchema);
