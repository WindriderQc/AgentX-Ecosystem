'use strict';

const express = require('express');
const request = require('supertest');

jest.mock('../../../config/logger', () => ({
    warn: jest.fn(), error: jest.fn(), info: jest.fn(), debug: jest.fn()
}));
jest.mock('../../../src/services/benchmark', () => ({
    startTrustBatch: jest.fn()
}));

const benchmarkService = require('../../../src/services/benchmark');
const router = require('../../../routes/benchmark/trustBatches');

function createApp() {
    const app = express();
    app.use(express.json());
    app.use('/api/benchmark', router);
    return app;
}

describe('strict Benchmark Trust launch route', () => {
    beforeAll(() => {
    });

    afterAll(() => {
    });

    beforeEach(() => jest.clearAllMocks());


    test('accepts only one opaque server-side spec reference', async () => {
        const specId = 'a'.repeat(64);
        benchmarkService.startTrustBatch.mockResolvedValue({
            batch_id: '507f1f77bcf86cd799439011',
            trust_campaign_spec_id: specId,
            trust_source_batch_id: `batch_${'b'.repeat(32)}`
        });
        const response = await request(createApp())
            .post(`/api/benchmark/trust-batches/${specId}/start`)
            .send()
            .expect(202);

        expect(benchmarkService.startTrustBatch).toHaveBeenCalledWith(specId);
        expect(response.body).toMatchObject({
            status: 'success',
            data: { trust_campaign_spec_id: specId }
        });
    });

    test('rejects caller-supplied context before invoking the launcher', async () => {
        const response = await request(createApp())
            .post(`/api/benchmark/trust-batches/${'b'.repeat(64)}/start`)
            .send({ trust_evidence_context: { qualified: true } })
            .expect(400);

        expect(response.body.code).toBe('BENCHMARK_TRUST_RAW_CONTEXT_FORBIDDEN');
        expect(benchmarkService.startTrustBatch).not.toHaveBeenCalled();
    });

    test('preserves fail-closed launcher status and code', async () => {
        benchmarkService.startTrustBatch.mockRejectedValue(Object.assign(
            new Error('strict campaign runtime is disabled'),
            { code: 'BENCHMARK_TRUST_CAMPAIGNS_DISABLED', statusCode: 503 }
        ));
        const response = await request(createApp())
            .post(`/api/benchmark/trust-batches/${'c'.repeat(64)}/start`)
            .send()
            .expect(503);

        expect(response.body).toMatchObject({
            status: 'error',
            code: 'BENCHMARK_TRUST_CAMPAIGNS_DISABLED'
        });
    });
});
