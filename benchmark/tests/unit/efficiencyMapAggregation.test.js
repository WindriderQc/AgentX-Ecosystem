const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');

jest.mock('../../config/logger', () => ({
    info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn()
}));

const BenchmarkResult = require('../../models/BenchmarkResult');
const { getEfficiencyMap, MIN_TEST_COUNT } = require('../../src/services/benchmark/efficiencyMap');

let mongoServer;

beforeAll(async () => {
    mongoServer = await MongoMemoryServer.create();
    await mongoose.connect(mongoServer.getUri());
});

afterAll(async () => {
    await mongoose.disconnect();
    await mongoServer.stop();
});

afterEach(async () => {
    await BenchmarkResult.deleteMany({});
});

function resultRows(model, calibrated, raw) {
    return Array.from({ length: MIN_TEST_COUNT }, (_, index) => ({
        model,
        host: 'http://host-a:11434',
        prompt: `prompt-${index}`,
        prompt_category: 'coding',
        success: true,
        quality_score: 8,
        tokens_per_sec: raw,
        performance_baseline: { tokensPerSec: calibrated }
    }));
}

describe('Efficiency Map throughput aggregation', () => {
    it('prefers valid calibration, falls back to valid raw evidence, and quarantines invalid pairs', async () => {
        // Use the native collection to exercise aggregation against corrupt
        // historical values that current Mongoose setters would sanitize.
        await BenchmarkResult.collection.insertMany([
            ...resultRows('calibrated', 50, 10),
            ...resultRows('zero-calibration-fallback', 0, 20),
            ...resultRows('infinite-calibration-fallback', Infinity, 30),
            ...resultRows('nan-calibration-fallback', NaN, 25),
            ...resultRows('missing', null, 0),
            ...resultRows('infinite-raw', null, Infinity),
            ...resultRows('nan-raw', null, NaN),
            ...resultRows('review-pending', 80, 80).map(row => ({ ...row, needs_review: true }))
        ]);

        const map = await getEfficiencyMap();
        const rankedByModel = new Map(map.entries.map(entry => [entry.model, entry]));

        expect(rankedByModel.get('calibrated').avgTokPerSec).toBe(50);
        expect(rankedByModel.get('zero-calibration-fallback').avgTokPerSec).toBe(20);
        expect(rankedByModel.get('infinite-calibration-fallback').avgTokPerSec).toBe(30);
        expect(rankedByModel.get('nan-calibration-fallback').avgTokPerSec).toBe(25);
        expect(rankedByModel.has('missing')).toBe(false);
        expect(rankedByModel.has('infinite-raw')).toBe(false);
        expect(rankedByModel.has('nan-raw')).toBe(false);
        expect(rankedByModel.has('review-pending')).toBe(false);

        const unrankedByModel = new Map(map.unranked.map(entry => [entry.model, entry]));
        expect(unrankedByModel.get('missing')).toMatchObject({
            avgTokPerSec: null,
            efficiencyScore: null,
            throughputTestCount: 0,
            unrankedReason: 'missing_throughput'
        });
        expect(unrankedByModel.get('infinite-raw')).toMatchObject({
            avgTokPerSec: null,
            efficiencyScore: null,
            throughputTestCount: 0,
            unrankedReason: 'missing_throughput'
        });
        expect(unrankedByModel.get('nan-raw')).toMatchObject({
            avgTokPerSec: null,
            efficiencyScore: null,
            throughputTestCount: 0,
            unrankedReason: 'missing_throughput'
        });
        expect(map.meta).toMatchObject({
            totalModels: 7,
            totalCombinations: 7,
            rankedModels: 4,
            rankedCombinations: 4,
            unrankedCombinations: 3,
            throughputSamples: 20,
            unrankedReasonCounts: { missing_throughput: 3 }
        });
    });
});
