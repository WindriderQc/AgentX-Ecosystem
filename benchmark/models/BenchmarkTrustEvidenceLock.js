'use strict';

const mongoose = require('mongoose');

const BenchmarkTrustEvidenceLockSchema = new mongoose.Schema({
    _id: { type: String, required: true },
    ownerToken: { type: String, required: true, match: /^[0-9a-f]{64}$/ },
    operation: { type: String, required: true, maxlength: 80 },
    acquiredAt: { type: Date, required: true, default: Date.now }
}, {
    collection: 'benchmark_trust_evidence_locks',
    strict: 'throw',
    versionKey: false
});

module.exports = mongoose.models.BenchmarkTrustEvidenceLock
    || mongoose.model('BenchmarkTrustEvidenceLock', BenchmarkTrustEvidenceLockSchema);
