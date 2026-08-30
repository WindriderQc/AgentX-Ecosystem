const express = require('express');
const request = require('supertest');

jest.mock('../../config/logger', () => ({
    error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn()
}));
jest.mock('../../models/BenchmarkResult', () => ({ aggregate: jest.fn() }));
jest.mock('../../src/services/scoring/questionDiscrimination', () => ({
    computeDiscriminationStats: jest.fn(),
    getDiscriminationSummary: jest.fn()
}));
jest.mock('../../src/services/benchmark/judgeReadiness', () => ({
    getJudgeReadiness: jest.fn(),
    resolveReadyJudgeTarget: jest.fn(),
    judgeUnavailablePayload: jest.fn(),
    toPublicReadiness: jest.fn(value => value)
}));

const BenchmarkResult = require('../../models/BenchmarkResult');
const { getJudgeReadiness } = require('../../src/services/benchmark/judgeReadiness');
const router = require('../../routes/benchmark/judgeDefaults');

function app() {
    const instance = express();
    instance.use(express.json());
    instance.use(router);
    return instance;
}

describe('judge roster host-bound evaluation evidence', () => {
    test('shows distinct evaluation counts for the same model on different hosts', async () => {
        getJudgeReadiness.mockResolvedValue({
            ready: true,
            hosts: [
                {
                    hostUrl: 'http://host-a:11434', hostName: 'A', hostId: 'a',
                    models: [{ name: 'qwen2.5:14b', size: 1 }], selectedModel: 'qwen2.5:14b',
                    selectionSource: 'default', ready: true, reason: null, reachable: true
                },
                {
                    hostUrl: 'http://host-b:11434', hostName: 'B', hostId: 'b',
                    models: [{ name: 'qwen2.5:14b', size: 1 }], selectedModel: 'qwen2.5:14b',
                    selectionSource: 'default', ready: true, reason: null, reachable: true
                }
            ]
        });
        BenchmarkResult.aggregate.mockResolvedValue([
            { _id: { model: 'qwen2.5:14b', host: 'http://host-a:11434/' }, count: 24, avg_score: 8, success_count: 24 },
            { _id: { model: 'qwen2.5:14b', host: 'http://host-b:11434' }, count: 3, avg_score: 6, success_count: 2 }
        ]);

        const response = await request(app()).get('/judge-roster').expect(200);
        const panels = response.body.data.hostPanels;

        expect(panels[0].judges[0]).toMatchObject({ evalCount: 24, evidenceHost: 'http://host-a:11434' });
        expect(panels[1].judges[0]).toMatchObject({ evalCount: 3, evidenceHost: 'http://host-b:11434' });
        expect(BenchmarkResult.aggregate.mock.calls[0][0]).toEqual(expect.arrayContaining([
            expect.objectContaining({
                $group: expect.objectContaining({
                    _id: { model: '$judge_model', host: '$judge_host' }
                })
            })
        ]));
    });
});
