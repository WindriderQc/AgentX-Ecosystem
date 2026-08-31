'use strict';

const mongoose = require('mongoose');

const HarnessCampaignSchema = new mongoose.Schema({
    target: { type: mongoose.Schema.Types.Mixed, required: true },
    execution_profile: { type: String, enum: ['portable', 'native-ceiling'], required: true, index: true },
    batch_contract_fingerprint: { type: String, required: true, index: true },
    status: { type: String, enum: ['running', 'completed', 'failed'], required: true, index: true },
    envelope: { type: mongoose.Schema.Types.Mixed, default: null },
    receipt: { type: mongoose.Schema.Types.Mixed, default: null },
    output_fingerprint: { type: String, default: null },
    usage: { type: mongoose.Schema.Types.Mixed, default: null },
    cost: { type: mongoose.Schema.Types.Mixed, default: null },
    failure: { type: mongoose.Schema.Types.Mixed, default: null },
    started_at: { type: Date, required: true },
    completed_at: { type: Date, default: null }
}, { timestamps: true });

HarnessCampaignSchema.index({ 'target.id': 1, started_at: -1 });

module.exports = mongoose.model('HarnessCampaign', HarnessCampaignSchema);
