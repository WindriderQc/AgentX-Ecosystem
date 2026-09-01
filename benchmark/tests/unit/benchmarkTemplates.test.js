const mongoose = require('mongoose');

// Mock models before requiring router
jest.mock('../../models/BenchmarkTemplate');
jest.mock('../../models/BenchmarkBatch');
jest.mock('../../config/logger', () => ({
    info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn()
}));

const BenchmarkTemplate = require('../../models/BenchmarkTemplate');
const BenchmarkBatch = require('../../models/BenchmarkBatch');

// Use supertest to test Express routes
const express = require('express');
const templatesRouter = require('../../routes/benchmark/templates');
const { startTestHttpHarness } = require('../helpers/testHttpServer');

const expressApp = express();
expressApp.use(express.json());
expressApp.use('/api/benchmark', templatesRouter);

let httpHarness;
let api;

beforeAll(async () => {
    httpHarness = await startTestHttpHarness(expressApp);
    api = httpHarness.request;
});

afterAll(async () => {
    await httpHarness?.close();
});

const VALID_ID = '507f1f77bcf86cd799439011';
const INVALID_ID = 'not-an-objectid';

describe('benchmark templates routes', () => {
    beforeEach(() => jest.clearAllMocks());

    describe('GET /api/benchmark/templates', () => {
        it('returns list of templates', async () => {
            BenchmarkTemplate.find.mockReturnValue({
                sort: jest.fn().mockReturnValue({
                    lean: jest.fn().mockResolvedValue([
                        { _id: VALID_ID, name: 'My Template', config: { host: 'http://localhost:11434' } }
                    ])
                })
            });

            const res = await api.get('/api/benchmark/templates');
            expect(res.status).toBe(200);
            expect(res.body.status).toBe('success');
            expect(res.body.data).toHaveLength(1);
            expect(res.body.data[0].name).toBe('My Template');
        });

        it('returns 500 on DB error', async () => {
            BenchmarkTemplate.find.mockReturnValue({
                sort: jest.fn().mockReturnValue({
                    lean: jest.fn().mockRejectedValue(new Error('DB down'))
                })
            });

            const res = await api.get('/api/benchmark/templates');
            expect(res.status).toBe(500);
            expect(res.body.status).toBe('error');
        });
    });

    describe('POST /api/benchmark/templates', () => {
        it('creates a template with valid data', async () => {
            BenchmarkTemplate.create.mockResolvedValue({
                _id: VALID_ID, name: 'Test', config: { host: 'h' }, tags: []
            });

            const res = await api
                .post('/api/benchmark/templates')
                .send({ name: 'Test', config: { host: 'h' } });

            expect(res.status).toBe(201);
            expect(res.body.status).toBe('success');
            expect(BenchmarkTemplate.create).toHaveBeenCalledWith(
                expect.objectContaining({ name: 'Test' })
            );
        });

        it('rejects missing name', async () => {
            const res = await api
                .post('/api/benchmark/templates')
                .send({ config: {} });

            expect(res.status).toBe(400);
            expect(res.body.error).toMatch(/name/i);
        });

        it('rejects name over 200 chars', async () => {
            const res = await api
                .post('/api/benchmark/templates')
                .send({ name: 'x'.repeat(201) });

            expect(res.status).toBe(400);
        });

        it('creates from source batch', async () => {
            BenchmarkBatch.findById.mockReturnValue({
                select: jest.fn().mockReturnThis(),
                lean: jest.fn().mockResolvedValue({
                    _id: VALID_ID,
                    host: 'http://host:11434',
                    models: ['llama3'],
                    levels: [1, 2]
                })
            });
            BenchmarkTemplate.create.mockResolvedValue({ _id: 'new', name: 'From Batch' });

            const res = await api
                .post('/api/benchmark/templates')
                .send({ name: 'From Batch', source_batch_id: VALID_ID });

            expect(res.status).toBe(201);
            expect(BenchmarkTemplate.create).toHaveBeenCalledWith(
                expect.objectContaining({
                    config: expect.objectContaining({ host: 'http://host:11434', models: ['llama3'] })
                })
            );
        });

        it('refuses to export a strict Trust campaign into a public template', async () => {
            BenchmarkBatch.findById.mockReturnValue({
                select: jest.fn().mockReturnThis(),
                lean: jest.fn().mockResolvedValue({
                    _id: VALID_ID,
                    trust_campaign_spec_id: 'a'.repeat(64),
                    execution_config: { custom_hint: 'PRIVATE-TRUST-HINT' }
                })
            });

            const res = await api
                .post('/api/benchmark/templates')
                .send({ name: 'Forbidden Trust Export', source_batch_id: VALID_ID });

            expect(res.status).toBe(409);
            expect(res.body.code).toBe('BENCHMARK_TRUST_TEMPLATE_EXPORT_FORBIDDEN');
            expect(BenchmarkTemplate.create).not.toHaveBeenCalled();
            expect(JSON.stringify(res.body)).not.toContain('PRIVATE-TRUST-HINT');
        });

        it('rejects invalid source_batch_id', async () => {
            const res = await api
                .post('/api/benchmark/templates')
                .send({ name: 'Test', source_batch_id: INVALID_ID });

            expect(res.status).toBe(400);
        });

        it('returns 404 for missing source batch', async () => {
            BenchmarkBatch.findById.mockReturnValue({
                select: jest.fn().mockReturnThis(),
                lean: jest.fn().mockResolvedValue(null)
            });

            const res = await api
                .post('/api/benchmark/templates')
                .send({ name: 'Test', source_batch_id: VALID_ID });

            expect(res.status).toBe(404);
        });

        it('sanitizes tags', async () => {
            BenchmarkTemplate.create.mockResolvedValue({ _id: VALID_ID, name: 'T' });

            await api
                .post('/api/benchmark/templates')
                .send({ name: 'T', tags: ['good', 'a'.repeat(100)] });

            const createArgs = BenchmarkTemplate.create.mock.calls[0][0];
            expect(createArgs.tags[1].length).toBeLessThanOrEqual(50);
        });
    });

    describe('GET /api/benchmark/templates/:id', () => {
        it('returns template by ID', async () => {
            BenchmarkTemplate.findById.mockReturnValue({
                lean: jest.fn().mockResolvedValue({ _id: VALID_ID, name: 'Found' })
            });

            const res = await api.get(`/api/benchmark/templates/${VALID_ID}`);
            expect(res.status).toBe(200);
            expect(res.body.data.name).toBe('Found');
        });

        it('returns 404 for missing template', async () => {
            BenchmarkTemplate.findById.mockReturnValue({
                lean: jest.fn().mockResolvedValue(null)
            });

            const res = await api.get(`/api/benchmark/templates/${VALID_ID}`);
            expect(res.status).toBe(404);
        });

        it('rejects invalid ID', async () => {
            const res = await api.get(`/api/benchmark/templates/${INVALID_ID}`);
            expect(res.status).toBe(400);
        });
    });

    describe('DELETE /api/benchmark/templates/:id', () => {
        const CONFIRMATION = `DELETE TEMPLATE ${VALID_ID}`;

        it('rejects a missing exact confirmation before deleting', async () => {
            const res = await api.delete(`/api/benchmark/templates/${VALID_ID}`);

            expect(res.status).toBe(400);
            expect(res.body).toMatchObject({
                status: 'error',
                code: 'DESTRUCTIVE_CONFIRMATION_REQUIRED',
                confirmation: {
                    kind: 'exact-phrase',
                    field: 'confirm',
                    expected: CONFIRMATION
                }
            });
            expect(BenchmarkTemplate.findByIdAndDelete).not.toHaveBeenCalled();
        });

        it('rejects a wrong exact confirmation before deleting', async () => {
            const res = await api
                .delete(`/api/benchmark/templates/${VALID_ID}`)
                .send({ confirm: 'DELETE TEMPLATE' });

            expect(res.status).toBe(400);
            expect(res.body.code).toBe('DESTRUCTIVE_CONFIRMATION_REQUIRED');
            expect(BenchmarkTemplate.findByIdAndDelete).not.toHaveBeenCalled();
        });

        it('deletes the template with the target-bound exact confirmation', async () => {
            BenchmarkTemplate.findByIdAndDelete.mockResolvedValue({ _id: VALID_ID });

            const res = await api
                .delete(`/api/benchmark/templates/${VALID_ID}`)
                .send({ confirm: CONFIRMATION });

            expect(res.status).toBe(200);
            expect(res.body.message).toMatch(/deleted/i);
            expect(BenchmarkTemplate.findByIdAndDelete).toHaveBeenCalledWith(VALID_ID);
        });

        it('returns 404 for missing template', async () => {
            BenchmarkTemplate.findByIdAndDelete.mockResolvedValue(null);

            const res = await api
                .delete(`/api/benchmark/templates/${VALID_ID}`)
                .send({ confirm: CONFIRMATION });

            expect(res.status).toBe(404);
        });
    });

    describe('POST /api/benchmark/templates/:id/use', () => {
        it('increments run_count', async () => {
            BenchmarkTemplate.findByIdAndUpdate.mockResolvedValue({
                _id: VALID_ID, config: { host: 'h' }, run_count: 2
            });

            const res = await api.post(`/api/benchmark/templates/${VALID_ID}/use`);
            expect(res.status).toBe(200);
            expect(BenchmarkTemplate.findByIdAndUpdate).toHaveBeenCalledWith(
                VALID_ID,
                { $inc: { run_count: 1 } },
                { new: true }
            );
        });

        it('returns 404 for missing template', async () => {
            BenchmarkTemplate.findByIdAndUpdate.mockResolvedValue(null);

            const res = await api.post(`/api/benchmark/templates/${VALID_ID}/use`);
            expect(res.status).toBe(404);
        });
    });
});
