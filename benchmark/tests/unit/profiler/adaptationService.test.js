const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');

let mongoServer;

beforeAll(async () => {
    mongoServer = await MongoMemoryServer.create();
    await mongoose.connect(mongoServer.getUri());
});

afterAll(async () => {
    await mongoose.disconnect();
    await mongoServer.stop();
});

const ModelAdaptation = require('../../../models/ModelAdaptation');

beforeEach(async () => {
    await ModelAdaptation.init();
});

afterEach(async () => {
    await ModelAdaptation.deleteMany({});
});

describe('ModelAdaptation', () => {
    const validAdaptation = {
        modelName: 'llama3.1:8b-q4_K_M',
        hostId: 'host-delta',
        adaptedName: 'ax/llama3.1:8b-q4_K_M',
        profile: {
            tokensPerSec: 42.5,
            promptEvalTokensPerSec: 310.2,
            ttftMs: 185,
            optimalNumCtx: 8192,
            vramUsedMiB: 5800,
            degradationPct: 3.2,
            probeSteps: [
                { numCtx: 4096, tokPerSec: 45.1, vramMiB: 5200 },
                { numCtx: 8192, tokPerSec: 42.5, vramMiB: 5800 },
                { numCtx: 16384, tokPerSec: 36.8, vramMiB: 7100 }
            ],
            profiledAt: new Date('2026-04-01T10:00:00Z'),
            profileDepth: 'standard'
        },
        config: {
            num_ctx: 8192,
            num_gpu: 1,
            num_batch: 512,
            num_thread: 4
        },
        modelfile: {
            content: 'FROM llama3.1:8b-q4_K_M\nPARAMETER num_ctx 8192',
            generatedAt: new Date('2026-04-01T10:05:00Z'),
            hash: 'abc123def456'
        },
        deployment: {
            status: 'deployed',
            deployedAt: new Date('2026-04-01T10:10:00Z'),
            ollamaDigest: 'sha256:deadbeef'
        },
        staleness: {
            stale: false,
            reason: null,
            lastCheckedAt: new Date('2026-04-02T08:00:00Z'),
            profileAgeDays: 1
        }
    };

    it('creates a valid adaptation with all fields', async () => {
        const doc = await ModelAdaptation.create(validAdaptation);

        expect(doc.modelName).toBe('llama3.1:8b-q4_K_M');
        expect(doc.hostId).toBe('host-delta');
        expect(doc.adaptedName).toBe('ax/llama3.1:8b-q4_K_M');
        expect(doc.profile.tokensPerSec).toBe(42.5);
        expect(doc.profile.optimalNumCtx).toBe(8192);
        expect(doc.profile.vramUsedMiB).toBe(5800);
        expect(doc.profile.profileDepth).toBe('standard');
        expect(doc.config.num_ctx).toBe(8192);
        expect(doc.config.num_gpu).toBe(1);
        expect(doc.modelfile.hash).toBe('abc123def456');
        expect(doc.deployment.status).toBe('deployed');
        expect(doc.deployment.ollamaDigest).toBe('sha256:deadbeef');
        expect(doc.staleness.stale).toBe(false);
        expect(doc.createdAt).toBeDefined();
        expect(doc.updatedAt).toBeDefined();
    });

    it('requires modelName', async () => {
        await expect(ModelAdaptation.create({ hostId: 'host-delta' }))
            .rejects.toThrow(/modelName/);
    });

    it('requires hostId', async () => {
        await expect(ModelAdaptation.create({ modelName: 'llama3.1:8b-q4_K_M' }))
            .rejects.toThrow(/hostId/);
    });

    it('enforces unique compound index on modelName + hostId', async () => {
        await ModelAdaptation.create(validAdaptation);
        await expect(ModelAdaptation.create({
            modelName: validAdaptation.modelName,
            hostId: validAdaptation.hostId
        })).rejects.toThrow();
    });

    it('validates deployment status enum — rejects invalid value', async () => {
        const doc = new ModelAdaptation({
            modelName: 'llama3.1:8b-q4_K_M',
            hostId: 'host-delta',
            deployment: { status: 'broken' }
        });
        await expect(doc.save()).rejects.toThrow(/broken|deployment\.status/);
    });

    it('validates deployment status enum — accepts all valid values', async () => {
        const validStatuses = ['pending', 'deployed', 'failed', 'removed'];
        for (const status of validStatuses) {
            const doc = await ModelAdaptation.create({
                modelName: `model-status-${status}`,
                hostId: 'host-delta',
                deployment: { status }
            });
            expect(doc.deployment.status).toBe(status);
        }
    });

    it('validates profileDepth enum — rejects invalid value', async () => {
        const doc = new ModelAdaptation({
            modelName: 'llama3.1:8b-q4_K_M',
            hostId: 'host-delta',
            profile: { profileDepth: 'deep' }
        });
        await expect(doc.save()).rejects.toThrow(/deep|profile\.profileDepth/);
    });

    it('validates profileDepth enum — accepts all valid values', async () => {
        const validDepths = ['quick', 'standard', 'full'];
        for (const profileDepth of validDepths) {
            const doc = await ModelAdaptation.create({
                modelName: `model-depth-${profileDepth}`,
                hostId: 'host-delta',
                profile: { profileDepth }
            });
            expect(doc.profile.profileDepth).toBe(profileDepth);
        }
    });

    it('stores probe steps array correctly', async () => {
        const doc = await ModelAdaptation.create({
            modelName: 'llama3.1:8b-q4_K_M',
            hostId: 'host-delta',
            profile: {
                probeSteps: [
                    { numCtx: 4096, tokPerSec: 45.1, vramMiB: 5200 },
                    { numCtx: 8192, tokPerSec: 42.5, vramMiB: 5800 }
                ]
            }
        });

        const saved = await ModelAdaptation.findById(doc._id);
        expect(saved.profile.probeSteps).toHaveLength(2);
        expect(saved.profile.probeSteps[0].numCtx).toBe(4096);
        expect(saved.profile.probeSteps[0].tokPerSec).toBe(45.1);
        expect(saved.profile.probeSteps[0].vramMiB).toBe(5200);
        expect(saved.profile.probeSteps[1].numCtx).toBe(8192);
    });

    it('defaults deployment status to pending', async () => {
        const doc = await ModelAdaptation.create({
            modelName: 'llama3.1:8b-q4_K_M',
            hostId: 'host-delta'
        });
        expect(doc.deployment.status).toBe('pending');
    });
});
