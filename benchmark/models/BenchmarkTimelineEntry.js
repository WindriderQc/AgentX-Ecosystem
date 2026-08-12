/**
 * BenchmarkTimelineEntry Model
 * Externalized timeline events for benchmark batches.
 * Replaces the embedded timeline array on BenchmarkBatch to prevent
 * unbounded document growth on long-running batches.
 *
 * A TTL index automatically removes entries older than 30 days.
 */

const mongoose = require('mongoose');

const BenchmarkTimelineEntrySchema = new mongoose.Schema({
    batchId: {
        type: mongoose.Schema.Types.ObjectId,
        required: true,
        index: true
    },
    timestamp: {
        type: Date,
        default: Date.now,
        required: true
    },
    event: {
        type: String,
        required: true
    },
    model: {
        type: String,
        default: null
    },
    host: {
        type: String,
        default: null
    },
    prompt_id: {
        type: String,
        default: null
    },
    prompt_level: {
        type: Number,
        default: null
    },
    duration_ms: {
        type: Number,
        default: null
    },
    tokens_per_sec: {
        type: mongoose.Schema.Types.Mixed,
        default: null
    },
    time_to_first_token_ms: {
        type: Number,
        default: null
    },
    success: {
        type: Boolean,
        default: null
    },
    error: {
        type: String,
        default: null
    },
    // Catch-all for ad-hoc fields passed via spread (e.g. hostKey, pinnedModels)
    details: {
        type: mongoose.Schema.Types.Mixed,
        default: null
    }
}, {
    timestamps: false,
    // Lean collection — no versioning overhead
    versionKey: false
});

// TTL index: auto-delete entries older than 30 days
BenchmarkTimelineEntrySchema.index(
    { timestamp: 1 },
    { expireAfterSeconds: 30 * 24 * 3600 }
);

// Compound index for efficient batch timeline queries sorted by time
BenchmarkTimelineEntrySchema.index({ batchId: 1, timestamp: 1 });

module.exports = mongoose.model('BenchmarkTimelineEntry', BenchmarkTimelineEntrySchema);
