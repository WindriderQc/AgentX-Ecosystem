/**
 * JudgeQueueEntry — persisted record of a pending/running judge task.
 *
 * When the server enqueues a judge task (in batchOrchestrator or judging.js),
 * it writes one of these.  On completion or failure the status is updated.
 * On restart, 'pending' and 'running' entries can be recovered.
 */

const mongoose = require('mongoose');

const judgeQueueEntrySchema = new mongoose.Schema({
    batchId:     { type: mongoose.Schema.Types.ObjectId, ref: 'BenchmarkBatch', required: true, index: true },
    resultId:    { type: mongoose.Schema.Types.ObjectId, ref: 'BenchmarkResult', required: true, index: true },
    status:      { type: String, enum: ['pending', 'running', 'completed', 'failed'], default: 'pending', index: true },
    judgeConfig: { type: Object, default: {} },
    error:       { type: String },
    createdAt:   { type: Date, default: Date.now },
    startedAt:   { type: Date },
    completedAt: { type: Date },
}, {
    timestamps: false,
    collection: 'judgequeueitems',
});

// Compound index for recovery query: find un-finished entries for a batch
judgeQueueEntrySchema.index({ batchId: 1, status: 1 });

// TTL index — auto-delete completed/failed entries after 7 days
judgeQueueEntrySchema.index({ completedAt: 1 }, { expireAfterSeconds: 604800, partialFilterExpression: { completedAt: { $exists: true } } });

module.exports = mongoose.model('JudgeQueueEntry', judgeQueueEntrySchema);
