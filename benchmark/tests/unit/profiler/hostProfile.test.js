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

afterEach(async () => {
    await HostProfile.deleteMany({});
});

const HostProfile = require('../../../models/HostProfile');

beforeEach(async () => {
    await HostProfile.init(); // ensure indexes exist
});

describe('HostProfile', () => {
    const validProfile = {
        hostId: 'host-delta',
        hostUrl: 'http://192.0.2.66:11434',
        displayName: 'Host Delta',
        gpu: {
            model: 'RTX 3090',
            vramTotalMiB: 24576,
            computeCapability: '8.6',
            driver: '550.54.15'
        },
        ollama: {
            version: '0.3.12',
            backend: 'CUDA',
            cudaVersion: '12.4'
        },
        baseline: {
            referenceModel: 'llama3.2:3b',
            tokensPerSec: 120.5,
            latencyMs: 850,
            ttftMs: 210,
            testedAt: new Date()
        },
        status: 'online',
        lastSeenAt: new Date()
    };

    it('creates a valid host profile', async () => {
        const profile = await HostProfile.create(validProfile);
        expect(profile.hostId).toBe('host-delta');
        expect(profile.hostUrl).toBe('http://192.0.2.66:11434');
        expect(profile.displayName).toBe('Host Delta');
        expect(profile.gpu.model).toBe('RTX 3090');
        expect(profile.gpu.vramTotalMiB).toBe(24576);
        expect(profile.ollama.backend).toBe('CUDA');
        expect(profile.baseline.referenceModel).toBe('llama3.2:3b');
        expect(profile.baseline.tokensPerSec).toBe(120.5);
        expect(profile.status).toBe('online');
    });

    it('requires hostId', async () => {
        const { hostId, ...withoutHostId } = validProfile;
        await expect(HostProfile.create(withoutHostId)).rejects.toThrow();
    });

    it('requires hostUrl', async () => {
        const { hostUrl, ...withoutHostUrl } = validProfile;
        await expect(HostProfile.create(withoutHostUrl)).rejects.toThrow();
    });

    it('enforces unique hostId', async () => {
        await HostProfile.create(validProfile);
        await expect(
            HostProfile.create({ ...validProfile, hostUrl: 'http://192.0.2.66:11434' })
        ).rejects.toThrow();
    });

    it('validates status enum', async () => {
        await expect(
            HostProfile.create({ ...validProfile, hostId: 'test-status', status: 'unreachable' })
        ).rejects.toThrow();
    });

    it('validates backend enum', async () => {
        await expect(
            HostProfile.create({
                ...validProfile,
                hostId: 'test-backend',
                ollama: { ...validProfile.ollama, backend: 'INVALID_BACKEND' }
            })
        ).rejects.toThrow();
    });

    it('defaults status to unknown', async () => {
        const { status, ...withoutStatus } = validProfile;
        const profile = await HostProfile.create({ ...withoutStatus, hostId: 'test-default-status' });
        expect(profile.status).toBe('unknown');
    });
});
