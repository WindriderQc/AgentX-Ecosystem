const ModelProfile = require('../../../models/ModelProfile');

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
        const profile = new ModelProfile(validProfile);
        expect(profile.validateSync()).toBeUndefined();
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
    });

    it('requires the name field', async () => {
        const error = new ModelProfile({ displayName: 'No Name Model' }).validateSync();
        expect(error.errors.name).toBeDefined();
    });

    it('enforces unique name', async () => {
        const nameIndex = ModelProfile.schema.indexes().find(([keys]) => keys.name === 1);
        expect(nameIndex?.[1]?.unique).toBe(true);
    });

    it('validates readiness stage enum — accepts valid stages', async () => {
        const profile = new ModelProfile(validProfile);
        const validStages = ['available', 'profiled', 'benchmarked'];
        for (const stage of validStages) {
            profile.readiness.set('host-delta', { stage });
            expect(profile.validateSync()).toBeUndefined();
        }
    });

    it('validates readiness stage enum — rejects invalid stage', async () => {
        const profile = new ModelProfile(validProfile);
        profile.readiness.set('host-delta', { stage: 'invalid_stage' });
        expect(profile.validateSync()?.message).toMatch(/invalid_stage|readiness/);
    });

    it('rejects the retired adapted readiness stage', () => {
        const profile = new ModelProfile(validProfile);
        profile.readiness.set('host-delta', { stage: 'adapted' });
        expect(profile.validateSync()?.message).toMatch(/adapted|readiness/);
    });

    it('defaults tags to empty array', async () => {
        const profile = new ModelProfile({ name: 'minimal-model' });
        expect(Array.isArray(profile.tags)).toBe(true);
        expect(profile.tags).toHaveLength(0);
    });

    it('defaults readiness stage to available', async () => {
        const profile = new ModelProfile(validProfile);
        profile.readiness.set('host-beta', {});
        expect(profile.validateSync()).toBeUndefined();
        expect(profile.readiness.get('host-beta').stage).toBe('available');
    });

    it('stores and retrieves hosts map entries', async () => {
        const profile = new ModelProfile(validProfile);
        profile.hosts.set('host-delta', { available: true, lastSeen: new Date('2026-01-01') });
        expect(profile.validateSync()).toBeUndefined();
        expect(profile.hosts.get('host-delta').available).toBe(true);
    });

    it('stores host-specific thinking profiles', async () => {
        const profile = new ModelProfile({
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
        expect(profile.validateSync()).toBeUndefined();
        expect(profile.thinkingProfiles.get('host-gamma')).toMatchObject({
            supported: true,
            channel: 'hidden',
            finalAnswerContractOk: true,
            recommendedPolicy: 'metered'
        });
    });
});
