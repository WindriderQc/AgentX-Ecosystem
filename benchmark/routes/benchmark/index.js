/**
 * Benchmark Routes - Index
 * Combines all sub-routers and handles startup cleanup
 */

const express = require('express');
const router = express.Router();
const logger = require('../../config/logger');
const benchmarkService = require('../../src/services/benchmark');
const {
    withPublicBenchmarkReadPrivacy
} = require('../../src/services/benchmark/publicReadPrivacy');

// Cleanup stale batches on startup
// Skip in tests to avoid timers/open handles and cross-test DB interference.
if (process.env.NODE_ENV !== 'test') {
    (async () => {
        try {
            await new Promise(resolve => setTimeout(resolve, 2000)); // Wait for DB connection
            await benchmarkService.cleanupStaleBatches();
        } catch (err) {
            logger.error('Failed to cleanup stale batches', { error: err.message });
        }
    })();
}

router.use((req, res, next) => {
    const rawPath = String(req.path || '');
    const normalizedPath = rawPath.length > 1 ? rawPath.replace(/\/+$/, '') : rawPath;
    const path = normalizedPath.toLowerCase();
    const usesDedicatedPrivacyOrVerification = path === '/batches'
        || path.startsWith('/batches/')
        || path.startsWith('/batch/')
        || path.startsWith('/trust-receipts')
        || path === '/retention/stats';
    if (usesDedicatedPrivacyOrVerification) return next();
    return withPublicBenchmarkReadPrivacy(req, res, next);
});

router.use('/', require('./core'));
router.use('/', require('./results'));
router.use('/', require('./batches'));
router.use('/', require('./analytics'));
router.use('/', require('./diagnostics'));
router.use('/', require('./efficiency'));
router.use('/', require('./judgeDefaults'));
router.use('/', require('./scoringProfile'));
router.use('/', require('./templates'));
router.use('/', require('./drift'));
router.use('/', require('./sweeps'));
router.use('/', require('./cloudLanes'));
router.use('/', require('./trustReceipts'));
router.use('/', require('./trustBatches'));
router.use('/', require('./humanEvidence'));
router.use('/recommend', require('./recommend'));

module.exports = router;
