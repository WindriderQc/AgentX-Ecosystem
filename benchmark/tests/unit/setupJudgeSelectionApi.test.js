const express = require('express');
const request = require('supertest');

jest.mock('../../src/helpers/ollamaHostConfig', () => ({
    saveConfigFile: jest.fn(),
    readConfigFile: jest.fn(() => null),
    isConfigured: jest.fn(() => false),
    getConfiguredHosts: jest.fn(() => []),
    normalizeHostUrl: (raw) => String(raw || '').replace(/\/+$/, '')
}));

jest.mock('../../src/services/benchmark/judgeReadiness', () => ({
    probeHostInventory: jest.fn(),
    normalizeModelName: (name) => String(name || '').replace(/:latest$/i, ''),
    getExplicitGlobalJudgeSelection: jest.fn(() => null)
}));

const hostConfig = require('../../src/helpers/ollamaHostConfig');
const {
    probeHostInventory,
    getExplicitGlobalJudgeSelection
} = require('../../src/services/benchmark/judgeReadiness');
const setupRouter = require('../../routes/setup');
const { fetchSetupInventory } = setupRouter._internal;

const app = express();
app.use(express.json());
app.use('/api/setup', setupRouter);

describe('safe judge setup API', () => {
    const originalFetch = global.fetch;

    afterEach(() => {
        jest.clearAllMocks();
        global.fetch = originalFetch;
    });

    test('hydrates status from the active host authority and explicit judge selection', async () => {
        const hosts = [
            { id: 'primary', name: 'Compose Ollama', url: 'http://host.docker.internal:11434' },
            { id: 'secondary', name: 'Heavy', url: 'http://heavy:11434' }
        ];
        const judge = {
            host: 'http://host.docker.internal:11434',
            model: 'judge:7b',
            source: 'environment'
        };
        hostConfig.isConfigured.mockReturnValue(true);
        hostConfig.readConfigFile.mockReturnValue({ judge: { host: judge.host, model: judge.model } });
        hostConfig.getConfiguredHosts.mockReturnValue(hosts);
        getExplicitGlobalJudgeSelection.mockReturnValue(judge);

        const response = await request(app).get('/api/setup/status');

        expect(response.status).toBe(200);
        expect(response.body).toEqual({ configured: true, hosts, judge });
        expect(getExplicitGlobalJudgeSelection).toHaveBeenCalledWith({
            config: { judge: { host: judge.host, model: judge.model } }
        });
    });

    test('requires an explicit judge selection', async () => {
        const response = await request(app)
            .post('/api/setup/save')
            .send({ hosts: [{ name: 'Alpha', url: 'http://alpha:11434' }] });

        expect(response.status).toBe(400);
        expect(response.body.code).toBe('SETUP_JUDGE_REQUIRED');
        expect(response.body.error).toMatch(/choose a judge/i);
        expect(probeHostInventory).not.toHaveBeenCalled();
        expect(hostConfig.saveConfigFile).not.toHaveBeenCalled();
    });

    test('rejects a metadata query-string target before probing', async () => {
        global.fetch = jest.fn();

        const response = await request(app)
            .post('/api/setup/test-host')
            .send({ url: 'http://ollama:11434/?next=http://169.254.169.254/latest/meta-data' });

        expect(response.status).toBe(400);
        expect(response.body).toMatchObject({
            success: false,
            code: 'OLLAMA_TARGET_REJECTED'
        });
        expect(global.fetch).not.toHaveBeenCalled();
    });

    test('does not follow redirects while testing an admitted host', async () => {
        global.fetch = jest.fn(async () => ({ ok: false, status: 302 }));

        const response = await request(app)
            .post('/api/setup/test-host')
            .send({ url: 'http://ollama:11434' });

        expect(response.status).toBe(200);
        expect(response.body).toEqual({
            success: false,
            code: 'OLLAMA_PROBE_HTTP_ERROR',
            error: 'Ollama returned HTTP 302'
        });
        expect(global.fetch).toHaveBeenCalledWith('http://ollama:11434/api/tags', expect.objectContaining({
            redirect: 'manual'
        }));
    });

    test.each([
        ['AbortError', undefined, 'OLLAMA_PROBE_TIMEOUT'],
        ['Error', 'ECONNREFUSED', 'OLLAMA_CONNECTION_REFUSED']
    ])('returns a stable code for %s probe failures', async (name, errorCode, expectedCode) => {
        const error = new Error('fixture failure');
        error.name = name;
        if (errorCode) error.code = errorCode;
        global.fetch = jest.fn().mockRejectedValue(error);

        const response = await request(app)
            .post('/api/setup/test-host')
            .send({ url: 'http://ollama:11434' });

        expect(response.status).toBe(200);
        expect(response.body).toMatchObject({ success: false, code: expectedCode });
    });

    test('keeps the timeout active until the bounded body parser finishes', async () => {
        const timerToken = { id: 'inventory-deadline' };
        const clearTimer = jest.fn();
        const readJson = jest.fn(async () => {
            expect(clearTimer).not.toHaveBeenCalledWith(timerToken);
            return { models: [] };
        });

        const result = await fetchSetupInventory('http://ollama:11434', {
            fetchImpl: jest.fn(async () => ({ ok: true, status: 200 })),
            readJson,
            setTimer: jest.fn(() => timerToken),
            clearTimer
        });

        expect(result.payload).toEqual({ models: [] });
        expect(clearTimer).toHaveBeenCalledWith(timerToken);
    });

    test('rejects an oversized inventory body instead of buffering it', async () => {
        global.fetch = jest.fn(async () => ({
            ok: true,
            status: 200,
            body: {
                async *[Symbol.asyncIterator]() {
                    yield Buffer.alloc(1024 * 1024, 0x20);
                    yield Buffer.from('{}');
                }
            }
        }));

        const response = await request(app)
            .post('/api/setup/test-host')
            .send({ url: 'http://ollama:11434' });

        expect(response.status).toBe(200);
        expect(response.body.success).toBe(false);
        expect(response.body.code).toBe('OLLAMA_RESPONSE_TOO_LARGE');
        expect(response.body.error).toMatch(/byte limit/i);
    });

    test('rejects a metadata target before judge probing or persistence', async () => {
        const response = await request(app)
            .post('/api/setup/save')
            .send({
                hosts: [{ name: 'Metadata', url: 'http://169.254.169.254:11434' }],
                judge: { host: 'http://169.254.169.254:11434', model: 'judge:7b' }
            });

        expect(response.status).toBe(400);
        expect(response.body.code).toBe('OLLAMA_TARGET_REJECTED');
        expect(probeHostInventory).not.toHaveBeenCalled();
        expect(hostConfig.saveConfigFile).not.toHaveBeenCalled();
    });

    test('rejects a selected model that is not already installed', async () => {
        probeHostInventory.mockResolvedValue({
            reachable: true,
            models: [{ name: 'installed:7b' }]
        });

        const response = await request(app)
            .post('/api/setup/save')
            .send({
                hosts: [{ name: 'Alpha', url: 'http://alpha:11434' }],
                judge: { host: 'http://alpha:11434', model: 'missing:14b' }
            });

        expect(response.status).toBe(422);
        expect(response.body.code).toBe('SETUP_JUDGE_MODEL_UNAVAILABLE');
        expect(response.body.error).toMatch(/not installed/i);
        expect(hostConfig.saveConfigFile).not.toHaveBeenCalled();
    });

    test('persists the exact explicitly selected installed target', async () => {
        probeHostInventory.mockResolvedValue({
            reachable: true,
            models: [{ name: 'judge:7b' }]
        });

        const response = await request(app)
            .post('/api/setup/save')
            .send({
                hosts: [{ name: 'Alpha', url: 'http://alpha:11434/' }],
                judge: { host: 'http://alpha:11434', model: 'judge:7b' }
            });

        expect(response.status).toBe(200);
        expect(hostConfig.saveConfigFile).toHaveBeenCalledWith({
            hosts: [{ name: 'Alpha', url: 'http://alpha:11434', vramMb: 0 }],
            judge: { host: 'http://alpha:11434', model: 'judge:7b' }
        });
    });
});
