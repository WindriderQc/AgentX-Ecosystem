'use strict';

const mockFetch = jest.fn();

jest.mock('../../../src/services/benchmark/http', () => ({
    benchmarkFetch: (...args) => mockFetch(...args)
}));
jest.mock('../../../src/clients/coreApiClient', () => ({
    getDedicationStatuses: jest.fn(),
    resolveHostKey: jest.fn(),
    restoreDedication: jest.fn(),
    generateWithWorkloadAdmission: jest.fn()
}));

const coreApiClient = require('../../../src/clients/coreApiClient');
const {
    detectDedication,
    releaseAllDedication
} = require('../../../src/services/benchmark/dedicationLifecycle');

function jsonResponse(payload) {
    return {
        ok: true,
        status: 200,
        json: jest.fn(async () => payload),
        text: jest.fn(async () => '{}')
    };
}

describe('benchmark dedication lifecycle', () => {
    beforeEach(() => jest.clearAllMocks());

    it('unloads the exact running embedding pin without inventing an ax/ artifact', async () => {
        // Even if /api/ps cannot identify the live artifact, an embedding pin
        // must never gain a synthetic ax/ unload candidate.
        mockFetch.mockResolvedValueOnce(jsonResponse({ models: [] }));
        coreApiClient.generateWithWorkloadAdmission.mockResolvedValue({ status: 'success' });
        const recordBatchTimelineEvent = jest.fn(async () => {});
        const dedication = new Map([[
            'http://secondary:11434',
            {
                hostKey: 'secondary',
                pinnedModels: [{ model: 'nomic-embed-text:v1.5', keepAlive: 31536000 }]
            }
        ]]);

        await releaseAllDedication(dedication, { batchId: 'batch-1', recordBatchTimelineEvent });

        expect(mockFetch).toHaveBeenCalledTimes(1);
        expect(coreApiClient.generateWithWorkloadAdmission).toHaveBeenCalledWith(
            'batch-1',
            expect.objectContaining({
                host: 'http://secondary:11434',
                model: 'nomic-embed-text:v1.5',
                keep_alive: 0
            }),
            { signal: undefined }
        );
        expect(recordBatchTimelineEvent).toHaveBeenCalledWith('dedication_released', expect.objectContaining({
            unloadModel: 'nomic-embed-text:v1.5'
        }));
        expect(recordBatchTimelineEvent).not.toHaveBeenCalledWith(
            'dedication_release_failed',
            expect.anything()
        );
    });

    it('fails closed when resume pin detection cannot read the dedication registry', async () => {
        coreApiClient.getDedicationStatuses.mockRejectedValue(new Error('registry unavailable'));
        const recordBatchTimelineEvent = jest.fn(async () => {});

        await expect(detectDedication(
            ['http://secondary:11434'],
            { batchId: 'batch-resume', recordBatchTimelineEvent, failClosed: true }
        )).rejects.toMatchObject({
            message: 'registry unavailable',
            code: 'PIN_DETECTION_FAILED'
        });
        expect(recordBatchTimelineEvent).toHaveBeenCalledWith(
            'dedication_detection_failed',
            expect.objectContaining({ fail_closed: true })
        );
    });

    it('fails closed when a resume pin cannot be unloaded', async () => {
        mockFetch.mockResolvedValueOnce(jsonResponse({ models: [{ name: 'pinned-model' }] }));
        coreApiClient.generateWithWorkloadAdmission.mockRejectedValue(new Error('unload unavailable'));
        const recordBatchTimelineEvent = jest.fn(async () => {});
        const dedication = new Map([[
            'http://secondary:11434',
            { hostKey: 'secondary', pinnedModels: ['pinned-model'] }
        ]]);

        await expect(releaseAllDedication(dedication, {
            batchId: 'batch-resume',
            recordBatchTimelineEvent,
            failClosed: true
        })).rejects.toMatchObject({
            code: 'PIN_RELEASE_FAILED',
            resumeContext: { host: 'http://secondary:11434', model: 'pinned-model' }
        });
        expect(recordBatchTimelineEvent).toHaveBeenCalledWith(
            'dedication_release_failed',
            expect.objectContaining({ unloadModel: 'pinned-model' })
        );
    });
});
