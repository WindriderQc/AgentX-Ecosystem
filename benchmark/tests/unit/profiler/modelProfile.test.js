const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');
const ModelProfile = require('../../../models/ModelProfile');

let mongoServer;

beforeAll(async () => {
    mongoServer = await MongoMemoryServer.create();
    await mongoose.connect(mongoServer.getUri());
    // Ensure indexes are built — required for unique constraint enforcement in MongoMemoryServer
    await ModelProfile.ensureIndexes();
});

afterAll(async () => {
    await mongoose.disconnect();
    await mongoServer.stop();
});

afterEach(async () => {
    await ModelProfile.deleteMany({});
});

describe('ModelProfile', () => {
    const validProfile = {
        name: 'qwen2.5:7b-instruct-q5_K_M',
        displayName: 'Qwen 2.5 7B Instruct',
        provider: 'ollama',
        family: 'qwen',
        parameters: '7B',
        quantization: 'Q5_K_M',
        capabilities: {
            maxContext: 32768,
            vision: false,
            tools: true,
            thinking: false
        }
    };

    it('creates a valid model profile with all fields', async () => {
        const profile = await ModelProfile.create(validProfile);
        expect(profile.name).toBe('qwen2.5:7b-instruct-q5_K_M');
        expect(profile.displayName).toBe('Qwen 2.5 7B Instruct');
        expect(profile.provider).toBe('ollama');
        expect(profile.family).toBe('qwen');
        expect(profile.parameters).toBe('7B');
        expect(profile.quantization).toBe('Q5_K_M');
        expect(profile.capabilities.maxContext).toBe(32768);
        expect(profile.capabilities.vision).toBe(false);
        expect(profile.capabilities.tools).toBe(true);
        expect(profile.capabilities.thinking).toBe(false);
        expect(profile.capabilities.thinkingPolicy).toBe('unknown');
        expect(profile.createdAt).toBeDefined();
        expect(profile.updatedAt).toBeDefined();
    });

    it('requires the name field', async () => {
        await expect(ModelProfile.create({ displayName: 'No Name Model' }))
            .rejects.toThrow(/name/);
    });

    it('enforces unique name', async () => {
        await ModelProfile.create(validProfile);
        await expect(ModelProfile.create({ name: validProfile.name }))
            .rejects.toThrow();
    });

    it('validates readiness stage enum — accepts valid stages', async () => {
        const profile = await ModelProfile.create(validProfile);
        const validStages = ['available', 'profiled', 'adapted', 'benchmarked'];
        for (const stage of validStages) {
            profile.readiness.set('host-delta', { stage });
            await expect(profile.save()).resolves.not.toThrow();
        }
    });

    it('validates readiness stage enum — rejects invalid stage', async () => {
        const profile = new ModelProfile(validProfile);
        profile.readiness.set('host-delta', { stage: 'invalid_stage' });
        await expect(profile.save()).rejects.toThrow(/invalid_stage|readiness/);
    });

    it('defaults tags to empty array', async () => {
        const profile = await ModelProfile.create({ name: 'minimal-model' });
        expect(Array.isArray(profile.tags)).toBe(true);
        expect(profile.tags).toHaveLength(0);
    });

    it('defaults readiness stage to available', async () => {
        const profile = await ModelProfile.create(validProfile);
        profile.readiness.set('host-beta', {});
        await profile.save();
        const saved = await ModelProfile.findById(profile._id);
        expect(saved.readiness.get('host-beta').stage).toBe('available');
    });

    it('stores and retrieves hosts map entries', async () => {
        const profile = await ModelProfile.create(validProfile);
        profile.hosts.set('host-delta', { available: true, lastSeen: new Date('2026-01-01') });
        await profile.save();
        const saved = await ModelProfile.findById(profile._id);
        expect(saved.hosts.get('host-delta').available).toBe(true);
    });

    it('stores host-specific thinking profiles', async () => {
        const profile = await ModelProfile.create({
            name: 'thinking-model',
            capabilities: { thinking: true, thinkingPolicy: 'metered' }
        });
        profile.thinkingProfiles.set('host-gamma', {
            hostId: 'host-gamma',
            supported: true,
            channel: 'hidden',
            visibleFinalAnswerOk: true,
            finalAnswerContractOk: true,
            tokenMultiplier: 5,
            latencyMultiplier: 4.5,
            recommendedPolicy: 'metered',
            recommendationReason: 'safe but expensive'
        });
        await profile.save();

        const saved = await ModelProfile.findById(profile._id);
        expect(saved.thinkingProfiles.get('host-gamma')).toMatchObject({
            supported: true,
            channel: 'hidden',
            finalAnswerContractOk: true,
            recommendedPolicy: 'metered'
        });
    });
});
