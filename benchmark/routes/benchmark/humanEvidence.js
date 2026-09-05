'use strict';

const express = require('express');
const logger = require('../../config/logger');
const {
    importAttestedHumanGroundTruth
} = require('../../src/services/benchmark/humanGroundTruthImport');

const router = express.Router();

router.post('/judge/ground-truth/import-attested', async (req, res) => {
    try {
        // The request body is the exact signed contract. There is deliberately
        // no caller-provided `verified`, trust-root, revocation, or clock input.
        const result = await importAttestedHumanGroundTruth(req.body);
        return res.status(result.imported ? 201 : 200).json({
            status: 'success',
            data: result
        });
    } catch (error) {
        logger.warn('Attested human-evidence import rejected', {
            code: error.code,
            statusCode: error.statusCode
        });
        return res.status(error.statusCode || 500).json({
            status: 'error',
            code: error.code || 'HUMAN_EVIDENCE_IMPORT_FAILED',
            error: error.message
        });
    }
});

module.exports = router;
