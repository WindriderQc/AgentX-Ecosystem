const mongoose = require('mongoose');

const RagManifestFileSchema = new mongoose.Schema(
  {
    path: { type: String, required: true },
    sha256: { type: String },
    size: { type: Number },
    mtime: { type: Date }
  },
  { _id: false }
);

const RagManifestSchema = new mongoose.Schema(
  {
    source: { type: String, required: true, index: true },
    root: { type: String, required: true, index: true },

    scanId: { type: String },
    generatedAt: { type: Date, default: Date.now },

    files: { type: [RagManifestFileSchema], default: [] },

    stats: {
      fileCount: { type: Number, default: 0 },
      totalBytes: { type: Number, default: 0 }
    }
  },
  {
    timestamps: true
  }
);

RagManifestSchema.index({ source: 1, root: 1 }, { unique: true });

module.exports = mongoose.model('RagManifest', RagManifestSchema);
