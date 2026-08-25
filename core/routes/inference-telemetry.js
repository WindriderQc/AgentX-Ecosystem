'use strict';
const express = require('express');
const router = express.Router();
const InferenceLog = require('../models/InferenceLog');
const { describeHost } = require('../src/services/hostIdentityService');

const DEFAULT_HOURS = 24;
const MAX_HOURS = 720;
const DEFAULT_BUCKET_MINUTES = 60;
const MAX_BUCKET_MINUTES = 1440;
const COLD_START_SUSPECT_MS = 60000;

function boundedPositiveInteger(value, fallback, maximum) {
    const parsed = parseInt(value, 10);
    if (!Number.isFinite(parsed)) return fallback;
    return Math.min(Math.max(parsed, 1), maximum);
}

function boundedFilterText(value, maximum = 200) {
    const text = String(value == null ? '' : value).trim();
    return text ? text.slice(0, maximum) : '';
}

function escapeRegex(value) {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function buildFilter(query) {
    const hours = boundedPositiveInteger(query.hours, DEFAULT_HOURS, MAX_HOURS);
    const filter = { timestamp: { $gte: new Date(Date.now() - hours * 3600000) } };
    if (query.host) filter.host = query.host;
    if (query.model) filter.model = query.model;
    if (query.caller) filter.caller = query.caller;
    const callerDetail = boundedFilterText(query.callerDetail);
    const callerDetailPrefix = boundedFilterText(query.callerDetailPrefix, 100);
    if (callerDetail) filter.callerDetail = callerDetail;
    else if (callerDetailPrefix) filter.callerDetail = new RegExp(`^${escapeRegex(callerDetailPrefix)}`);
    const taskType = boundedFilterText(query.taskType, 100);
    if (taskType) filter.taskType = taskType;
    if (query.status) filter.status = query.status;
    return filter;
}

// GET /api/telemetry/host-summary
router.get('/host-summary', async (req, res) => {
    try {
        const filter = buildFilter(req.query);
        const results = await InferenceLog.aggregate([
            { $match: filter },
            { $group: {
                _id: '$host',
                callCount: { $sum: 1 },
                avgLatencyMs: { $avg: '$durationMs' },
                errorCount: { $sum: { $cond: [{ $eq: ['$status', 'error'] }, 1, 0] } },
                totalTokensIn: { $sum: { $ifNull: ['$tokensIn', 0] } },
                totalTokensOut: { $sum: { $ifNull: ['$tokensOut', 0] } },
                models: { $push: '$model' },
            }},
            { $project: {
                host: '$_id', _id: 0,
                callCount: 1, avgLatencyMs: { $round: ['$avgLatencyMs', 0] },
                errorCount: 1,
                errorRate: { $round: [{ $multiply: [{ $divide: ['$errorCount', { $max: ['$callCount', 1] }] }, 100] }, 1] },
                totalTokensIn: 1, totalTokensOut: 1,
                models: 1,
            }},
            { $sort: { callCount: -1 } },
        ]);

        // Compute topModels from the pushed models array
        for (const r of results) {
            r.count = r.callCount;
            r.hostIdentity = describeHost(r.host);
            const freq = {};
            for (const m of r.models) freq[m] = (freq[m] || 0) + 1;
            r.topModels = Object.entries(freq)
                .sort((a, b) => b[1] - a[1])
                .slice(0, 3)
                .map(([model, count]) => ({ model, count }));
            delete r.models;
        }

        res.json({ status: 'success', data: results });
    } catch (err) {
        res.status(500).json({ status: 'error', message: err.message });
    }
});

// GET /api/telemetry/model-summary
router.get('/model-summary', async (req, res) => {
    try {
        const filter = buildFilter(req.query);
        const results = await InferenceLog.aggregate([
            { $match: filter },
            { $group: {
                _id: '$model',
                callCount: { $sum: 1 },
                avgLatencyMs: { $avg: '$durationMs' },
                errorCount: { $sum: { $cond: [{ $eq: ['$status', 'error'] }, 1, 0] } },
                avgTokensOut: { $avg: { $ifNull: ['$tokensOut', 0] } },
                hosts: { $addToSet: '$host' },
            }},
            { $project: {
                model: '$_id', _id: 0,
                callCount: 1, avgLatencyMs: { $round: ['$avgLatencyMs', 0] },
                errorCount: 1,
                errorRate: { $round: [{ $multiply: [{ $divide: ['$errorCount', { $max: ['$callCount', 1] }] }, 100] }, 1] },
                avgTokensOut: { $round: ['$avgTokensOut', 0] },
                hosts: 1,
            }},
            { $sort: { callCount: -1 } },
        ]);
        for (const result of results) result.count = result.callCount;
        res.json({ status: 'success', data: results });
    } catch (err) {
        res.status(500).json({ status: 'error', message: err.message });
    }
});

// GET /api/telemetry/caller-summary
router.get('/caller-summary', async (req, res) => {
    try {
        const filter = buildFilter(req.query);
        const results = await InferenceLog.aggregate([
            { $match: filter },
            { $group: {
                _id: '$caller',
                callCount: { $sum: 1 },
                avgLatencyMs: { $avg: '$durationMs' },
                errorCount: { $sum: { $cond: [{ $eq: ['$status', 'error'] }, 1, 0] } },
            }},
            { $project: {
                caller: '$_id', _id: 0,
                callCount: 1, avgLatencyMs: { $round: ['$avgLatencyMs', 0] },
                errorCount: 1,
                errorRate: { $round: [{ $multiply: [{ $divide: ['$errorCount', { $max: ['$callCount', 1] }] }, 100] }, 1] },
            }},
            { $sort: { callCount: -1 } },
        ]);
        for (const result of results) result.count = result.callCount;
        res.json({ status: 'success', data: results });
    } catch (err) {
        res.status(500).json({ status: 'error', message: err.message });
    }
});

// GET /api/telemetry/timeline
router.get('/timeline', async (req, res) => {
    try {
        const filter = buildFilter(req.query);
        const bucketMinutes = boundedPositiveInteger(
            req.query.bucketMinutes,
            DEFAULT_BUCKET_MINUTES,
            MAX_BUCKET_MINUTES
        );

        const results = await InferenceLog.aggregate([
            { $match: filter },
            { $group: {
                _id: {
                    bucket: {
                        $dateTrunc: { date: '$timestamp', unit: 'minute', binSize: bucketMinutes }
                    },
                    host: '$host',
                },
                calls: { $sum: 1 },
                avgLatencyMs: { $avg: '$durationMs' },
                errors: { $sum: { $cond: [{ $eq: ['$status', 'error'] }, 1, 0] } },
                latencies: { $push: '$durationMs' },
            }},
            { $sort: { '_id.bucket': 1 } },
        ]);

        // Reshape into bucket-keyed structure
        const bucketMap = {};
        for (const r of results) {
            const key = r._id.bucket.toISOString();
            if (!bucketMap[key]) {
                bucketMap[key] = { bucket: key, calls: 0, avgLatencyMs: 0, errors: 0, byHost: {}, _latencies: [] };
            }
            const b = bucketMap[key];
            b.calls += r.calls;
            b.errors += r.errors;
            b.byHost[r._id.host] = (b.byHost[r._id.host] || 0) + r.calls;
            b._latencies.push(...(r.latencies || []));
        }

        const sparseTimeline = Object.values(bucketMap).map(b => {
            const sorted = b._latencies.filter(n => typeof n === 'number').sort((a, c) => a - c);
            const serving = sorted.filter(value => value < COLD_START_SUSPECT_MS);
            const coldStarts = sorted.filter(value => value >= COLD_START_SUSPECT_MS);
            const p95Idx = Math.floor(serving.length * 0.95);
            return {
                bucket: b.bucket,
                calls: b.calls,
                avgLatencyMs: serving.length ? Math.round(serving.reduce((s, v) => s + v, 0) / serving.length) : null,
                p95LatencyMs: serving.length ? serving[Math.min(p95Idx, serving.length - 1)] : null,
                errors: b.errors,
                byHost: b.byHost,
                coldStartSuspectedCount: coldStarts.length,
                coldStartSuspectedMaxMs: coldStarts.length ? coldStarts[coldStarts.length - 1] : null,
            };
        });

        const timeline = densifyTimeline(sparseTimeline, bucketMinutes);

        res.json({ status: 'success', data: timeline });
    } catch (err) {
        res.status(500).json({ status: 'error', message: err.message });
    }
});

function densifyTimeline(timeline, bucketMinutes) {
    if (!Array.isArray(timeline) || timeline.length < 2) return timeline || [];
    const sorted = [...timeline].sort((left, right) => new Date(left.bucket) - new Date(right.bucket));
    const stepMs = bucketMinutes * 60000;
    const byTimestamp = new Map(sorted.map(bucket => [new Date(bucket.bucket).getTime(), bucket]));
    const dense = [];
    const start = new Date(sorted[0].bucket).getTime();
    const end = new Date(sorted[sorted.length - 1].bucket).getTime();
    for (let timestamp = start; timestamp <= end; timestamp += stepMs) {
        dense.push(byTimestamp.get(timestamp) || {
            bucket: new Date(timestamp).toISOString(),
            calls: 0,
            avgLatencyMs: null,
            p95LatencyMs: null,
            errors: 0,
            byHost: {},
            coldStartSuspectedCount: 0,
            coldStartSuspectedMaxMs: null,
        });
    }
    return dense;
}

module.exports = router;
module.exports.buildFilter = buildFilter;
module.exports.densifyTimeline = densifyTimeline;
module.exports.COLD_START_SUSPECT_MS = COLD_START_SUSPECT_MS;
