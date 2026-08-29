/**
 * Prompts API Integration Tests
 * Tests for prompt CRUD and A/B testing endpoints
 */

const request = require('supertest');
const mongoose = require('mongoose');
const { app } = require('../../src/app');
const PromptConfig = require('../../models/PromptConfig');
const { createMockMongoDocument } = require('../helpers/testUtils');

describe('Prompts API', () => {
    let testPrompt;

    beforeAll(async () => {
        // Clear test data
        await PromptConfig.deleteMany({ name: { $regex: /^test_/ } });
        await PromptConfig.deleteMany({ name: 'visual_llm' });
        await PromptConfig.deleteMany({ name: 'Testin' });
    });

    afterAll(async () => {
        await PromptConfig.deleteMany({ name: { $regex: /^test_/ } });
        await PromptConfig.deleteMany({ name: 'visual_llm' });
        await PromptConfig.deleteMany({ name: 'Testin' });
    });

    describe('POST /api/prompts', () => {
        it('should create a new prompt', async () => {
            const promptData = {
                name: 'test_prompt_1',
                systemPrompt: 'You are a helpful assistant for testing.'
            };

            const res = await request(app)
                .post('/api/prompts')
                .send(promptData)
                .expect(201);

            expect(res.body.status).toBe('success');
            expect(res.body.data.name).toBe('test_prompt_1');
            expect(res.body.data.version).toBe(1);

            testPrompt = res.body.data;
        });

        it('should auto-increment version for same name', async () => {
            const promptData = {
                name: 'test_prompt_1',
                systemPrompt: 'Version 2 prompt'
            };

            const res = await request(app)
                .post('/api/prompts')
                .send(promptData)
                .expect(201);

            expect(res.body.status).toBe('success');
            expect(res.body.data.version).toBe(2);
        });

        it('should create another version for same name', async () => {
            const promptData = {
                name: 'test_prompt_1',
                systemPrompt: 'Version 3 prompt'
            };

            const res = await request(app)
                .post('/api/prompts')
                .send(promptData)
                .expect(201);

            expect(res.body.data.version).toBe(3);
        });
    });

    describe('GET /api/prompts', () => {
        it('should list all prompts', async () => {
            const res = await request(app)
                .get('/api/prompts')
                .expect(200);

            expect(res.body.status).toBe('success');
            expect(typeof res.body.data).toBe('object');
            expect(Object.keys(res.body.data).length).toBeGreaterThan(0);
            expect(res.body.data.test_prompt_1[0].disposition.kind).toBe('prompt_asset');
        });

        it('should hide removed personas by default', async () => {
            await PromptConfig.create({
                name: 'visual_llm',
                systemPrompt: 'Removed visual persona',
                version: 1,
                isActive: true
            });

            const res = await request(app)
                .get('/api/prompts')
                .expect(200);

            expect(res.body.data.visual_llm).toBeUndefined();
        });

        it('retains Testin for prompt management but marks it non-selectable', async () => {
            await PromptConfig.create({
                name: 'Testin',
                systemPrompt: 'Legacy test-only persona',
                version: 1,
                isActive: true
            });

            const res = await request(app)
                .get('/api/prompts')
                .expect(200);

            expect(res.body.data.Testin[0].disposition).toEqual(expect.objectContaining({
                kind: 'test_fixture',
                selectable: false,
                routeStatus: 'test_only'
            }));
        });
    });

    describe('GET /api/prompts/:name', () => {
        it('should get prompt by name', async () => {
            const res = await request(app)
                .get('/api/prompts/test_prompt_1')
                .expect(200);

            expect(res.body.status).toBe('success');
            expect(Array.isArray(res.body.data)).toBe(true);
            expect(res.body.data[0].name).toBe('test_prompt_1');
        });

        it('should return 404 for non-existent prompt', async () => {
            const res = await request(app)
                .get('/api/prompts/non_existent_prompt')
                .expect(404);

            expect(res.body.status).toBe('error');
            expect(res.body.message).toBeDefined();
        });

        it('should return 410 for removed personas', async () => {
            const res = await request(app)
                .get('/api/prompts/visual_llm')
                .expect(410);

            expect(res.body.status).toBe('error');
            expect(res.body.message).toContain('removed');
        });
    });

    describe('PUT /api/prompts/:id', () => {
        it('should update prompt metadata', async () => {
            const res = await request(app)
                .put(`/api/prompts/${testPrompt._id}`)
                .send({ description: 'Updated description', isActive: true })
                .expect(200);

            expect(res.body.status).toBe('success');
            expect(res.body.data.description).toBe('Updated description');
            expect(res.body.data.isActive).toBe(true);
        });

        it('should return 404 for invalid ID', async () => {
            const fakeId = new mongoose.Types.ObjectId();
            const res = await request(app)
                .put(`/api/prompts/${fakeId}`)
                .send({ description: 'Test' })
                .expect(404);

            expect(res.body.status).toBe('error');
            expect(res.body.message).toBeDefined();
        });
    });

    describe('POST /api/prompts/:name/ab-test', () => {
        beforeAll(async () => {
            // Create test prompts with versions
            await PromptConfig.create({
                name: 'test_ab_prompt',
                systemPrompt: 'Control version',
                version: 1,
                trafficWeight: 100,
                isActive: true
            });
            await PromptConfig.create({
                name: 'test_ab_prompt',
                systemPrompt: 'Variant A',
                version: 2,
                trafficWeight: 0,
                isActive: true
            });
        });

        afterAll(async () => {
            await PromptConfig.deleteMany({ name: 'test_ab_prompt' });
        });

        it('should configure A/B test weights', async () => {
            const res = await request(app)
                .post('/api/prompts/test_ab_prompt/ab-test')
                .send({
                    versions: [
                        { version: 1, weight: 50 },
                        { version: 2, weight: 50 }
                    ]
                })
                .expect(200);

            expect(res.body.status).toBe('success');
            expect(res.body.data.versions.length).toBe(2);
        });

        it('should reject weights not summing to 100', async () => {
            const res = await request(app)
                .post('/api/prompts/test_ab_prompt/ab-test')
                .send({
                    versions: [
                        { version: 1, weight: 30 },
                        { version: 2, weight: 30 }
                    ]
                })
                .expect(400);

            expect(res.body.status).toBe('error');
            expect(res.body.message).toContain('100');
        });
    });

    describe('DELETE /api/prompts/:id', () => {
        it('should delete prompt', async () => {
            // Create prompt to delete
            const prompt = await PromptConfig.create({
                name: 'test_delete_prompt',
                systemPrompt: 'To be deleted',
                version: 1,
                isActive: false
            });

            const res = await request(app)
                .delete(`/api/prompts/${prompt._id}`)
                .set('X-AgentX-Confirm', `DELETE PROMPT ${prompt._id}`)
                .expect(200);

            expect(res.body.status).toBe('success');
            expect(res.body.message).toContain('deleted');
        });
    });
});

describe('PromptConfig Model', () => {
    describe('getActive with weighted selection', () => {
        beforeAll(async () => {
            await PromptConfig.deleteMany({ name: 'test_weighted' });
            await PromptConfig.create([
                { name: 'test_weighted', systemPrompt: 'A', version: 1, trafficWeight: 70, isActive: true },
                { name: 'test_weighted', systemPrompt: 'B', version: 2, trafficWeight: 30, isActive: true }
            ]);
        });

        afterAll(async () => {
            await PromptConfig.deleteMany({ name: 'test_weighted' });
        });

        it('should return a prompt based on weights', async () => {
            const result = await PromptConfig.getActive('test_weighted');
            expect(result).toBeDefined();
            expect([1, 2]).toContain(result.version);
        });

        it('should respect weight distribution over many calls', async () => {
            const counts = { 1: 0, 2: 0 };
            const iterations = 100;

            for (let i = 0; i < iterations; i++) {
                const result = await PromptConfig.getActive('test_weighted');
                counts[result.version]++;
            }

            // Version 1 should be selected roughly 70% of the time (allow 15% variance)
            const v1Ratio = counts[1] / iterations;
            expect(v1Ratio).toBeGreaterThan(0.55);
            expect(v1Ratio).toBeLessThan(0.85);
        });
    });

    describe('recordFeedback', () => {
        let testPrompt;

        beforeAll(async () => {
            testPrompt = await PromptConfig.create({
                name: 'test_feedback_prompt',
                systemPrompt: 'Feedback test',
                version: 1,
                stats: { impressions: 0, positiveCount: 0, negativeCount: 0 }
            });
        });

        afterAll(async () => {
            await PromptConfig.deleteMany({ name: 'test_feedback_prompt' });
        });

        it('should increment positive feedback', async () => {
            const prompt = await PromptConfig.findById(testPrompt._id);
            await prompt.recordFeedback(true);

            const updated = await PromptConfig.findById(testPrompt._id);
            expect(updated.stats.positiveCount).toBe(1);
        });

        it('should increment negative feedback', async () => {
            const prompt = await PromptConfig.findById(testPrompt._id);
            await prompt.recordFeedback(false);

            const updated = await PromptConfig.findById(testPrompt._id);
            expect(updated.stats.negativeCount).toBe(1);
        });
    });
});
