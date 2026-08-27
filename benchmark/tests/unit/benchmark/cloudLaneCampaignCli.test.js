'use strict';

jest.mock('node-fetch', () => jest.fn());

const path = require('path');
const fetch = require('node-fetch');
const { buildTransports, run } = require('../../../scripts/cloud-lane-campaign');

const dataPath = (name) => path.join(__dirname, '..', '..', '..', 'data', name);

describe('cloud/local campaign operator CLI', () => {
    beforeEach(() => fetch.mockClear());

    test('defaults to plan-only and proves zero provider network calls', async () => {
        let output = '';
        const stdout = { write: (value) => { output += value; } };
        const summary = await run([
            '--campaign', dataPath('cloud-lane-campaign.example.json'),
            '--fixtures', dataPath('cloud-lane-campaign-fixtures.example.json')
        ], { stdout });

        expect(summary).toMatchObject({
            mode: 'plan_only',
            networkCalls: 0,
            paidSpendNanodollars: 0,
            routeMutation: false,
            networkAuthorized: false
        });
        expect(JSON.parse(output)).toEqual(summary);
        expect(fetch).not.toHaveBeenCalled();
    });

    test('requires raw-evidence output and transport files for explicit execution', async () => {
        await expect(run([
            '--campaign', dataPath('cloud-lane-campaign.example.json'),
            '--fixtures', dataPath('cloud-lane-campaign-fixtures.example.json'),
            '--execute-free'
        ], { stdout: { write: jest.fn() } })).rejects.toMatchObject({ code: 'EXECUTION_FILES_REQUIRED' });
        expect(fetch).not.toHaveBeenCalled();
    });

    test('forbids inline provider credentials in transport configuration', () => {
        const plan = {
            candidates: [{ id: 'cloud-a' }]
        };
        expect(() => buildTransports(plan, {
            transports: {
                'cloud-a': { type: 'openrouter', apiKey: 'must-not-be-in-json', apiKeyEnv: 'OPENROUTER_API_KEY' }
            }
        }, { OPENROUTER_API_KEY: 'runtime-only' })).toThrow(expect.objectContaining({ code: 'INLINE_SECRET_FORBIDDEN' }));
    });
});
