const mongoose = require('mongoose');

/**
 * One retrieval search event. Bounded metadata only: the query text, the
 * returned passages and any document content never enter this collection.
 */
const SearchEventSchema = new mongoose.Schema(
  {
    eventId: { type: String, required: true, unique: true },
    // Server-attested producer surface; the request body cannot set it.
    surface: { type: String, default: 'api' },
    status: { type: String, enum: ['success', 'empty', 'failed'], required: true },
    queryLength: { type: Number, default: 0 },
    topK: { type: Number },
    minScore: { type: Number },
    filterCount: { type: Number, default: 0 },
    hybrid: { type: Boolean, default: false },
    rerank: { type: Boolean, default: false },
    expand: { type: Boolean, default: false },
    compress: { type: Boolean, default: false },
    resultCount: { type: Number, default: 0 },
    topScore: { type: Number },
    durationMs: { type: Number },
    errorCode: { type: String },
    createdAt: { type: Date, default: Date.now }
  },
  { timestamps: false }
);

SearchEventSchema.index({ createdAt: -1 });
SearchEventSchema.index({ status: 1, createdAt: -1 });

module.exports = mongoose.model('SearchEvent', SearchEventSchema, 'ragsearchevents');
