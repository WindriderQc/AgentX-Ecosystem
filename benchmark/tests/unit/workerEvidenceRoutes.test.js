'use strict';

const express = require('express');
const request = require('supertest');
const router = require('../../routes/benchmark/cloudLanes');
const { normalizeWorkerEnvelope } = require('../../../shared/workerContract');
const { envelopeInput, receiptInput } = require('../helpers/workerContractFixtures');

describe('Benchmark worker evidence API', () => {
  test('receives worker receipts through the additive stateless comparison route', async () => {
    const app = express();
    app.use(express.json());
    app.use('/api/benchmark', router);
    const envelope = normalizeWorkerEnvelope(envelopeInput());
    const left = receiptInput(envelope);
    const right = receiptInput(envelope);
    right.identity.harness = { name: 'harness-b', version: '1.0.0' };
    right.identity.adapter = { name: 'adapter-b', version: '1.0.0' };

    const response = await request(app)
      .post('/api/benchmark/worker-evidence/compare')
      .send({
        profile: 'portable',
        generatedAt: '2026-08-28T12:00:00.000Z',
        receipts: [left, right],
      });

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      status: 'success',
      data: { profile: 'portable', receiptCount: 2, tupleCount: 2 },
    });
  });
});
