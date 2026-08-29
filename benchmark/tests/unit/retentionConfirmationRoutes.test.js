'use strict';

jest.mock('../../config/logger', () => ({
    info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn()
}));
jest.mock('../../src/services/benchmark', () => ({}));
jest.mock('../../src/helpers/ollamaHostConfig', () => ({ getConfiguredHosts: jest.fn() }));
jest.mock('../../src/services/benchmark/ceilingDetection', () => ({}));
jest.mock('../../src/services/benchmark/generalistScore', () => ({}));
jest.mock('../../src/services/benchmark/regressionDetector', () => ({}));
jest.mock('../../src/services/benchmark/dataRetention', () => ({
    archiveOldResults: jest.fn(),
    pruneExcessBatches: jest.fn(),
    purgeDeadModels: jest.fn(),
    getRetentionStats: jest.fn()
}));
jest.mock('../../models/BenchmarkResult', () => ({}));
jest.mock('../../models/BenchmarkBatch', () => ({}));

const retention = require('../../src/services/benchmark/dataRetention');
const analyticsRouter = require('../../routes/benchmark/analytics');

function getPostHandler(path) {
    const layer = analyticsRouter.stack.find(candidate => (
        candidate.route?.path === path && candidate.route.methods.post
    ));
    if (!layer) throw new Error(`POST ${path} handler not found`);
    return layer.route.stack.at(-1).handle;
}

function createResponse() {
    const response = { statusCode: 200, body: undefined };
    response.status = jest.fn((statusCode) => {
        response.statusCode = statusCode;
        return response;
    });
    response.json = jest.fn((body) => {
        response.body = body;
        return response;
    });
    return response;
}

const CASES = [
    {
        label: 'archive',
        path: '/retention/archive',
        body: { retention_days: 45, dry_run: false },
        confirmation: 'DELETE RESULTS OLDER THAN 45 DAYS',
        service: retention.archiveOldResults,
        args: [45, false],
        handler: getPostHandler('/retention/archive')
    },
    {
        label: 'prune',
        path: '/retention/prune',
        body: { keep_batches: 7, dry_run: false },
        confirmation: 'PRUNE RESULTS TO 7 BATCHES PER MODEL',
        service: retention.pruneExcessBatches,
        args: [7, false],
        handler: getPostHandler('/retention/prune')
    },
    {
        label: 'purge dead models',
        path: '/retention/purge-dead',
        body: { dry_run: false },
        confirmation: 'PURGE DEAD MODEL RESULTS',
        service: retention.purgeDeadModels,
        args: [false],
        handler: getPostHandler('/retention/purge-dead')
    }
];

describe('Benchmark retention destructive confirmations', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        for (const routeCase of CASES) {
            routeCase.service.mockResolvedValue({ dryRun: false, resultsDeleted: 2 });
        }
    });

    test.each(CASES)('$label rejects a missing phrase before the retention service runs', async (routeCase) => {
        const response = createResponse();
        await routeCase.handler({ body: routeCase.body }, response);

        expect(response.statusCode).toBe(400);
        expect(response.body).toMatchObject({
            status: 'error',
            code: 'DESTRUCTIVE_CONFIRMATION_REQUIRED',
            confirmation: {
                kind: 'exact-phrase',
                field: 'confirm',
                expected: routeCase.confirmation
            }
        });
        expect(routeCase.service).not.toHaveBeenCalled();
    });

    test.each(CASES)('$label rejects a wrong phrase before the retention service runs', async (routeCase) => {
        const response = createResponse();
        await routeCase.handler({
            body: { ...routeCase.body, confirm: `${routeCase.confirmation} ` }
        }, response);

        expect(response.statusCode).toBe(400);
        expect(response.body.code).toBe('DESTRUCTIVE_CONFIRMATION_REQUIRED');
        expect(routeCase.service).not.toHaveBeenCalled();
    });

    test.each(CASES)('$label runs with the exact phrase', async (routeCase) => {
        const response = createResponse();
        await routeCase.handler({
            body: { ...routeCase.body, confirm: routeCase.confirmation }
        }, response);

        expect(response.statusCode).toBe(200);
        expect(response.body.status).toBe('success');
        expect(routeCase.service).toHaveBeenCalledWith(...routeCase.args);
    });

    test.each(CASES)('$label keeps its read-only dry run available without a phrase', async (routeCase) => {
        const response = createResponse();
        await routeCase.handler({
            body: { ...routeCase.body, dry_run: true }
        }, response);

        expect(response.statusCode).toBe(200);
        expect(routeCase.service).toHaveBeenCalled();
        expect(routeCase.service.mock.calls[0].at(-1)).toBe(true);
    });
});
