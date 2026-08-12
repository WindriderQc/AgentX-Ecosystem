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
const { getConfiguredHosts } = require('../../src/helpers/ollamaHostConfig');
const { benchmarkFetch: fetch } = require('../../src/services/benchmark/http');

const DEFAULTS_PATH = path.join(process.cwd(), 'config', 'judge-host-defaults.json');

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
    fs.writeFileSync(DEFAULTS_PATH, JSON.stringify(data, null, 2), 'utf8');
}

async function fetchHostModels(hostUrl) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 8000);
    try {
        const res = await fetch(`${hostUrl}/api/tags`, { method: 'GET', signal: controller.signal });
        clearTimeout(timeoutId);
        if (!res.ok) return [];
        const data = await res.json();
        return (data.models || []).map((model) => ({
            name: normalizeModelName(model.name || model.model || ''),
            size: model.size || 0,
            details: model.details || {}
        })).filter((model) => model.name);
    } catch {
        clearTimeout(timeoutId);
        return [];
    }
}

router.get('/judge-defaults', (req, res) => {
    try {
        const defaults = readDefaults();
        const hosts = getConfiguredHosts();
        const hostDefaults = hosts.map((host) => ({
            hostUrl: host.url,
            hostName: host.name,
            defaultJudgeModel: defaults[host.url] || null
        }));
        res.json({ status: 'success', data: { hosts: hostDefaults, raw: defaults } });
    } catch (err) {
        logger.error('Failed to read judge defaults', { error: err.message });
        res.status(500).json({ status: 'error', error: err.message });
    }
});

router.put('/judge-defaults', (req, res) => {
    try {
        const { hostUrl, judgeModel } = req.body;
        if (!hostUrl || typeof hostUrl !== 'string') {
            return res.status(400).json({ status: 'error', error: 'hostUrl is required' });
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

router.get('/judge-roster', async (req, res) => {
    try {
        const hosts = getConfiguredHosts();
        const defaults = readDefaults();

        const hostModelMaps = await Promise.all(
            hosts.map(async (host) => ({ host, models: await fetchHostModels(host.url) }))
        );

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

        const hostPanels = hosts.map((host) => ({
            hostUrl: host.url,
            hostName: host.name,
            defaultJudgeModel: defaults[host.url] || null,
            judges: allJudges.filter((judge) => judge.availableOn.some((entry) => entry.url === host.url))
        }));

        res.json({
            status: 'success',
            data: {
                judges: allJudges,
                hostPanels,
                defaults
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
