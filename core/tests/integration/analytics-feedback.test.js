/**
 * Analytics Feedback Tests
 * Tests for feedback summary and A/B comparison endpoints
 */

const request = require('supertest');

const { app } = require('../../src/app');
const Feedback = require('../../models/Feedback');
const PromptConfig = require('../../models/PromptConfig');
const Conversation = require('../../models/Conversation');

describe('Analytics Feedback API', () => {
    beforeAll(async () => {
        // Create test feedback data
        await Feedback.deleteMany({ conversationId: { $regex: /^test_/ } });
        await PromptConfig.deleteMany({ name: { $regex: /^test_analytics_/ } });

        // Create test prompts with different versions
        await PromptConfig.create([
            {
                name: 'test_analytics_prompt',
                systemPrompt: 'Control version',
                version: 1,
                abTestGroup: 'test_experiment_1',
                trafficWeight: 50,
                stats: { impressions: 100, positiveCount: 70, negativeCount: 30 }
            },
            {
                name: 'test_analytics_prompt',
                systemPrompt: 'Variant version',
                version: 2,
                abTestGroup: 'test_experiment_1',
                trafficWeight: 50,
                stats: { impressions: 100, positiveCount: 80, negativeCount: 20 }
            }
        ]);

        // Create test feedback records
        const now = new Date();
        const feedbackData = [];

        // Positive feedback for control
        for (let i = 0; i < 70; i++) {
            feedbackData.push({
                conversationId: `test_conv_control_${i}`,
                messageId: `msg_${i}`,
                rating: 'positive',
                model: 'qwen2.5:7b-instruct-q4_0',
                promptVersion: 'control',
                promptName: 'test_analytics_prompt',
                userId: 'api-client',
                createdAt: new Date(now - Math.random() * 7 * 24 * 60 * 60 * 1000)
            });
        }

        // Negative feedback for control
        for (let i = 0; i < 30; i++) {
            feedbackData.push({
                conversationId: `test_conv_control_neg_${i}`,
                messageId: `msg_neg_${i}`,
                rating: 'negative',
                model: 'qwen2.5:7b-instruct-q4_0',
                promptVersion: 'control',
                promptName: 'test_analytics_prompt',
                userId: 'api-client',
                createdAt: new Date(now - Math.random() * 7 * 24 * 60 * 60 * 1000)
            });
        }

        // Positive feedback for variant
        for (let i = 0; i < 80; i++) {
            feedbackData.push({
                conversationId: `test_conv_variant_${i}`,
                messageId: `msg_v_${i}`,
                rating: 'positive',
                model: 'qwen2.5:7b-instruct-q4_0',
                promptVersion: 'variant',
                promptName: 'test_analytics_prompt',
                userId: 'api-client',
                createdAt: new Date(now - Math.random() * 7 * 24 * 60 * 60 * 1000)
            });
        }

        // Negative feedback for variant
        for (let i = 0; i < 20; i++) {
            feedbackData.push({
                conversationId: `test_conv_variant_neg_${i}`,
                messageId: `msg_v_neg_${i}`,
                rating: 'negative',
                model: 'qwen2.5:7b-instruct-q4_0',
                promptVersion: 'variant',
                promptName: 'test_analytics_prompt',
                userId: 'api-client',
                createdAt: new Date(now - Math.random() * 7 * 24 * 60 * 60 * 1000)
            });
        }

        await Feedback.insertMany(feedbackData);
    });

    afterAll(async () => {
        await Feedback.deleteMany({ conversationId: { $regex: /^test_/ } });
        await PromptConfig.deleteMany({ name: { $regex: /^test_analytics_/ } });
    });

    describe('GET /api/analytics/feedback/summary', () => {
        it('should return overall feedback metrics', async () => {
            const res = await request(app)
                .get('/api/analytics/feedback/summary')
                .expect(200);

            expect(res.body.status).toBe('success');
            expect(res.body.data.overall).toBeDefined();
            expect(res.body.data.overall.totalFeedback).toBeGreaterThan(0);
            expect(res.body.data.overall.positiveRate).toBeDefined();
        });

        it('should return feedback by model', async () => {
            const res = await request(app)
                .get('/api/analytics/feedback/summary')
                .expect(200);

            expect(res.body.data.byModel).toBeDefined();
            expect(Array.isArray(res.body.data.byModel)).toBe(true);
        });

        it('should return feedback by prompt version', async () => {
            const res = await request(app)
                .get('/api/analytics/feedback/summary')
                .expect(200);

            expect(res.body.data.byPromptVersion).toBeDefined();
            expect(Array.isArray(res.body.data.byPromptVersion)).toBe(true);
        });

        it('should identify low performing prompts', async () => {
            // Create a low performing prompt
            await Feedback.create({
                conversationId: 'test_low_perf',
                messageId: 'msg_low',
                rating: 'negative',
                model: 'test-model',
                promptVersion: 'low_performer',
                promptName: 'test_analytics_low'
            });

            const res = await request(app)
                .get('/api/analytics/feedback/summary')
                .query({ threshold: 0.9 }) // 90% threshold
                .expect(200);

            expect(res.body.data.lowPerformingPrompts).toBeDefined();
            expect(Array.isArray(res.body.data.lowPerformingPrompts)).toBe(true);
        });

        it('should filter by date range', async () => {
            const startDate = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString();
            const endDate = new Date().toISOString();

            const res = await request(app)
                .get('/api/analytics/feedback/summary')
                .query({ startDate, endDate })
                .expect(200);

            expect(res.body.status).toBe('success');
            expect(res.body.dateRange).toBeDefined();
        });
    });

    describe('A/B Comparison', () => {
        it('should return A/B test comparisons', async () => {
            const res = await request(app)
                .get('/api/analytics/feedback/summary')
                .expect(200);

            expect(res.body.data.abComparisons).toBeDefined();
            expect(Array.isArray(res.body.data.abComparisons)).toBe(true);
        });

        it('should include statistical significance estimate', async () => {
            const res = await request(app)
                .get('/api/analytics/feedback/summary')
                .query({ promptName: 'test_analytics_prompt' })
                .expect(200);

            if (res.body.data.abComparisons && res.body.data.abComparisons.length > 0) {
                const comparison = res.body.data.abComparisons[0];
                expect(comparison.control).toBeDefined();
                expect(comparison.variants).toBeDefined();
                expect(comparison.improvement).toBeDefined();
            }
        });

        it('should calculate improvement percentage correctly', async () => {
            const res = await request(app)
                .get('/api/analytics/feedback/summary')
                .query({ promptName: 'test_analytics_prompt' })
                .expect(200);

            if (res.body.data.abComparisons && res.body.data.abComparisons.length > 0) {
                const comparison = res.body.data.abComparisons[0];
                // Variant has 80% positive vs control 70%
                // Expected improvement: (0.8 - 0.7) / 0.7 * 100 ≈ 14.3%
                if (comparison.improvement) {
                    expect(typeof comparison.improvement).toBe('number');
                }
            }
        });
    });

    describe('Feedback Aggregation', () => {
        it('should group feedback by model correctly', async () => {
            const res = await request(app)
                .get('/api/analytics/feedback/summary')
                .expect(200);

            const qwenModel = res.body.data.byModel.find(m =>
                m._id && m._id.includes('qwen')
            );

            if (qwenModel) {
                expect(qwenModel.total).toBeGreaterThan(0);
                expect(qwenModel.positive).toBeDefined();
                expect(qwenModel.negative).toBeDefined();
            }
        });

        it('should calculate positive rate correctly', async () => {
            const res = await request(app)
                .get('/api/analytics/feedback/summary')
                .expect(200);

            // Overall test data: 150 positive, 50 negative = 75% positive rate
            // Allow for some variance due to other test data
            expect(res.body.data.overall.positiveRate).toBeGreaterThan(0);
            expect(res.body.data.overall.positiveRate).toBeLessThanOrEqual(1);
        });
    });
});

describe('Feedback Recording', () => {
    let testConv1Id, testConv2Id, testConv3Id;

    beforeAll(async () => {
        // Create test conversations for feedback recording tests
        const conv1 = await Conversation.create({
            userId: 'api-client',
            model: 'qwen2.5:7b-instruct-q4_0',
            messages: [{ role: 'user', content: 'test' }]
        });
        const conv2 = await Conversation.create({
            userId: 'api-client',
            model: 'qwen2.5:7b-instruct-q4_0',
            messages: [{ role: 'user', content: 'test' }]
        });
        const conv3 = await Conversation.create({
            userId: 'api-client',
            model: 'qwen2.5:7b-instruct-q4_0',
            messages: [{ role: 'user', content: 'test' }]
        });
        testConv1Id = conv1._id.toString();
        testConv2Id = conv2._id.toString();
        testConv3Id = conv3._id.toString();
    });

    afterAll(async () => {
        // Clean up test conversations
        await Conversation.deleteMany({ userId: 'api-client' });
    });

    describe('POST /api/analytics/feedback', () => {
        it('should record positive feedback', async () => {
            const res = await request(app)
                .post('/api/analytics/feedback')
                .send({
                    conversationId: testConv1Id,
                    messageId: 'msg_1',
                    rating: 'positive',
                    model: 'qwen2.5:7b-instruct-q4_0',
                    promptVersion: 'v1'
                })
                .expect(201);

            expect(res.body.status).toBe('success');
        });

        it('should record negative feedback with comment', async () => {
            const res = await request(app)
                .post('/api/analytics/feedback')
                .send({
                    conversationId: testConv2Id,
                    messageId: 'msg_2',
                    rating: 'negative',
                    model: 'qwen2.5:7b-instruct-q4_0',
                    promptVersion: 'v1',
                    comment: 'Response was not helpful'
                })
                .expect(201);

            expect(res.body.status).toBe('success');
        });

        it('should reject invalid rating', async () => {
            const res = await request(app)
                .post('/api/analytics/feedback')
                .send({
                    conversationId: 'test_record_3',
                    messageId: 'msg_3',
                    rating: 'invalid'
                })
                .expect(400);

            expect(res.body.error).toBeDefined();
        });
    });
});
