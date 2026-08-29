'use strict';

const express = require('express');
const router = require('../../../routes/benchmark/cloudLanes');
const { startTestHttpHarness } = require('../../helpers/testHttpServer');

const expressApp = express();
expressApp.use(express.json());
expressApp.use('/api/benchmark', router);

let httpHarness;
let api;

beforeAll(async () => {
    httpHarness = await startTestHttpHarness(expressApp);
    api = httpHarness.request;
});

afterAll(async () => {
    await httpHarness?.close();
});

describe('cloud/local lane API', () => {
    test('the plan endpoint fails closed on a paid candidate without price provenance', async () => {
        const response = await api.post('/api/benchmark/cloud-lanes/plan').send({
            campaignId: 'c1', lane: 'coding', estimatedCalls: 2, spendCeilingNanodollars: 1,
            contract: {
                version: 'v1', lane: 'coding', suite: 'suite', suiteVersion: '1',
                fixtureFingerprint: 'f'.repeat(64), graderVersion: 'g1',
                responseMode: 'final_only', maxOutputTokens: 10
            },
            candidates: [
                {
                    id: 'local', tier: 'local', provider: 'ollama', model: 'm', modelVersion: 'v',
                    apiVersion: 'a', provenanceSource: 'registry', contextWindow: 10,
                    artifactDigest: 'a'.repeat(64)
                },
                {
                    id: 'paid', tier: 'paid_cloud', provider: 'cloud', model: 'm', modelVersion: 'v',
                    apiVersion: 'a', provenanceSource: 'catalog', contextWindow: 10
                }
            ]
        });
        expect(response.status).toBe(400);
        expect(response.body).toMatchObject({ status: 'error', code: 'PRICE_SNAPSHOT_REQUIRED' });
    });

    test('the comparison endpoint is stateless and never emits route or network authority', async () => {
        const candidate = (id, model) => ({
            id, tier: 'local', provider: 'ollama', model, modelVersion: 'v1', apiVersion: 'ollama-v1',
            provenanceSource: 'registry', contextWindow: 8192, artifactDigest: id.repeat(64).slice(0, 64)
        });
        const contract = {
            version: 'v1', lane: 'coding', suite: 'suite', suiteVersion: '1',
            fixtureFingerprint: 'f'.repeat(64), graderVersion: 'g1',
            responseMode: 'final_only', maxOutputTokens: 100
        };
        const observation = (id, model, quality) => ({
            campaignId: 'c1', lane: 'coding', evidenceType: 'synthetic', candidate: candidate(id, model),
            contract, observedAt: '2026-08-27T12:00:00Z', attempts: 1, successes: 1,
            metrics: { qualityScore: quality, latencyMs: 100, contextTokens: 4096 }
        });
        const response = await api.post('/api/benchmark/cloud-lanes/compare').send({
            lane: 'coding', generatedAt: '2026-08-27T12:00:00Z',
            observations: [observation('a', 'one', 0.8), observation('b', 'two', 0.9)]
        });
        expect(response.status).toBe(200);
        expect(response.body.data).toMatchObject({ routeMutation: false, networkAuthorized: false, universalWinner: null });
    });
});
