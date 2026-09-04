/**
 * Regression: applyScoresToResult must pass performance_baseline (and
 * time_to_first_token_ms) into calculateCompositeScore so that the persisted
 * composite_score reflects calibrated host metrics rather than raw single-run
 * latency/tps. Pre-fix, buildResultScoreContext exposed performance_baseline
 * but applyScoresToResult dropped it before calling the scorer.
 */

jest.mock('../../../config/logger', () => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn()
}));

const captured = [];
jest.mock('../../../models/BenchmarkResult', () => ({
    updateOne: jest.fn((filter, update) => {
        captured.push({ filter, update });
        return Promise.resolve({ acknowledged: true });
    })
}));

const BenchmarkResult = require('../../../models/BenchmarkResult');
const { applyScoresToResult } = require('../../../src/services/benchmark/judgeExecutor');

beforeEach(() => {
    captured.length = 0;
});

describe('applyScoresToResult — composite_score uses performance_baseline', () => {
    const baseScores = {
        quality_score: 8,
        breakdown: {},
        explanation: '',
        scoring_method: 'llm_judge',
        scoring_type: 'knowledge',
        scoring_time_ms: 100,
        judge_confidence: 0.9
    };

    it('does not persist scores when batch cancellation is already committed', async () => {
        const controller = new AbortController();
        controller.abort(new Error('private stop reason'));

        await expect(applyScoresToResult('cancelled-id', baseScores, {
            latency: 500,
            tokens_per_sec: 20,
            prompt_category: 'knowledge'
        }, { cancelSignal: controller.signal })).rejects.toMatchObject({
            code: 'BENCHMARK_BATCH_STOPPED',
            message: 'Benchmark batch judging cancelled'
        });
        expect(captured).toHaveLength(0);
    });

    it('invalidates an ambiguously committed score when authority is lost during the write', async () => {
        const controller = new AbortController();
        BenchmarkResult.updateOne.mockImplementationOnce(async (filter, update) => {
            captured.push({ filter, update });
            controller.abort(new Error('lease heartbeat rejected'));
            return { acknowledged: true };
        });

        await expect(applyScoresToResult('lost-during-write', baseScores, {
            latency: 500,
            tokens_per_sec: 20,
            prompt_category: 'knowledge'
        }, { cancelSignal: controller.signal })).rejects.toMatchObject({
            code: 'BENCHMARK_BATCH_STOPPED'
        });

        expect(captured).toHaveLength(2);
        expect(captured[1]).toEqual(expect.objectContaining({
            filter: { _id: 'lost-during-write' },
            update: { $set: expect.objectContaining({
                excluded_from_leaderboard: true,
                scoring_method: 'authority_invalidated',
                quality_score: null,
                composite_score: null
            }) }
        }));
    });

    it('produces a higher composite when calibrated baseline is present', async () => {
        const slowRaw = {
            latency: 5000,
            tokens_per_sec: 5,
            time_to_first_token_ms: 800,
            prompt_category: 'knowledge',
            performance_baseline: null
        };
        const calibrated = {
            ...slowRaw,
            performance_baseline: { latencyMs: 500, tokensPerSec: 60 }
        };

        await applyScoresToResult('id1', baseScores, slowRaw);
        await applyScoresToResult('id2', baseScores, calibrated);

        const rawComposite = captured[0].update.$set.composite_score;
        const calibratedComposite = captured[1].update.$set.composite_score;

        expect(typeof rawComposite).toBe('number');
        expect(typeof calibratedComposite).toBe('number');
        expect(calibratedComposite).toBeGreaterThan(rawComposite);
    });

    it('passes time_to_first_token_ms through to composite (non-null normalized.ttft)', async () => {
        await applyScoresToResult('id3', baseScores, {
            latency: 1500,
            tokens_per_sec: 50,
            time_to_first_token_ms: 200,
            prompt_category: 'knowledge',
            performance_baseline: null
        });

        const set = captured[0].update.$set;
        expect(set.normalized_scores).toBeDefined();
        expect(set.normalized_scores.ttft).not.toBeNull();
    });

    it('preserves existing needs_review reason when judge scores a quarantined row', async () => {
        await applyScoresToResult('id4', {
            ...baseScores,
            needs_review: false,
            review_reason: null
        }, {
            latency: 1500,
            tokens_per_sec: 50,
            time_to_first_token_ms: 200,
            prompt_category: 'knowledge',
            performance_baseline: null,
            needs_review: true,
            review_reason: 'Response hit a hidden runtime token cap'
        });

        const set = captured[0].update.$set;
        expect(set.needs_review).toBe(true);
        expect(set.review_reason).toBe('Response hit a hidden runtime token cap');
    });

    it('persists the judge host used by a rejudge override', async () => {
        await applyScoresToResult('id5', {
            ...baseScores,
            judge_host: 'http://192.0.2.12:11434'
        }, {
            latency: 1500,
            tokens_per_sec: 50,
            time_to_first_token_ms: 200,
            prompt_category: 'knowledge',
            performance_baseline: null,
            judge_host: 'http://192.0.2.99:11434'
        });

        const set = captured[0].update.$set;
        expect(set.judge_host).toBe('http://192.0.2.12:11434');
    });

    it('keeps the previous judge host when a non-LLM scorer has no judge host', async () => {
        await applyScoresToResult('id6', baseScores, {
            latency: 1500,
            tokens_per_sec: 50,
            time_to_first_token_ms: 200,
            prompt_category: 'knowledge',
            performance_baseline: null,
            judge_host: 'http://192.0.2.99:11434'
        });

        const set = captured[0].update.$set;
        expect(set.judge_host).toBe('http://192.0.2.99:11434');
    });
});
