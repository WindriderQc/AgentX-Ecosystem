jest.mock('../../../src/helpers/ollamaHostConfig', () => ({
    normalizeHostUrl: value => String(value || '').replace(/\/+$/, ''),
    getConfiguredHosts: () => [{ id: 'local', url: 'http://fixture:11434' }]
}));
jest.mock('../../../src/services/benchmark/performanceBaseline', () => ({ getProfilePerformanceBaseline: jest.fn() }));
jest.mock('../../../src/services/benchmark/judgeReadiness', () => ({ resolveReadyJudgeTarget: jest.fn() }));
jest.mock('../../../src/services/benchmark/inferenceContractSnapshot', () => ({ resolveStandaloneCampaignInferenceContracts: jest.fn() }));

const { getProfilePerformanceBaseline } = require('../../../src/services/benchmark/performanceBaseline');
const { resolveReadyJudgeTarget } = require('../../../src/services/benchmark/judgeReadiness');
const { resolveStandaloneCampaignInferenceContracts } = require('../../../src/services/benchmark/inferenceContractSnapshot');
const { prepareQuickComparison } = require('../../../src/services/benchmark/quickComparison');
const { startTestHttpHarness } = require('../../helpers/testHttpServer');
const express = require('express');
const selection = () => ({ host: 'http://fixture:11434', models: ['model-a', 'model-b'], judge_config: { model: 'model-b', host: 'http://fixture:11434' } });
let harness;

beforeAll(async () => {
    const app = express();
    app.use(express.json());
    app.use(require('../../../routes/benchmark/quickComparison'));
    harness = await startTestHttpHarness(app, { transport: process.platform === 'win32' ? 'pipe' : 'tcp' });
});
afterAll(async () => { await harness?.close(); });
beforeEach(() => {
    jest.resetAllMocks();
    getProfilePerformanceBaseline.mockResolvedValue({ numCtx: 8192 });
    resolveReadyJudgeTarget.mockResolvedValue({ ready: true, target: selection().judge_config });
    resolveStandaloneCampaignInferenceContracts.mockResolvedValue({ candidates: [] });
});

test('prepares a bounded comparison from both qualified baselines and warns about a contender judge', async () => {
    const response = await harness.request.post('/quick-comparison').send(selection()).expect(200);
    expect(response.body.data).toMatchObject({
        levels: [1], depth_config: { 1: 'light', 2: 'off', 3: 'off', 4: 'off', 5: 'off' },
        execution_config: { force_num_ctx: 8192, response_max_tokens: 512, repeats: 1, think: false, response_mode: 'final_only' },
        judge_config: { num_ctx: 8192 }, warning: expect.stringContaining('also a contender')
    });
    expect(getProfilePerformanceBaseline.mock.calls).toEqual([
        ['model-a', selection().host], ['model-b', selection().host]
    ]);
});

test.each([null, { numCtx: null }, { numCtx: 0 }, { numCtx: 8192.5 }])('missing qualified measurement never becomes a preset: %s', async baseline => {
    getProfilePerformanceBaseline.mockResolvedValueOnce(baseline);
    const response = await harness.request.post('/quick-comparison').send(selection()).expect(400);
    expect(response.body.error).toMatch(/model-a needs a current Standard or Full profile/);
    expect(response.body.data).toBeUndefined();
});

test('different measured contexts use one verified window and speed measured in the new run', async () => {
    getProfilePerformanceBaseline.mockResolvedValueOnce({ numCtx: 8192 }).mockResolvedValueOnce({ numCtx: 16384 });
    const result = await prepareQuickComparison(selection());
    expect(result.execution_config.force_num_ctx).toBe(8192);
    expect(result.summary).toContain('Speed is measured during this run');
    expect(resolveStandaloneCampaignInferenceContracts).toHaveBeenCalledWith({
        hostGroups: new Map([[selection().host, ['model-a', 'model-b']]]),
        executionConfig: result.execution_config
    });
});

test('large performance measurements do not become unverified large runtime contexts', async () => {
    getProfilePerformanceBaseline.mockResolvedValue({ numCtx: 262144 });
    const result = await prepareQuickComparison(selection());
    expect(result.execution_config.force_num_ctx).toBe(8192);
    expect(result.measurements.map(entry => entry.context)).toEqual([262144, 262144]);
});

test('a smaller qualified measurement bounds both models', async () => {
    getProfilePerformanceBaseline.mockResolvedValueOnce({ numCtx: 4096 });
    const result = await prepareQuickComparison(selection());
    expect(result.execution_config.force_num_ctx).toBe(4096);
});

test('an execution-contract rejection is surfaced before a preset can be applied', async () => {
    resolveStandaloneCampaignInferenceContracts.mockRejectedValue(new Error('Context 8192 is not verified for model-a'));
    const response = await harness.request.post('/quick-comparison').send(selection()).expect(503);
    expect(response.body.error).toContain('Context 8192 is not verified for model-a');
    expect(response.body.data).toBeUndefined();
});

test.each([
    { models: ['model-a'] }, { models: ['model-a', 'model-a:latest'] },
    { host: 'http://unconfigured:11434' }, { models: [{ model: 'model-a' }, 'model-b'] },
    { judge_config: {} }, { judge_config: null }
])('invalid selections fail before profile or inventory lookup: %s', async change => {
    await expect(prepareQuickComparison({ ...selection(), ...change })).rejects.toMatchObject({ status: 400 });
    expect(getProfilePerformanceBaseline).not.toHaveBeenCalled();
    expect(resolveReadyJudgeTarget).not.toHaveBeenCalled();
});

test('an unavailable judge prevents applying settings', async () => {
    resolveReadyJudgeTarget.mockResolvedValue({ ready: false, error: 'Selected judge is offline' });
    await expect(prepareQuickComparison(selection())).rejects.toThrow('Selected judge is offline');
});

test('an independent installed judge keeps its own context policy', async () => {
    resolveReadyJudgeTarget.mockResolvedValue({ ready: true, target: { host: 'http://judge:11434', model: 'judge-c' } });
    const result = await prepareQuickComparison({ ...selection(), judge_config: { host: 'http://judge:11434', model: 'judge-c' } });
    expect(result.judge_config.num_ctx).toBeNull();
    expect(result.warning).toBeNull();
});

test('a failed live artifact check is unavailable, never an invented fallback', async () => {
    getProfilePerformanceBaseline.mockRejectedValue(new Error('Artifact inventory unavailable'));
    const response = await harness.request.post('/quick-comparison').send(selection()).expect(503);
    expect(response.body.error).toBe('Artifact inventory unavailable');
    expect(response.body.data).toBeUndefined();
});
