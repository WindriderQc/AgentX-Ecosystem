/**
 * Benchmark Routes - Judge Defaults & Roster
 *
 * Per-host default judge model configuration and judge roster with full stats.
 *
 * GET   /api/benchmark/judge-defaults              — get all per-host defaults
 * PUT   /api/benchmark/judge-defaults              — set default judge for a host
 * GET   /api/benchmark/judge-roster                — all judges from benchmark discovery with eval counts + per-host availability
 */

const express = require('express');
const router = express.Router();
const path = require('path');
const fs = require('fs');
const logger = require('../../config/logger');
const BenchmarkResult = require('../../models/BenchmarkResult');
const {
    getJudgeReadiness,
    resolveReadyJudgeTarget,
    judgeUnavailablePayload,
    toPublicReadiness
} = require('../../src/services/benchmark/judgeReadiness');

const DEFAULTS_PATH = process.env.JUDGE_DEFAULTS_PATH
    || path.join(process.cwd(), 'config', 'judge-host-defaults.json');

function normalizeModelName(name) {
    return String(name || '').trim().replace(/:latest$/i, '');
}

function isPotentialJudgeModel(modelName) {
    const n = String(modelName || '').toLowerCase().replace(/:latest$/i, '');
    if (!n) return false;
    if (/(embed|bert|diagnostic|coder)/.test(n)) return false;
    return /(instruct|chat|reason|r1|qwen|llama|mistral|gemma|deepseek|judge|reward|critic|command-r)/.test(n);
}

function readDefaults() {
    try {
        if (!fs.existsSync(DEFAULTS_PATH)) return {};
        const raw = fs.readFileSync(DEFAULTS_PATH, 'utf8');
        return JSON.parse(raw) || {};
    } catch {
        return {};
    }
}

function writeDefaults(data) {
    fs.mkdirSync(path.dirname(DEFAULTS_PATH), { recursive: true });
    fs.writeFileSync(DEFAULTS_PATH, JSON.stringify(data, null, 2), 'utf8');
}

router.get('/judge-defaults', async (req, res) => {
    try {
        const defaults = readDefaults();
        const readiness = await getJudgeReadiness();
        const hostDefaults = readiness.hosts.map((host) => ({
            hostUrl: host.hostUrl,
            hostName: host.hostName,
            defaultJudgeModel: defaults[host.hostUrl] || null,
            selectedJudgeModel: host.selectedModel,
            selectionSource: host.selectionSource,
            ready: host.ready
        }));
        res.json({ status: 'success', data: { hosts: hostDefaults, raw: defaults, readiness } });
    } catch (err) {
        logger.error('Failed to read judge defaults', { error: err.message });
        res.status(500).json({ status: 'error', error: err.message });
    }
});

router.put('/judge-defaults', async (req, res) => {
    try {
        const { hostUrl, judgeModel } = req.body;
        if (!hostUrl || typeof hostUrl !== 'string') {
            return res.status(400).json({ status: 'error', error: 'hostUrl is required' });
        }

        if (judgeModel) {
            const check = await resolveReadyJudgeTarget({ host: hostUrl, model: judgeModel });
            if (!check.ready) {
                return res.status(503).json(judgeUnavailablePayload(check, 'Judge selection'));
            }
        }

        const defaults = readDefaults();
        if (judgeModel) {
            defaults[hostUrl.trim()] = normalizeModelName(judgeModel);
        } else {
            delete defaults[hostUrl.trim()];
        }
        writeDefaults(defaults);
        logger.info('Judge default updated', { hostUrl, judgeModel });
        res.json({ status: 'success', data: { hostUrl, judgeModel: judgeModel ? normalizeModelName(judgeModel) : null } });
    } catch (err) {
        logger.error('Failed to write judge defaults', { error: err.message });
        res.status(500).json({ status: 'error', error: err.message });
    }
});

/**
 * GET /api/benchmark/judge/readiness
 * One operator-facing state for judge selection, reachability, and installed
 * model availability. A blocked state is an observation, so it returns 200.
 */
router.get('/judge/readiness', async (_req, res) => {
    try {
        const readiness = await getJudgeReadiness();
        res.set('Cache-Control', 'no-store');
        res.json({ status: 'success', data: readiness });
    } catch (err) {
        logger.error('Failed to determine judge readiness', { error: err.message });
        res.status(500).json({ status: 'error', error: 'Judge readiness check failed' });
    }
});

router.get('/judge-roster', async (req, res) => {
    try {
        const defaults = readDefaults();
        const readinessState = await getJudgeReadiness({ includeModels: true });
        const readiness = toPublicReadiness(readinessState);
        const hostModelMaps = readinessState.hosts.map((host) => ({
            host: {
                url: host.hostUrl,
                name: host.hostName,
                id: host.hostId
            },
            models: host.models,
            readiness: host
        }));

        const modelHostMap = new Map();
        hostModelMaps.forEach(({ host, models }) => {
            models.forEach((model) => {
                if (!modelHostMap.has(model.name)) modelHostMap.set(model.name, []);
                modelHostMap.get(model.name).push({ url: host.url, name: host.name, size: model.size });
            });
        });

        const evalAgg = await BenchmarkResult.aggregate([
            { $match: { judge_model: { $exists: true, $ne: null } } },
            { $group: {
                _id: '$judge_model',
                count: { $sum: 1 },
                avg_score: { $avg: '$quality_score' },
                success_count: {
                    $sum: {
                        $cond: [
                            { $and: [
                                { $ne: [{ $ifNull: ['$quality_score', null] }, null] },
                                { $ne: [{ $toLower: { $ifNull: ['$scoring_method', ''] } }, 'llm_failed'] }
                            ] },
                            1, 0
                        ]
                    }
                }
            } }
        ]);
        const liveEvalMap = new Map(evalAgg.map((entry) => [
            normalizeModelName(entry._id),
            {
                count: entry.count,
                avgScore: entry.avg_score != null ? Math.round(entry.avg_score * 10) / 10 : null,
                successRate: entry.count > 0
                    ? Math.round((entry.success_count / entry.count) * 1000) / 10
                    : null
            }
        ]));

        const discoveredNames = [...modelHostMap.keys()]
            .filter((modelName) => isPotentialJudgeModel(modelName));

        const allJudges = discoveredNames.map((modelName) => {
            const availableOn = modelHostMap.get(modelName) || [];
            const stats = liveEvalMap.get(modelName) || { count: 0, avgScore: null, successRate: null };
            return {
                modelName,
                evalCount: stats.count,
                avgScore: stats.avgScore,
                successRate: stats.successRate,
                availableOn,
                source: 'benchmark-discovery'
            };
        }).sort((left, right) => right.evalCount - left.evalCount);

        const hostPanels = hostModelMaps.map(({ host, readiness: hostReadiness }) => ({
            hostUrl: host.url,
            hostName: host.name,
            defaultJudgeModel: defaults[host.url] || null,
            selectedJudgeModel: hostReadiness.selectedModel,
            selectionSource: hostReadiness.selectionSource,
            judgeReady: hostReadiness.ready,
            readinessReason: hostReadiness.reason,
            reachable: hostReadiness.reachable,
            judges: allJudges.filter((judge) => judge.availableOn.some((entry) => entry.url === host.url))
        }));

        res.json({
            status: 'success',
            data: {
                judges: allJudges,
                hostPanels,
                defaults,
                readiness
            }
        });
    } catch (err) {
        logger.error('Failed to build judge roster', { error: err.message });
        res.status(500).json({ status: 'error', error: err.message });
    }
});

// ─── Question Discrimination ────────────────────────────────────────────────

const { computeDiscriminationStats, getDiscriminationSummary } = require('../../src/services/scoring/questionDiscrimination');

/**
 * GET /api/benchmark/question-discrimination
 * Per-question YES rates from decomposed judging.
 * Query params: ?batch_id=...&summary=true&flagged_only=true
 */
router.get('/question-discrimination', async (req, res) => {
    try {
        const filter = {};
        if (req.query.batch_id) filter.batch_id = req.query.batch_id;

        if (req.query.summary === 'true') {
            const summary = await getDiscriminationSummary(filter);
            return res.json({ status: 'success', data: summary });
        }

        const result = await computeDiscriminationStats(filter);

        if (req.query.flagged_only === 'true') {
            return res.json({
                status: 'success',
                data: {
                    flagged: result.flagged,
                    stats: result.stats
                }
            });
        }

        res.json({ status: 'success', data: result });
    } catch (err) {
        logger.error('Failed to compute question discrimination', { error: err.message });
        res.status(500).json({ status: 'error', error: err.message });
    }
});

module.exports = router;
