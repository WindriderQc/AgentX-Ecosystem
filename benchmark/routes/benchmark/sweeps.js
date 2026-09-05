'use strict';

const express = require('express');
const router = express.Router();
const { buildSweepPlan } = require('../../src/services/benchmark/sweepCoordinator');
const { runSweep } = require('../../src/services/benchmark/sweepRunner');
const {
    buildLaneRecommendation,
    formatRecommendation,
    formatLedgerEntry
} = require('../../src/services/benchmark/recommendationEngine');
const { analyzeStaleness, formatStalenessLedgerEntry } = require('../../src/services/benchmark/stalenessCrawler');
const { gatherCandidates, formatIntakeTable } = require('../../src/services/benchmark/intakeScanner');
const hfClient = require('../../src/clients/hfClient');
const ModelContextProfile = require('../../models/ModelContextProfile');
const ModelProfile = require('../../models/ModelProfile');
const ModelPerformanceProfile = require('../../models/ModelPerformanceProfile');
const { startBatch } = require('../../src/services/benchmark/execution');
const { runPreflight } = require('../../src/services/benchmark/preflight');
const { findActiveProfilingForHost, activeProfileQueues } = require('../../src/services/profiler/activeProfileState');
const { startProfileHostQueue } = require('../profiler/pipeline');
const BenchmarkBatch = require('../../models/BenchmarkBatch');
const logger = require('../../config/logger');
const {
    resolveReadyJudgeTarget,
    judgeUnavailablePayload
} = require('../../src/services/benchmark/judgeReadiness');

/**
 * POST /api/benchmark/sweeps/plan
 *
 * Builds a per-host candidate sweep plan without starting long-running work.
 * The response includes:
 * - payloads.profileQueue for /api/profiler/pipeline/profile-host
 * - payloads.benchmark for /api/benchmark/batch when models are ready
 */
router.post('/sweeps/plan', async (req, res) => {
    try {
        const plan = await buildSweepPlan(req.body || {});
        res.json({ status: 'success', data: plan });
    } catch (err) {
        logger.warn('Sweep plan failed', { error: err.message });
        const statusCode = /required|not found|unreachable/i.test(err.message) ? 400 : 500;
        res.status(statusCode).json({ status: 'error', error: err.message });
    }
});

/**
 * POST /api/benchmark/sweeps/run
 *
 * Guarded executor over the planner. Requires `execute: true` to do anything
 * (otherwise returns a dry-run plan). Rejects when a benchmark batch is active
 * or the host has an active profile queue. Runs preflight before launching a
 * batch. Never mutates routing truth.
 *
 * Auto-profiling: when candidates need profiling the driver starts a profile
 * queue (reusing the exact /profile-host logic via `startProfileHostQueue`),
 * polls it to terminal state within `maxWaitMs`, re-plans, then benchmarks. If
 * the queue is still running at the wait ceiling, it returns `phase: 'profiling'`
 * with the `queueId` so the caller can re-run once it finishes.
 */
router.post('/sweeps/run', async (req, res) => {
    try {
        let sweepInput = req.body || {};
        if (sweepInput.execute === true) {
            const readiness = await resolveReadyJudgeTarget({
                host: sweepInput.judge_config?.host,
                model: sweepInput.judge_config?.model
            });
            if (!readiness.ready) {
                return res.status(503).json(judgeUnavailablePayload(readiness, 'Sweep benchmark'));
            }
            sweepInput = {
                ...sweepInput,
                judge_config: {
                    ...(sweepInput.judge_config || {}),
                    host: readiness.target.host,
                    model: readiness.target.model
                }
            };
        }

        const result = await runSweep(sweepInput, {
            buildSweepPlan,
            getActiveBatches: () => BenchmarkBatch.getActive(),
            findActiveProfilingForHost,
            runPreflight,
            startBatch,
            startProfileQueue: async (payload) => {
                const data = await startProfileHostQueue(payload);
                return { queueId: data.queueId };
            },
            getQueueStatus: async (queueId) => {
                const tracker = activeProfileQueues.get(queueId);
                return { status: tracker ? tracker.status : 'failed' };
            }
        });
        res.json({ status: 'success', data: result });
    } catch (err) {
        logger.warn('Sweep run failed', { error: err.message });
        const statusCode = err.statusCode || (/required|not found|unreachable/i.test(err.message) ? 400 : 500);
        res.status(statusCode).json({ status: 'error', error: err.message });
    }
});

/**
 * POST /api/benchmark/sweeps/recommend
 *
 * Turns per-lane candidate metrics into a ratification-ready routing diff with
 * lane-specific weights + margin/latency/reliability guards. Read-only: emits a
 * recommendation (`promote` | `keep` | `inconclusive`) — it never mutates
 * routing truth (applying a promotion stays a human step).
 *
 * Body: { lane, candidates:[{model,quality?,composite?,latencyMs?,tokensPerSec?,failures?,vramMiB?}],
 *         incumbent?, host?, weights?, guards? }
 * `model` is required for every candidate. Promotion additionally requires an
 * explicit incumbent and numeric composite/latencyMs/failures evidence for
 * both the winner and incumbent; incomplete comparisons and score ties cannot
 * promote. Candidate metrics, custom weights, and custom guards are
 * type/range validated by the recommendation engine.
 */
router.post('/sweeps/recommend', async (req, res) => {
    try {
        const observation = buildLaneRecommendation(req.body || {});
        const trustVerdict = {
            contract: 'agentx.benchmark-consumer-trust/v1',
            requestedScope: 'exploratory',
            state: 'exploratory',
            comparable: false,
            qualified: false,
            qualification: 'insufficient',
            highConfidenceAllowed: false,
            claim: 'top_exploratory_observation',
            reasons: ['caller_supplied_metrics', 'qualified_receipt_unavailable'],
            topObservation: {
                model: observation.winner,
                host: observation.host,
                score: observation.winnerScore
            },
            qualifiedWinner: null,
            cohort: null
        };
        const rec = {
            ...observation,
            recommendation: observation.recommendation === 'promote'
                ? 'inconclusive'
                : observation.recommendation,
            reasons: observation.recommendation === 'promote'
                ? [...observation.reasons, 'qualified Benchmark trust receipt and ratification are required before promotion']
                : observation.reasons,
            winnerMeaning: 'top_lane_score_observation',
            qualifiedWinner: null,
            trustVerdict
        };
        rec.summary = formatRecommendation(rec);
        const ledgerInput = req.body?.ledger;
        if (ledgerInput != null && (!ledgerInput || typeof ledgerInput !== 'object' || Array.isArray(ledgerInput))) {
            const ledgerError = new Error('ledger must be an object');
            ledgerError.statusCode = 400;
            throw ledgerError;
        }
        const ledgerDraft = formatLedgerEntry(rec, {
            date: new Date().toISOString().slice(0, 10),
            ...(ledgerInput || {})
        });
        res.json({ status: 'success', data: { ...rec, ledgerDraft } });
    } catch (err) {
        const statusCode = err.statusCode || 500;
        if (statusCode === 500) logger.error('Sweep recommend failed', { error: err.message });
        res.status(statusCode).json({ status: 'error', error: err.message });
    }
});

/**
 * GET /api/benchmark/sweeps/staleness?hostId=<optional>
 *
 * Read-only crawl of benchmark model state for stale/invalid evidence before it
 * breaks a sweep: stale context profiles / readiness / performance evidence, and
 * invalid recorded throughput. Returns a
 * per-host report + suggested re-profile payloads (NOT auto-run). The
 * missing-profile check additionally accepts `routedModelsByHost` as a JSON
 * query input when callers can supply current routing.
 */
router.get('/sweeps/staleness', async (req, res) => {
    try {
        const hostFilter = req.query.hostId || null;
        let routedModelsByHost;
        if (req.query.routedModelsByHost) {
            try { routedModelsByHost = JSON.parse(req.query.routedModelsByHost); } catch (_) { /* ignore */ }
        }
        const [contextProfiles, profiles, performanceProfiles] = await Promise.all([
            ModelContextProfile.find({}).lean(),
            ModelProfile.find({}).select('name readiness').lean(),
            ModelPerformanceProfile.find({}).lean()
        ]);
        const report = analyzeStaleness({ contextProfiles, profiles, performanceProfiles, routedModelsByHost, hostFilter });
        const ledgerDraft = formatStalenessLedgerEntry(report, { date: new Date().toISOString().slice(0, 10) });
        res.json({ status: 'success', data: { ...report, ledgerDraft } });
    } catch (err) {
        logger.error('Sweep staleness crawl failed', { error: err.message });
        res.status(500).json({ status: 'error', error: err.message });
    }
});

/**
 * GET /api/benchmark/sweeps/intake?families=qwen,gemma&limit=10[&markdown=1]
 *
 * Discovers GGUF candidate models from HuggingFace and returns a prioritized
 * metadata-intake queue with parsed parameter/MoE fields. This HTTP adapter
 * does not supply host VRAM/context, so fit, suggested host, and lane remain
 * unassigned. Read-only: discovery only, deploys/benchmarks nothing.
 */
router.get('/sweeps/intake', async (req, res) => {
    try {
        const families = (req.query.families ? String(req.query.families) : 'qwen,gemma,llama,mistral,phi,deepseek')
            .split(',').map((s) => s.trim()).filter(Boolean);
        const limit = Math.min(50, parseInt(req.query.limit, 10) || 12);
        const records = await gatherCandidates({
            families,
            limit,
            fetchFamily: hfClient.fetchFamily,
            date: new Date().toISOString().slice(0, 10),
            onWarn: (m) => logger.warn('Sweep intake fetch', { detail: m })
        });
        if (req.query.markdown) {
            res.type('text/markdown').send(formatIntakeTable(records));
            return;
        }
        res.json({
            status: 'success',
            data: {
                count: records.length,
                highPriority: records.filter((r) => r.priority === 'high').length,
                records
            }
        });
    } catch (err) {
        logger.error('Sweep intake failed', { error: err.message });
        res.status(500).json({ status: 'error', error: err.message });
    }
});

module.exports = router;
