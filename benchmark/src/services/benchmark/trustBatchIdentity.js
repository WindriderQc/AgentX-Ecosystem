'use strict';

const crypto = require('crypto');

const TRUST_BATCH_ID_PATTERN = /^batch_[0-9a-f]{32}$/;

function createTrustBatchId() {
    return `batch_${crypto.randomBytes(16).toString('hex')}`;
}

module.exports = {
    TRUST_BATCH_ID_PATTERN,
    createTrustBatchId
};
