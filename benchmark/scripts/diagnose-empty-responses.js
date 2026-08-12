#!/usr/bin/env node
/**
 * Diagnose Empty Responses
 *
 * Aggregates BenchmarkResult records to surface empty-response patterns by
 * model/host/done_reason. Encodes the diagnostic playbook for "why did this
 * model return nothing" — cross-references scoring_method, done_reason,
 * latency, tokens, and execution_settings.num_predict.
 *
 * Usage:   node scripts/diagnose-empty-responses.js
 * Require: MONGODB_URI env (falls back to 192.0.2.33:27017/agentx).
 */

require('dotenv').config();
const mongoose = require('mongoose');

const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://192.0.2.33:27017/agentx';

async function run() {
    await mongoose.connect(MONGODB_URI);
    const BenchmarkResult = require('../models/BenchmarkResult');

    console.log('=== Empty Response Diagnosis ===\n');

    // 1. Overall empty-response stats by model+host.
    const byModel = await BenchmarkResult.aggregate([
        { $match: { success: true } },
        {
            $group: {
                _id: { model: '$model', host: '$host' },
                total: { $sum: 1 },
                empty: {
                    $sum: { $cond: [{ $eq: ['$scoring_method', 'empty_response'] }, 1, 0] }
                }
            }
        },
        { $match: { empty: { $gt: 0 } } },
        { $sort: { empty: -1 } }
    ]);

    console.log('Models with empty responses:');
    console.log('-'.repeat(90));
    console.log(`${'Model'.padEnd(40)} ${'Host'.padEnd(25)} ${'Empty'.padStart(6)} ${'Total'.padStart(6)} ${'Rate'.padStart(6)}`);
    console.log('-'.repeat(90));
    for (const m of byModel) {
        const rate = ((m.empty / m.total) * 100).toFixed(0);
        const host = (m._id.host || '').replace(/https?:\/\//, '').slice(0, 23);
        console.log(`${(m._id.model || '').padEnd(40)} ${host.padEnd(25)} ${String(m.empty).padStart(6)} ${String(m.total).padStart(6)} ${(rate + '%').padStart(6)}`);
    }

    // 2. Empty-response detail grouped by done_reason (the Ollama stop reason).
    console.log('\n\n=== Empty Response Details (by done_reason) ===\n');
    const details = await BenchmarkResult.aggregate([
        { $match: { success: true, scoring_method: 'empty_response' } },
        {
            $group: {
                _id: { model: '$model', done_reason: '$truncation.done_reason' },
                count: { $sum: 1 },
                avg_latency: { $avg: '$latency' },
                min_latency: { $min: '$latency' },
                max_latency: { $max: '$latency' },
                avg_tokens: { $avg: '$tokens' },
                hosts: { $addToSet: '$host' }
            }
        },
        { $sort: { '_id.model': 1, count: -1 } }
    ]);

    for (const d of details) {
        console.log(`${d._id.model} | done_reason: ${d._id.done_reason || 'null'}`);
        console.log(`  count: ${d.count} | latency: ${d.min_latency}-${d.max_latency}ms (avg ${Math.round(d.avg_latency)}ms) | avg_tokens: ${Math.round(d.avg_tokens || 0)}`);
        console.log(`  hosts: ${d.hosts.map((h) => (h || '').replace(/https?:\/\//, '')).join(', ')}`);
        console.log();
    }

    // 3. Latency distribution: empty vs non-empty.
    console.log('=== Latency Distribution: Empty vs Non-Empty ===\n');
    const latencyComp = await BenchmarkResult.aggregate([
        { $match: { success: true } },
        {
            $group: {
                _id: { $cond: [{ $eq: ['$scoring_method', 'empty_response'] }, 'empty', 'normal'] },
                count: { $sum: 1 },
                avg_latency: { $avg: '$latency' },
                min_latency: { $min: '$latency' },
                max_latency: { $max: '$latency' }
            }
        }
    ]);

    for (const l of latencyComp) {
        console.log(`${l._id}: count=${l.count}, avg=${Math.round(l.avg_latency)}ms, min=${l.min_latency}ms, max=${l.max_latency}ms`);
    }

    // 4. Sample execution_settings on empty responses.
    console.log('\n\n=== Execution Settings on Empty Responses (sample) ===\n');
    const samples = await BenchmarkResult.find({
        success: true,
        scoring_method: 'empty_response'
    }).select({
        model: 1, host: 1, latency: 1, tokens: 1,
        'truncation.done_reason': 1, 'truncation.response_tokens': 1,
        'execution_settings.num_predict': 1,
        prompt_category: 1, prompt_name: 1
    }).limit(10).lean();

    for (const s of samples) {
        console.log(`${s.model} @ ${(s.host || '').replace(/https?:\/\//, '')}`);
        console.log(`  prompt: ${s.prompt_name} (${s.prompt_category})`);
        console.log(`  latency: ${s.latency}ms | tokens: ${s.tokens} | done_reason: ${s.truncation?.done_reason || 'null'}`);
        console.log(`  num_predict: ${s.execution_settings?.num_predict || 'null'}`);
        console.log();
    }

    // 5. Models with 100% empty — any non-empty results anywhere?
    console.log('=== Models with 100% Empty — Any Non-Empty in Other Batches? ===\n');
    const fullEmpty = byModel.filter((m) => m.empty === m.total);
    for (const m of fullEmpty) {
        const nonEmpty = await BenchmarkResult.countDocuments({
            model: m._id.model,
            host: m._id.host,
            success: true,
            scoring_method: { $ne: 'empty_response' }
        });
        console.log(`${m._id.model}: ${nonEmpty > 0 ? nonEmpty + ' non-empty results exist elsewhere' : 'ZERO non-empty results anywhere'}`);
    }

    console.log('\n=== Diagnosis Complete ===');
    await mongoose.disconnect();
}

run().catch((err) => {
    console.error('Failed:', err.message);
    process.exit(1);
});
