'use strict';

const express = require('express');
const request = require('supertest');

jest.mock('../../config/logger', () => ({
    warn: jest.fn(), error: jest.fn(), info: jest.fn(), debug: jest.fn()
}));

jest.mock('../../src/services/benchmark/humanGroundTruthImport', () => ({
    importAttestedHumanGroundTruth: jest.fn()
}));

const {
    importAttestedHumanGroundTruth
} = require('../../src/services/benchmark/humanGroundTruthImport');
const router = require('../../routes/benchmark/humanEvidence');

function createApp() {
    const app = express();
    app.use(express.json());
    app.use('/api/benchmark', router);
    return app;
}

beforeEach(() => jest.clearAllMocks());

test('imports one exact signed package and does not accept authority inputs separately', async () => {
    const attestation = { schema: 'agentx.benchmark-human-evidence-attestation/v1' };
    importAttestedHumanGroundTruth.mockResolvedValue({
        imported: true,
        groundTruth: { id: 'ground-truth-id', human_attestation_fingerprint: 'a'.repeat(64) }
    });

    const response = await request(createApp())
        .post('/api/benchmark/judge/ground-truth/import-attested')
        .send(attestation)
        .expect(201);

    expect(importAttestedHumanGroundTruth).toHaveBeenCalledWith(attestation);
    expect(response.body).toMatchObject({ status: 'success', data: { imported: true } });
});

test('returns 200 for an exact idempotent replay', async () => {
    importAttestedHumanGroundTruth.mockResolvedValue({ imported: false, groundTruth: { id: 'same' } });
    const response = await request(createApp())
        .post('/api/benchmark/judge/ground-truth/import-attested')
        .send({ schema: 'agentx.benchmark-human-evidence-attestation/v1' })
        .expect(200);
    expect(response.body.data.imported).toBe(false);
});

test('does not let verified:true bypass contract or server trust-state failures', async () => {
    importAttestedHumanGroundTruth.mockRejectedValue(Object.assign(
        new Error('unsupported keys: verified'),
        { code: 'INVALID_HUMAN_EVIDENCE_ATTESTATION', statusCode: 400 }
    ));
    const response = await request(createApp())
        .post('/api/benchmark/judge/ground-truth/import-attested')
        .send({ verified: true })
        .expect(400);
    expect(response.body.code).toBe('INVALID_HUMAN_EVIDENCE_ATTESTATION');
    expect(importAttestedHumanGroundTruth).toHaveBeenCalledWith({ verified: true });

    importAttestedHumanGroundTruth.mockRejectedValue(Object.assign(
        new Error('no server trust authority'),
        { code: 'BENCHMARK_HUMAN_EVIDENCE_IMPORT_DISABLED', statusCode: 503 }
    ));
    await request(createApp())
        .post('/api/benchmark/judge/ground-truth/import-attested')
        .send({ schema: 'agentx.benchmark-human-evidence-attestation/v1' })
        .expect(503);
});
