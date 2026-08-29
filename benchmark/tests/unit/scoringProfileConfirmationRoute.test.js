'use strict';

jest.mock('../../config/logger', () => ({
    error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn()
}));
jest.mock('../../src/services/benchmark/scoringProfile', () => ({
    getScoringProfile: jest.fn(),
    getDefaultScoringProfile: jest.fn(),
    updateScoringProfile: jest.fn(),
    resetScoringProfile: jest.fn()
}));

const scoringProfile = require('../../src/services/benchmark/scoringProfile');
const scoringProfileRouter = require('../../routes/benchmark/scoringProfile');

const CONFIRMATION = 'RESET SCORING PROFILE';
const resetHandler = scoringProfileRouter.stack.find(candidate => (
    candidate.route?.path === '/scoring-profile/reset' && candidate.route.methods.post
)).route.stack.at(-1).handle;

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

describe('POST /scoring-profile/reset exact confirmation', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        scoringProfile.resetScoringProfile.mockResolvedValue({ categoryWeights: {} });
    });

    it('rejects a missing phrase before resetting', async () => {
        const response = createResponse();
        await resetHandler({ body: {} }, response);

        expect(response.statusCode).toBe(400);
        expect(response.body).toMatchObject({
            status: 'error',
            code: 'DESTRUCTIVE_CONFIRMATION_REQUIRED',
            confirmation: {
                kind: 'exact-phrase',
                field: 'confirm',
                expected: CONFIRMATION
            }
        });
        expect(scoringProfile.resetScoringProfile).not.toHaveBeenCalled();
    });

    it('rejects a wrong phrase before resetting', async () => {
        const response = createResponse();
        await resetHandler({ body: { confirm: 'RESET' } }, response);

        expect(response.statusCode).toBe(400);
        expect(response.body.code).toBe('DESTRUCTIVE_CONFIRMATION_REQUIRED');
        expect(scoringProfile.resetScoringProfile).not.toHaveBeenCalled();
    });

    it('resets only with the exact phrase', async () => {
        const response = createResponse();
        await resetHandler({ body: { confirm: CONFIRMATION } }, response);

        expect(response.statusCode).toBe(200);
        expect(response.body.status).toBe('success');
        expect(scoringProfile.resetScoringProfile).toHaveBeenCalledTimes(1);
    });
});
