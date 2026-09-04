'use strict';

const express = require('express');

const mockOrder = [];
const mockAcquireBenchmarkClaims = jest.fn();
const mockReleaseBenchmarkClaims = jest.fn();
const mockStartBenchmarkClaimHeartbeat = jest.fn();
const mockResolveHarnessTarget = jest.fn();
const mockCreateSpendGrant = jest.fn();
const mockExecuteHarnessTarget = jest.fn();
const mockCampaignUpdateOne = jest.fn();
let mockLeaseFailure = null;
let mockSaveHook = null;

jest.mock('../../../config/logger', () => ({
    info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn()
}));

jest.mock('../../../src/services/benchmark/benchmarkClaimLifecycle', () => ({
    acquireBenchmarkClaims: (...args) => mockAcquireBenchmarkClaims(...args),
    releaseBenchmarkClaims: (...args) => mockReleaseBenchmarkClaims(...args),
    startBenchmarkClaimHeartbeat: (...args) => mockStartBenchmarkClaimHeartbeat(...args)
}));

jest.mock('../../../src/services/benchmark/harnessBrokerClient', () => ({
    createSpendGrant: (...args) => mockCreateSpendGrant(...args),
    executeHarnessTarget: (...args) => mockExecuteHarnessTarget(...args),
    getHarnessTargets: jest.fn(),
    isHarnessBrokerEnabled: jest.fn(() => true),
    resolveHarnessTarget: (...args) => mockResolveHarnessTarget(...args)
}));

jest.mock('../../../models/HarnessCampaign', () => {
    class MockHarnessCampaign {
        constructor(fields) {
            Object.assign(this, fields);
            this._id = 'campaign-coordination-1';
            this.saveCount = 0;
        }

        async save() {
            this.saveCount += 1;
            mockOrder.push(`save:${this.saveCount}:${this.status}`);
            if (mockSaveHook) await mockSaveHook(this);
            return this;
        }

        toObject() {
            return { ...this };
        }
    }
    MockHarnessCampaign.updateOne = (...args) => mockCampaignUpdateOne(...args);
    MockHarnessCampaign.find = jest.fn();
    return MockHarnessCampaign;
});

const router = require('../../../routes/benchmark/cloudLanes');
const { startTestHttpHarness } = require('../../helpers/testHttpServer');

const app = express();
app.use(express.json());
app.use('/api/benchmark', router);

let httpHarness;
let api;

beforeAll(async () => {
    httpHarness = await startTestHttpHarness(app);
    api = httpHarness.request;
});

afterAll(async () => {
    await httpHarness?.close();
});

beforeEach(() => {
    jest.clearAllMocks();
    mockOrder.length = 0;
    mockLeaseFailure = null;
    mockSaveHook = null;
    mockAcquireBenchmarkClaims.mockImplementation(async () => {
        mockOrder.push('admission:acquired');
        return [];
    });
    mockReleaseBenchmarkClaims.mockImplementation(async () => {
        mockOrder.push('admission:released');
        return { released: 0, failed: 0, details: [], workloadAdmission: { released: true } };
    });
    mockStartBenchmarkClaimHeartbeat.mockImplementation(() => {
        const stop = jest.fn();
        stop.ready = Promise.resolve();
        stop.assertActive = jest.fn(() => {
            if (mockLeaseFailure) throw mockLeaseFailure;
            return true;
        });
        stop.getFailure = jest.fn(() => mockLeaseFailure);
        stop.drain = jest.fn(async () => { mockOrder.push('heartbeat:drained'); });
        return stop;
    });
    mockResolveHarnessTarget.mockResolvedValue({
        id: 'native-worker',
        mode: 'native_agent',
        capabilities: { nativeAgent: true },
        fingerprint: 'a'.repeat(64),
        pricing: { estimated: false }
    });
    mockCreateSpendGrant.mockResolvedValue({ grantId: 'grant-1' });
    mockExecuteHarnessTarget.mockImplementation(async () => {
        mockOrder.push('harness:executed');
        return {
            envelope: { contract: 'worker-envelope/v1' },
            publicReceipt: { contract: 'worker-receipt/v1' },
            outputFingerprint: 'b'.repeat(64),
            output: 'bounded output',
            receipt: { usage: { costNanodollars: 0 } }
        };
    });
    mockCampaignUpdateOne.mockImplementation(async () => {
        mockOrder.push('authority:invalidated');
        return { modifiedCount: 1 };
    });
});

function requestBody() {
    return {
        confirmation_no_secrets: true,
        target: 'native-worker',
        prompt: 'Run a bounded native harness task.',
        execution_config: { response_max_tokens: 100, per_test_timeout_ms: 60_000 }
    };
}

describe('native harness runtime coordination', () => {
    test('acquires admission before the first durable write and drains before release', async () => {
        const response = await api.post('/api/benchmark/harness-campaigns').send(requestBody());

        expect(response.status).toBe(200);
        expect(mockOrder.indexOf('admission:acquired')).toBeLessThan(mockOrder.indexOf('save:1:running'));
        expect(mockOrder.indexOf('save:2:completed')).toBeLessThan(mockOrder.indexOf('heartbeat:drained'));
        expect(mockOrder.indexOf('heartbeat:drained')).toBeLessThan(mockOrder.indexOf('admission:released'));
        expect(mockExecuteHarnessTarget).toHaveBeenCalledWith(expect.objectContaining({
            signal: expect.any(AbortSignal)
        }));
    });

    test('retracts a terminal receipt when admission is lost during its database write', async () => {
        mockSaveHook = async (campaign) => {
            if (campaign.saveCount === 2) {
                mockLeaseFailure = Object.assign(new Error('maintenance won after heartbeat expiry'), {
                    code: 'BENCHMARK_CLAIM_LOST'
                });
            }
        };

        const response = await api.post('/api/benchmark/harness-campaigns').send(requestBody());

        expect(response.status).toBe(500);
        expect(mockCampaignUpdateOne).toHaveBeenCalledWith(
            { _id: 'campaign-coordination-1' },
            expect.objectContaining({
                $set: expect.objectContaining({ status: 'failed' }),
                $unset: expect.objectContaining({ receipt: '', envelope: '' })
            })
        );
        expect(mockOrder.indexOf('authority:invalidated')).toBeLessThan(mockOrder.indexOf('heartbeat:drained'));
        expect(mockOrder.indexOf('heartbeat:drained')).toBeLessThan(mockOrder.indexOf('admission:released'));
    });

    test('does not return success until workload admission release is verified', async () => {
        mockReleaseBenchmarkClaims.mockImplementation(async () => {
            mockOrder.push('admission:release-refused');
            return {
                released: 0,
                failed: 1,
                details: [],
                workloadAdmission: { released: false, reason: 'stale generation' }
            };
        });

        const response = await api.post('/api/benchmark/harness-campaigns').send(requestBody());

        expect(response.status).toBe(503);
        expect(response.body).toMatchObject({
            status: 'error',
            code: 'WORKLOAD_ADMISSION_RELEASE_UNVERIFIED'
        });
        expect(mockCampaignUpdateOne).toHaveBeenCalled();
        expect(mockOrder.indexOf('heartbeat:drained')).toBeLessThan(mockOrder.indexOf('admission:release-refused'));
        expect(mockOrder.indexOf('admission:release-refused')).toBeLessThan(mockOrder.indexOf('authority:invalidated'));
    });

    test('still returns the fail-closed release verdict when authority invalidation also fails', async () => {
        mockReleaseBenchmarkClaims.mockResolvedValue({
            released: 0,
            failed: 1,
            details: [],
            workloadAdmission: { released: false, reason: 'release receipt unavailable' }
        });
        mockCampaignUpdateOne.mockRejectedValue(new Error('database unavailable during invalidation'));

        const response = await api.post('/api/benchmark/harness-campaigns').send(requestBody());

        expect(response.status).toBe(503);
        expect(response.body).toEqual({
            status: 'error',
            code: 'WORKLOAD_ADMISSION_RELEASE_UNVERIFIED',
            error: 'release receipt unavailable'
        });
        expect(mockCampaignUpdateOne).toHaveBeenCalledTimes(1);
    });
});
