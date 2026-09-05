'use strict';

const express = require('express');
const request = require('supertest');

jest.mock('../../config/logger', () => ({ error: jest.fn() }));
jest.mock('../../src/services/benchmark', () => ({
    getEfficiencyMap: jest.fn()
}));

const benchmarkService = require('../../src/services/benchmark');
const efficiencyRouter = require('../../routes/benchmark/efficiency');

function buildApp() {
    const app = express();
    app.use('/api/benchmark', efficiencyRouter);
    return app;
}

describe('Efficiency Map trust projection', () => {
    it('labels historical efficiency aggregation as an unqualified observation', async () => {
        benchmarkService.getEfficiencyMap.mockResolvedValue({
            entries: [{
                model: 'model-a',
                host: 'http://host-a:11434',
                efficiencyScore: 71,
                avgQuality: 8,
                avgTokPerSec: 40
            }],
            unranked: []
        });

        const response = await request(buildApp())
            .get('/api/benchmark/efficiency-map')
            .expect(200);

        expect(response.body.data.trustVerdict).toMatchObject({
            contract: 'agentx.benchmark-consumer-trust/v1',
            requestedScope: 'exploratory',
            state: 'exploratory',
            qualified: false,
            highConfidenceAllowed: false,
            claim: 'top_exploratory_observation',
            qualifiedWinner: null,
            topObservation: {
                model: 'model-a',
                host: 'http://host-a:11434',
                score: 71
            }
        });
    });
});
