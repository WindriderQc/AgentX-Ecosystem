'use strict';
jest.mock('../../../src/clients/coreApiClient', () => ({
    getDedicationStatuses: jest.fn(), resolveHostKey: jest.fn()
}));
const coreApiClient = require('../../../src/clients/coreApiClient');
const { detectDedication } = require('../../../src/services/benchmark/dedicationLifecycle');
describe('benchmark dedication detection', () => {
    beforeEach(() => jest.clearAllMocks());
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

});
