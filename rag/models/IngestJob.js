const mongoose = require('mongoose');

const IngestJobSchema = new mongoose.Schema(
  {
    jobId: { type: String, required: true, unique: true },
    source: { type: String, default: 'api' },
    documentId: { type: String },
    status: { type: String, enum: ['success', 'failed', 'partial'], required: true },
    chunksCreated: { type: Number, default: 0 },
    embeddingTimeMs: { type: Number },
    totalTimeMs: { type: Number },
    error: { type: String },
    tags: { type: [String], default: [] },
    textLength: { type: Number, default: 0 },
    createdAt: { type: Date, default: Date.now }
  },
  { timestamps: false }
);

IngestJobSchema.index({ createdAt: -1 });
IngestJobSchema.index({ source: 1, createdAt: -1 });

module.exports = mongoose.model('IngestJob', IngestJobSchema, 'ingestjobs');
