'use strict';
const express = require('express');
const router = express.Router();
const os = require('os');
const mongoose = require('mongoose');

// GET /api/metrics/summary
router.get('/summary', async (_req, res) => {
    try {
        const mem = process.memoryUsage();
        const uptimeSec = process.uptime();

        const conn = mongoose.connection;
        let collectionsCount = 0;
        try {
            const collections = await conn.db.listCollections().toArray();
            collectionsCount = collections.length;
        } catch { /* ignore if db not ready */ }

        res.json({
            status: 'success',
            data: {
                process: {
                    pid: process.pid,
                    uptimeSeconds: Math.round(uptimeSec),
                    uptimeFormatted: formatUptime(uptimeSec),
                    memoryUsage: {
                        rss: +(mem.rss / 1048576).toFixed(1),
                        heapUsed: +(mem.heapUsed / 1048576).toFixed(1),
                        heapTotal: +(mem.heapTotal / 1048576).toFixed(1),
                        external: +(mem.external / 1048576).toFixed(1),
                    },
                    nodeVersion: process.version,
                },
                os: {
                    platform: os.platform(),
                    arch: os.arch(),
                    cpus: os.cpus().length,
                    totalMemoryMB: +(os.totalmem() / 1048576).toFixed(0),
                    freeMemoryMB: +(os.freemem() / 1048576).toFixed(0),
                    loadAvg: os.loadavg().map(n => +n.toFixed(2)),
                },
                mongo: {
                    readyState: conn.readyState,
                    host: conn.host || null,
                    name: conn.name || null,
                    collections: collectionsCount,
                },
            },
        });
    } catch (err) {
        res.status(500).json({ status: 'error', message: err.message });
    }
});

// GET /api/metrics/database
router.get('/database', async (_req, res) => {
    try {
        const db = mongoose.connection.db;
        const [stats, collections] = await Promise.all([
            db.stats(),
            db.listCollections().toArray(),
        ]);

        const collectionDetails = await Promise.all(
            collections.map(async (c) => {
                try {
                    const cStats = await db.collection(c.name).stats();
                    return {
                        name: c.name,
                        count: cStats.count || 0,
                        avgObjSize: cStats.avgObjSize || 0,
                        storageSize: cStats.storageSize || 0,
                    };
                } catch {
                    return { name: c.name, count: 0, avgObjSize: 0, storageSize: 0 };
                }
            })
        );

        res.json({
            status: 'success',
            data: {
                totals: {
                    dataSize: stats.dataSize || 0,
                    storageSize: stats.storageSize || 0,
                    indexes: stats.indexes || 0,
                    collections: collections.length,
                },
                collections: collectionDetails.sort((a, b) => b.storageSize - a.storageSize),
            },
        });
    } catch (err) {
        res.status(500).json({ status: 'error', message: err.message });
    }
});

function formatUptime(sec) {
    const d = Math.floor(sec / 86400);
    const h = Math.floor((sec % 86400) / 3600);
    const m = Math.floor((sec % 3600) / 60);
    const parts = [];
    if (d) parts.push(`${d}d`);
    if (h) parts.push(`${h}h`);
    parts.push(`${m}m`);
    return parts.join(' ');
}

module.exports = router;
