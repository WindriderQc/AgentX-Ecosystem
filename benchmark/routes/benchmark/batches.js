/**
 * Benchmark Routes - Batches
 * Batch status, listing, timeline, recover, judge control
 */

const express = require('express');
const router = express.Router();
const logger = require('../../config/logger');
const benchmarkService = require('../../src/services/benchmark');
const { judgeBatch, preflightJudgeBatch, stopJudging, stopPersistedJudging, getJudgingStatus } = require('../../src/services/benchmark/judging');
const { resolveMultiJudge } = require('../../src/services/benchmark/resolveMultiJudge');
const {
    resolveReadyJudgeTarget,
    judgeUnavailablePayload
} = require('../../src/services/benchmark/judgeReadiness');
const { validateObjectId } = require('../../src/helpers/objectIdValidator');
const BenchmarkBatch = require('../../models/BenchmarkBatch');
const BenchmarkTimelineEntry = require('../../models/BenchmarkTimelineEntry');

function parseBoolean(value, defaultValue = false) {
    if (value === undefined || value === null || value === '') return defaultValue;
    return ['1', 'true', 'yes', 'on'].includes(String(value).toLowerCase());
}

function parsePositiveInt(value, fallback, max = 32) {
    const parsed = parseInt(value, 10);
    if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
    return Math.min(parsed, max);
}

const STUCK_THRESHOLD_SECONDS = 300;

function mapJudgeStartErrorStatus(err) {
    const msg = String(err && err.message ? err.message : '').toLowerCase();
    if (msg.includes('not found')) return 404;
    if (msg.includes('already running')) return 409;
    if (msg.includes('cannot judge while batch is still running')) return 409;
    if ((msg.includes('no pending') && msg.includes('result')) || (msg.includes('no successful') && msg.includes('result'))) return 400;
    return 500;
}

/**
 * GET /api/benchmark/batch/:id
 * Get batch progress and results
 */
router.get('/batch/:id', async (req, res) => {
    try {
        if (!validateObjectId(req.params.id, res, 'Batch ID')) return;
        const includeHeavyPayload = ['1', 'true', 'yes']
            .includes(String(req.query.include_heavy || '').toLowerCase());
        const includeFullText = ['1', 'true', 'yes']
            .includes(String(req.query.include_full_text || '').toLowerCase());
        const includeAllResults = ['1', 'true', 'yes']
            .includes(String(req.query.include_all_results || '').toLowerCase());
        const resultLimit = req.query.result_limit !== undefined
            ? parseInt(req.query.result_limit, 10)
            : undefined;
        const resultOffset = req.query.result_offset !== undefined
            ? parseInt(req.query.result_offset, 10)
            : undefined;

        const data = await benchmarkService.getBatch(req.params.id, {
            includeHeavyPayload,
            includeFullText,
            includeAllResults,
            resultLimit,
            resultOffset
        });

        res.json({
            status: 'success',
            data
        });
    } catch (err) {
        logger.error('Failed to fetch batch', { error: err.message });

        const statusCode = err.message.includes('not found') ? 404 : 500;
        res.status(statusCode).json({ status: 'error', error: err.message });
    }
});

/**
 * POST /api/benchmark/batch/:id/reconcile
 * Persist authoritative result and judge counters for a terminal batch.
 */
router.post('/batch/:id/reconcile', async (req, res) => {
    try {
        if (!validateObjectId(req.params.id, res, 'Batch ID')) return;

        const batch = await BenchmarkBatch.findById(req.params.id);
        if (!batch) {
            return res.status(404).json({ status: 'error', error: 'Batch not found' });
        }
        if (['running', 'judging'].includes(batch.status) || batch.judge_status === 'running') {
            return res.status(409).json({
                status: 'error',
                error: 'Active batches must finish or use the explicit recovery action before reconciliation'
            });
        }

        await batch.reconcileFromResults({
            status: batch.status,
            timelineEvent: 'manual_reconcile'
        });
        const data = await benchmarkService.getBatch(req.params.id);
        res.json({ status: 'success', data });
    } catch (err) {
        logger.error('Failed to reconcile batch', { error: err.message, batchId: req.params.id });
        res.status(500).json({ status: 'error', error: err.message });
    }
});

/**
 * GET /api/benchmark/batch/:id/stream
 * Server-Sent Events stream for live batch progress
 */
router.get('/batch/:id/stream', async (req, res) => {
    if (!validateObjectId(req.params.id, res, 'Batch ID')) return;
    const batchId = req.params.id;

    res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no'
    });
    res.write('\n');

    let closed = false;
    let lastHash = '';

    const send = (event, data) => {
        if (closed) return;
        res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };

    const tick = async () => {
        if (closed) return;
        try {
            const batch = await BenchmarkBatch.findById(batchId)
                .select('status completed failed total_tests current_test judge_status judge_stats started_at completed_at last_activity_at')
                .lean();
            if (!batch) { send('error', { message: 'Batch not found' }); res.end(); closed = true; return; }

            // Only push when data changed
            const hash = `${batch.status}:${batch.completed}:${batch.failed}:${batch.judge_stats?.completed || 0}:${JSON.stringify(batch.current_test || {})}`;
            if (hash !== lastHash) {
                lastHash = hash;
                send('progress', batch);
            }

            // End stream on terminal status
            if (['completed', 'failed', 'stopped', 'interrupted'].includes(batch.status)) {
                send('done', { status: batch.status });
                res.end();
                closed = true;
            }
        } catch (err) {
            logger.debug('SSE tick error', { batchId, error: err.message });
        }
    };

    // Poll DB every 2s and push changes
    const interval = setInterval(tick, 2000);
    tick();

    req.on('close', () => { closed = true; clearInterval(interval); });
});

/**
 * GET /api/benchmark/batches
 * Get all batch runs
 */
router.get('/batches', async (req, res) => {
    try {
        const limit = parsePositiveInt(req.query.limit, 20, 100);
        const status = req.query.status || null;
        const tag = typeof req.query.tag === 'string' ? req.query.tag.trim() : null;
        if (tag && tag.length > 50) {
            return res.status(400).json({ status: 'error', error: 'tag must be 50 characters or less' });
        }

        const data = await benchmarkService.getBatches({ limit, status, tag });

        res.json({
            status: 'success',
            data
        });
    } catch (err) {
        logger.error('Failed to fetch batches', { error: err.message });
        res.status(500).json({ status: 'error', error: err.message });
    }
});

/**
 * GET /api/benchmark/batches/active
 * Get all currently running batches across all clients
 */
router.get('/batches/active', async (req, res) => {
    try {
        const batches = await BenchmarkBatch.getActive().lean();

        // Add activity status and stuck detection
        const now = Date.now();
        const enriched = batches.map(batch => {
            const lastActivity = batch.last_activity_at ? new Date(batch.last_activity_at).getTime() : batch.started_at ? new Date(batch.started_at).getTime() : now;
            const inactiveSeconds = Math.floor((now - lastActivity) / 1000);
            const isStuck = inactiveSeconds > STUCK_THRESHOLD_SECONDS;

            return {
                ...batch,
                inactive_seconds: inactiveSeconds,
                is_stuck: isStuck,
                activity_status: isStuck ? 'stuck' : (inactiveSeconds > 60 ? 'slow' : 'active')
            };
        });

        res.json({
            status: 'success',
            data: enriched
        });
    } catch (err) {
        logger.error('Failed to fetch active batches', { error: err.message });
        res.status(500).json({ status: 'error', error: err.message });
    }
});

/**
 * GET /api/benchmark/batches/stuck
 * Get stuck batches (no activity for >5 minutes)
 */
router.get('/batches/stuck', async (req, res) => {
    try {
        const thresholdSeconds = parseInt(req.query.threshold, 10) || STUCK_THRESHOLD_SECONDS;
        const stuck = await BenchmarkBatch.findStuck(thresholdSeconds);

        res.json({
            status: 'success',
            data: stuck,
            threshold_seconds: thresholdSeconds
        });
    } catch (err) {
        logger.error('Failed to fetch stuck batches', { error: err.message });
        res.status(500).json({ status: 'error', error: err.message });
    }
});

/**
 * GET /api/benchmark/batch/:id/timeline
 * Get detailed execution timeline for a batch
 */
router.get('/batch/:id/timeline', async (req, res) => {
    try {
        if (!validateObjectId(req.params.id, res, 'Batch ID')) return;

        const batch = await BenchmarkBatch.findById(req.params.id).select('_id started_at').lean();

        if (!batch) {
            return res.status(404).json({ status: 'error', error: 'Batch not found' });
        }

        // Query timeline events from the external collection
        const timeline = await BenchmarkTimelineEntry.find({ batchId: batch._id })
            .sort({ timestamp: 1 })
            .lean();

        const enriched = timeline.map((event, index) => {
            const timeSinceStart = batch.started_at
                ? new Date(event.timestamp) - new Date(batch.started_at)
                : 0;

            return {
                ...event,
                time_since_start_ms: timeSinceStart,
                index
            };
        });

        // Calculate summary statistics
        const testEvents = timeline.filter(e => e.event === 'test_complete');
        const judgeEvents = timeline.filter(e => e.event === 'judge_complete');
        const errorEvents = timeline.filter(e => e.event === 'error');

        const avgTestDuration = testEvents.length > 0
            ? testEvents.reduce((sum, e) => sum + (e.duration_ms || 0), 0) / testEvents.length
            : null;

        const avgJudgeDuration = judgeEvents.length > 0
            ? judgeEvents.reduce((sum, e) => sum + (e.duration_ms || 0), 0) / judgeEvents.length
            : null;

        res.json({
            status: 'success',
            data: {
                batch_id: batch._id,
                timeline: enriched,
                summary: {
                    total_events: timeline.length,
                    tests_completed: testEvents.length,
                    tests_failed: errorEvents.length,
                    judges_completed: judgeEvents.length,
                    avg_test_duration_ms: avgTestDuration ? Math.round(avgTestDuration) : null,
                    avg_judge_duration_ms: avgJudgeDuration ? Math.round(avgJudgeDuration) : null,
                    started_at: batch.started_at,
                    last_event_at: timeline.length > 0 ? timeline[timeline.length - 1].timestamp : null
                }
            }
        });
    } catch (err) {
        logger.error('Failed to fetch batch timeline', { error: err.message, batchId: req.params.id });
        res.status(500).json({ status: 'error', error: err.message });
    }
});

/**
 * POST /api/benchmark/batch/:id/recover
 * Recover a stuck batch by marking it as interrupted
 */
router.post('/batch/:id/recover', async (req, res) => {
    try {
        if (!validateObjectId(req.params.id, res, 'Batch ID')) return;

        const batch = await BenchmarkBatch.findById(req.params.id);

        if (!batch) {
            return res.status(404).json({ status: 'error', error: 'Batch not found' });
        }

        if (!['running', 'judging'].includes(batch.status) && batch.judge_status !== 'running') {
            return res.status(400).json({
                status: 'error',
                error: `Batch is ${batch.status}, cannot recover`
            });
        }

        // Stop any active judging
        stopJudging(req.params.id);

        const reconciledBatch = await batch.markAsStopped({
            timelineEvent: 'recover_requested',
            timelineError: 'Batch manually recovered after being marked stuck'
        });

        res.json({
            status: 'success',
            message: 'Batch marked as stopped',
            data: reconciledBatch
        });
    } catch (err) {
        logger.error('Failed to recover batch', { error: err.message, batchId: req.params.id });
        res.status(500).json({ status: 'error', error: err.message });
    }
});

/**
 * POST /api/benchmark/batch/:id/rejudge-pending
 * Re-run judging on all pending results in a batch
 */
router.post('/batch/:id/rejudge-pending', async (req, res) => {
    try {
        if (!validateObjectId(req.params.id, res, 'Batch ID')) return;
        const requestBody = req.body || {};
        const concurrency = parsePositiveInt(requestBody.concurrency, 2);
        const requestedJudgeConfig = requestBody.judge_config || {};
        const multiJudge = resolveMultiJudge(requestBody.multi_judge);

        const preflight = await preflightJudgeBatch(req.params.id, { force: false });
        const readiness = await resolveReadyJudgeTarget({
            host: requestedJudgeConfig.host || preflight.judgeConfig?.host,
            model: requestedJudgeConfig.model || preflight.judgeConfig?.model
        });
        if (!readiness.ready) {
            return res.status(503).json(judgeUnavailablePayload(readiness, 'Pending-result judging'));
        }
        const judgeConfig = {
            ...(preflight.judgeConfig || {}),
            ...requestedJudgeConfig,
            host: readiness.target.host,
            model: readiness.target.model
        };

        logger.info('Rejudging pending results', {
            batchId: req.params.id,
            pendingCount: preflight.pendingCount,
            concurrency,
            multiJudgeEnabled: multiJudge.enabled
        });

        // Start judging in background, return immediately
        judgeBatch(req.params.id, {
            judgeConfig,
            concurrency,
            force: false,
            multiJudge
        }).catch(err => {
            logger.error('Background rejudge failed', { batchId: req.params.id, error: err.message });
        });

        res.json({
            status: 'success',
            message: 'Judging started in background. Use GET /batch/:id/judge/status to track progress.',
            data: {
                pending_count: preflight.pendingCount,
                concurrency
            }
        });
    } catch (err) {
        logger.error('Failed to start rejudge', { error: err.message, batchId: req.params.id });
        res.status(mapJudgeStartErrorStatus(err)).json({ status: 'error', error: err.message });
    }
});

/**
 * POST /api/benchmark/batch/:id/judge
 * Trigger judging on a completed batch
 */
router.post('/batch/:id/judge', async (req, res) => {
    try {
        if (!validateObjectId(req.params.id, res, 'Batch ID')) return;
        const requestBody = req.body || {};
        const concurrency = parsePositiveInt(requestBody.concurrency, 2);
        const force = parseBoolean(requestBody.force, false);
        const requestedJudgeConfig = requestBody.judge_config || {};
        const multiJudge = resolveMultiJudge(requestBody.multi_judge);
        const preflight = await preflightJudgeBatch(req.params.id, { force });
        const readiness = await resolveReadyJudgeTarget({
            host: requestedJudgeConfig.host || preflight.judgeConfig?.host,
            model: requestedJudgeConfig.model || preflight.judgeConfig?.model
        });
        if (!readiness.ready) {
            return res.status(503).json(judgeUnavailablePayload(readiness, 'Batch judging'));
        }
        const judgeConfig = {
            ...(preflight.judgeConfig || {}),
            ...requestedJudgeConfig,
            host: readiness.target.host,
            model: readiness.target.model
        };
        const options = {
            judgeConfig,
            concurrency,
            force,
            multiJudge
        };

        // Start judging in background
        judgeBatch(req.params.id, options).catch(err => {
            logger.error('Background judging failed', { batchId: req.params.id, error: err.message });
        });

        res.json({
            status: 'success',
            message: 'Judging started in background. Use GET /batch/:id/judge/status to track progress.',
            data: {
                pending_count: preflight.pendingCount,
                concurrency,
                force
            }
        });
    } catch (err) {
        logger.error('Failed to start judging', { error: err.message, batchId: req.params.id });
        res.status(mapJudgeStartErrorStatus(err)).json({ status: 'error', error: err.message });
    }
});

/**
 * GET /api/benchmark/batch/:id/judge/status
 * Get judge progress for a batch
 */
router.get('/batch/:id/judge/status', async (req, res) => {
    try {
        if (!validateObjectId(req.params.id, res, 'Batch ID')) return;

        const status = await getJudgingStatus(req.params.id);

        res.json({
            status: 'success',
            data: status
        });
    } catch (err) {
        logger.error('Failed to get judging status', { error: err.message, batchId: req.params.id });
        const statusCode = err.message.includes('not found') ? 404 : 500;
        res.status(statusCode).json({ status: 'error', error: err.message });
    }
});

/**
 * POST /api/benchmark/batch/:id/judge/stop
 * Stop active judging for a batch
 */
router.post('/batch/:id/judge/stop', async (req, res) => {
    try {
        if (!validateObjectId(req.params.id, res, 'Batch ID')) return;

        const result = await stopPersistedJudging(req.params.id);

        res.json({
            status: 'success',
            message: result.stopped
                ? 'Judging stop requested'
                : result.repaired
                    ? 'Stale judging state reconciled'
                    : 'No active judging to stop',
            data: {
                was_active: result.stopped,
                repaired: result.repaired || false,
                judge_status: result.judge_status || null
            }
        });
    } catch (err) {
        logger.error('Failed to stop judging', { error: err.message, batchId: req.params.id });
        res.status(500).json({ status: 'error', error: err.message });
    }
});

module.exports = router;
