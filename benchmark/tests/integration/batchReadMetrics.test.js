'use strict';

const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');
const mongoOptions = require('../../../shared/testing/mongoOptions');
const BenchmarkBatch = require('../../models/BenchmarkBatch');
const BenchmarkResult = require('../../models/BenchmarkResult');
const { getBatch } = require('../../src/services/benchmark/batches');

let mongoServer;

beforeAll(async () => {
    mongoServer = await MongoMemoryServer.create();
    await mongoose.connect(mongoServer.getUri(), mongoOptions);
}, 15000);

afterAll(async () => {
    await mongoose.disconnect();
    await mongoServer?.stop();
});

async function readMetrics(rows) {
    const batchId = new mongoose.Types.ObjectId();
    // Seed raw persisted rows so legacy missing/non-numeric fields survive
    // schema casting, as they do when getBatch reads existing collections.
    await BenchmarkBatch.collection.insertOne({
        _id: batchId, run_name: 'missing-metric-regression', host: 'http://localhost:11434',
        models: ['test-model'], levels: [2], total_tests: rows.length,
        status: 'completed', created_at: new Date(), completed_at: new Date()
    });
    await BenchmarkResult.collection.insertMany(rows.map((row, index) => ({
        batch_id: batchId, model: 'test-model', host: 'http://localhost:11434',
        prompt_name: `prompt-${index}`, prompt: 'Fixture', response: 'Answer',
        success: true, timestamp: new Date(), ...row
    })));
    const batch = await getBatch(String(batchId), { includeAllResults: true });
    return batch.per_model_counters['test-model'].metrics;
}

test('pending and excluded quality rows do not become zero scores in batch summaries', async () => {
    const metrics = await readMetrics([
        { quality_score: 8, scoring_method: 'llm', latency: 100, scoring_time_ms: 20 },
        { quality_score: 0, scoring_method: 'llm', latency: 300, scoring_time_ms: 40 },
        { quality_score: null, scoring_method: 'pending', latency: null, scoring_time_ms: null },
        { quality_score: 9, scoring_method: 'llm', excluded_from_leaderboard: true }
    ]);
    expect(metrics.quality).toMatchObject({ n: 2, mean: 4, min: 0, max: 8, p50: 4 });
    expect(metrics.latency).toMatchObject({ n: 2, mean: 200, min: 100, max: 300 });
    expect(metrics.judge_ms).toMatchObject({ n: 2, mean: 30, min: 20, max: 40 });
});

test('an entirely unscored model has no quality estimate', async () => {
    const metrics = await readMetrics([
        { quality_score: null, scoring_method: 'pending' },
        { quality_score: null, scoring_method: 'llm_failed', needs_review: true }
    ]);
    expect(metrics.quality).toEqual({ n: 0 });
    expect(metrics.latency).toEqual({ n: 0 });
    expect(metrics.judge_ms).toEqual({ n: 0 });
});

test('legacy coercible and non-finite values are not measured durations', async () => {
    const metrics = await readMetrics([
        { latency: '' }, { latency: false }, { latency: '12' },
        { latency: NaN }, { latency: Infinity }, { latency: -1 }, { latency: 0 }
    ]);
    expect(metrics.latency).toMatchObject({ n: 1, mean: 0, min: 0, max: 0 });
});
