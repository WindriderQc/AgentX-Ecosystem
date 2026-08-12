#!/usr/bin/env node
/**
 * Fairness report for a benchmark batch.
 *
 *   node scripts/fairness-report.js [batchId]
 *
 * If no batchId is supplied, the most recent completed batch is used.
 *
 * Surfaces the three fairness signals introduced for host-vs-host parity:
 *   1. num_ctx distribution per host  (did force_num_ctx take effect?)
 *   2. silent input truncation count  (did Ollama drop prompt tokens?)
 *   3. repeat-run variance per group  (is observed variance signal or RNG?)
 */

require('dotenv').config({ path: __dirname + '/../.env' });
const mongoose = require('mongoose');
const BR = require('../models/BenchmarkResult');
const Batch = require('../models/BenchmarkBatch');

function pad(s, n) { return String(s ?? '').padEnd(n); }
function fmt(n, d = 2) { return n == null ? '—' : Number(n).toFixed(d); }

async function resolveBatchId(arg) {
    if (arg) return arg;
    // Prefer completed; fall back to any with at least one persisted result.
    const latest = await Batch.findOne({ status: 'completed' }).sort({ completed_at: -1 }).select('_id run_name status completed_at').lean()
        || await Batch.findOne({ completed: { $gt: 0 } }).sort({ created_at: -1 }).select('_id run_name status completed_at').lean();
    if (!latest) {
        console.log('No batches with results found. Pass a batch ID explicitly: node scripts/fairness-report.js <batchId>');
        process.exit(0);
    }
    console.log(`Using latest batch: ${latest._id}  (${latest.run_name}, status=${latest.status})\n`);
    return latest._id.toString();
}

async function ctxDistribution(batchId) {
    return BR.aggregate([
        { $match: { batch_id: new mongoose.Types.ObjectId(batchId), success: true } },
        { $group: {
            _id: { host: '$host', model: '$model' },
            n: { $sum: 1 },
            ctxValues: { $addToSet: '$execution_settings.num_ctx' },
            ctxSources: { $addToSet: '$execution_settings.num_ctx_source' },
            seedValues: { $addToSet: '$execution_settings.seed' },
            tempValues: { $addToSet: '$execution_settings.temperature' }
        } },
        { $sort: { '_id.host': 1, '_id.model': 1 } }
    ]);
}

async function inputTruncation(batchId) {
    return BR.aggregate([
        { $match: { batch_id: new mongoose.Types.ObjectId(batchId), 'truncation.input_truncated': true } },
        { $group: {
            _id: { host: '$host', model: '$model' },
            n: { $sum: 1 },
            avg_quality: { $avg: '$quality_score' },
            avg_prompt_eval: { $avg: '$truncation.prompt_eval_count' },
            avg_budget: { $avg: '$truncation.input_budget' },
            samples: { $push: { prompt: '$prompt_name', q: '$quality_score', eval: '$truncation.prompt_eval_count', budget: '$truncation.input_budget' } }
        } },
        { $sort: { n: -1 } }
    ]);
}

async function repeatVariance(batchId) {
    return BR.getRepeatVariance({ batch_id: new mongoose.Types.ObjectId(batchId) });
}

async function pairedHostComparison(batchId) {
    // Same model + same prompt across hosts → quality and tps deltas
    return BR.aggregate([
        { $match: { batch_id: new mongoose.Types.ObjectId(batchId), success: true, quality_score: { $ne: null } } },
        { $group: {
            _id: { model: '$model', prompt: '$prompt_name', host: '$host' },
            q: { $avg: '$quality_score' },
            tps: { $avg: '$tokens_per_sec' },
            lat: { $avg: '$latency' },
            ctx: { $first: '$execution_settings.num_ctx' },
            n: { $sum: 1 }
        } },
        { $group: {
            _id: { model: '$_id.model', prompt: '$_id.prompt' },
            hosts: { $push: { host: '$_id.host', q: '$q', tps: '$tps', lat: '$lat', ctx: '$ctx', n: '$n' } }
        } },
        { $match: { 'hosts.1': { $exists: true } } },
        { $sort: { '_id.model': 1, '_id.prompt': 1 } }
    ]);
}

(async () => {
    await mongoose.connect(process.env.MONGODB_URI || 'mongodb://192.0.2.33:27017/agentx');
    const batchId = await resolveBatchId(process.argv[2]);

    console.log('═══ 1. num_ctx + sampling actually used (per host × model) ═══');
    const ctx = await ctxDistribution(batchId);
    console.log(pad('host', 36), pad('model', 40), pad('n', 4), pad('num_ctx', 16), pad('source', 18), pad('seed', 8), 'temp');
    for (const r of ctx) {
        console.log(
            pad(r._id.host, 36),
            pad(r._id.model, 40),
            pad(r.n, 4),
            pad(r.ctxValues.join(','), 16),
            pad(r.ctxSources.join(','), 18),
            pad(r.seedValues.join(','), 8),
            r.tempValues.join(',')
        );
    }
    if (ctx.length > 1) {
        const allCtx = new Set(ctx.flatMap(r => r.ctxValues));
        if (allCtx.size > 1) {
            console.log(`\n  ⚠ HOSTS RAN AT DIFFERENT CONTEXTS: ${[...allCtx].join(', ')} — set force_num_ctx for fair comparison.`);
        } else {
            console.log(`\n  ✓ All hosts ran at num_ctx=${[...allCtx][0]}`);
        }
    }

    console.log('\n═══ 2. Silent input truncation (prompt_eval_count exhausted budget) ═══');
    const trunc = await inputTruncation(batchId);
    if (trunc.length === 0) {
        console.log('  ✓ No silent input truncation detected.');
    } else {
        for (const t of trunc) {
            console.log(`\n  ${t._id.host}  ${t._id.model}  flagged=${t.n}  avg_quality=${fmt(t.avg_quality, 1)}/10  avg_prompt_eval=${Math.round(t.avg_prompt_eval)}/${Math.round(t.avg_budget)}`);
            for (const s of t.samples.slice(0, 5)) {
                console.log(`    - ${pad(s.prompt, 32)} q=${fmt(s.q, 1)}  eval=${s.eval}/${s.budget}`);
            }
            if (t.samples.length > 5) console.log(`    … (${t.samples.length - 5} more)`);
        }
        console.log('\n  ⚠ These results were likely answered with a truncated prompt — judge cannot detect this.');
    }

    console.log('\n═══ 3. Repeat-run variance (with seed pinned, low variance = stable; high = model ignores seed) ═══');
    const variance = await repeatVariance(batchId);
    if (variance.length === 0) {
        console.log('  (No repeat groups in this batch — set execution_config.repeats > 1 to enable.)');
    } else {
        console.log(pad('model', 32), pad('host', 28), pad('prompt', 28), 'runs', pad('q_avg', 6), pad('q_std', 6), pad('tps_std', 8), pad('lat_std', 8));
        for (const v of variance) {
            console.log(
                pad(v.model, 32),
                pad(v.host, 28),
                pad(v.prompt_name, 28),
                pad(v.runs, 4),
                pad(fmt(v.quality_avg, 1), 6),
                pad(fmt(v.quality_stddev, 2), 6),
                pad(fmt(v.tps_stddev, 2), 8),
                pad(Math.round(v.latency_stddev || 0), 8)
            );
        }
    }

    console.log('\n═══ 4. Paired host comparison (same model+prompt across hosts) ═══');
    const paired = await pairedHostComparison(batchId);
    if (paired.length === 0) {
        console.log('  (No paired prompts across multiple hosts.)');
    } else {
        for (const p of paired.slice(0, 30)) {
            const summary = p.hosts.map(h => `${h.host.replace(/^https?:\/\//, '').replace(/:\d+$/, '')}: q=${fmt(h.q, 1)} tps=${fmt(h.tps, 1)} ctx=${h.ctx}`).join('  |  ');
            console.log(`  ${pad(p._id.model, 28)} ${pad(p._id.prompt, 28)} ${summary}`);
        }
        if (paired.length > 30) console.log(`  … (${paired.length - 30} more paired prompts)`);
    }

    await mongoose.disconnect();
})().catch(e => { console.error(e); process.exit(1); });
