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

const PerCategoryBaselineSchema = new mongoose.Schema({
    category: { type: String, required: true },
    rho: { type: Number, required: true },       // Pearson correlation
    sample_size: { type: Number, required: true },
    mae: { type: Number, default: null },
    bias: { type: Number, default: null }
}, { _id: false });

const CalibrationBaselineSchema = new mongoose.Schema({
    // Human-friendly label, e.g. '0128-r7-2026-04-22'
    label: {
        type: String,
        required: true,
        unique: true,
        index: true
    },

    // Overall ρ across all categories (for dashboard summary)
    overall_rho: { type: Number, default: null },
    overall_sample_size: { type: Number, default: 0 },

    // Per-category breakdown
    categories: {
        type: [PerCategoryBaselineSchema],
        default: []
    },

    // Sprint / source metadata
    source_sprint: { type: String, default: null }, // e.g. 'human-validation-sprint-2026-04-22-r7'
    notes: { type: String, default: null },

    // Whether this is the currently ratified baseline to compare against
    active: {
        type: Boolean,
        default: false,
        index: true
    }
}, {
    timestamps: true
});

CalibrationBaselineSchema.index({ active: 1, createdAt: -1 });

/**
 * Get the currently active baseline (most recently ratified).
 */
CalibrationBaselineSchema.statics.getActive = function() {
    return this.findOne({ active: true }).sort({ createdAt: -1 }).lean();
};

module.exports = mongoose.model('CalibrationBaseline', CalibrationBaselineSchema);
