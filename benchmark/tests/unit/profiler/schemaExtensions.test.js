const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');

jest.setTimeout(30000);

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
const HostProfile = require('../../../models/HostProfile');

afterEach(async () => {
    await ModelAdaptation.deleteMany({});
    await HostProfile.deleteMany({});
});

describe('ModelAdaptation schema extensions', () => {
    const baseAdaptation = {
        modelName: 'llama3.2:3b',
        hostId: 'host-delta'
    };

    it('stores spill detection data', async () => {
        const doc = await ModelAdaptation.create({
            ...baseAdaptation,
            profile: {
                spill: {
                    spillDetected: true,
                    lastSafeNumCtx: 8192,
                    spillNumCtx: 16384,
                    vramAtSpill: 23800,
                    sizeVram: 5000,
                    sizeTotal: 6000
                }
            }
        });
        expect(doc.profile.spill.spillDetected).toBe(true);
        expect(doc.profile.spill.lastSafeNumCtx).toBe(8192);
        expect(doc.profile.spill.spillNumCtx).toBe(16384);
        expect(doc.profile.spill.vramAtSpill).toBe(23800);
        expect(doc.profile.spill.sizeVram).toBe(5000);
        expect(doc.profile.spill.sizeTotal).toBe(6000);
    });

    it('stores throughput curve data', async () => {
        const curvePoints = [
            { contextFillPct: 25, numCtx: 2048, tokensPerSec: 85.2, vramUsedMiB: 4000, gpuOffloaded: true },
            { contextFillPct: 50, numCtx: 4096, tokensPerSec: 72.1, vramUsedMiB: 6500, gpuOffloaded: true },
            { contextFillPct: 100, numCtx: 8192, tokensPerSec: 45.3, vramUsedMiB: 12000, gpuOffloaded: false }
        ];
        const doc = await ModelAdaptation.create({
            ...baseAdaptation,
            profile: { throughputCurve: curvePoints }
        });
        expect(doc.profile.throughputCurve).toHaveLength(3);
        expect(doc.profile.throughputCurve[0].contextFillPct).toBe(25);
        expect(doc.profile.throughputCurve[0].tokensPerSec).toBe(85.2);
        expect(doc.profile.throughputCurve[2].gpuOffloaded).toBe(false);
    });

    it('stores generation stability data', async () => {
        const stabilityPoints = [
            { numPredict: 128, tokensPerSec: 82.5, totalLatencyMs: 1550 },
            { numPredict: 512, tokensPerSec: 78.1, totalLatencyMs: 6560 }
        ];
        const doc = await ModelAdaptation.create({
            ...baseAdaptation,
            profile: { generationStability: stabilityPoints }
        });
        expect(doc.profile.generationStability).toHaveLength(2);
        expect(doc.profile.generationStability[0].numPredict).toBe(128);
        expect(doc.profile.generationStability[1].totalLatencyMs).toBe(6560);
    });

    it('stores load timing data', async () => {
        const doc = await ModelAdaptation.create({
            ...baseAdaptation,
            profile: {
                loadTiming: { coldLoadMs: 3200, hotLoadMs: 450 }
            }
        });
        expect(doc.profile.loadTiming.coldLoadMs).toBe(3200);
        expect(doc.profile.loadTiming.hotLoadMs).toBe(450);
    });

    it('stores thinking behavior profile data', async () => {
        const doc = await ModelAdaptation.create({
            ...baseAdaptation,
            profile: {
                thinking: {
                    profiledAt: new Date('2026-07-07T00:00:00Z'),
                    apiMode: 'chat',
                    supported: true,
                    supportSignal: 'hidden_channel',
                    channel: 'hidden',
                    visibleFinalAnswerOk: true,
                    finalAnswerContractOk: true,
                    thinkingOnlyResponse: false,
                    runawayRisk: false,
                    tokenMultiplier: 4.2,
                    latencyMultiplier: 3.1,
                    recommendedPolicy: 'metered',
                    recommendationReason: 'safe but expensive',
                    think: {
                        requestedThink: true,
                        ok: true,
                        channel: 'hidden',
                        visibleFinalAnswerOk: true,
                        finalAnswerContractOk: true,
                        thinkingPresent: true,
                        nativeThinkingPresent: true,
                        completionTokens: 512
                    }
                }
            }
        });

        expect(doc.profile.thinking.supported).toBe(true);
        expect(doc.profile.thinking.channel).toBe('hidden');
        expect(doc.profile.thinking.recommendedPolicy).toBe('metered');
        expect(doc.profile.thinking.think.finalAnswerContractOk).toBe(true);
        expect(doc.profile.thinking.think.completionTokens).toBe(512);
    });

    it('stores lineage data', async () => {
        const doc = await ModelAdaptation.create({
            ...baseAdaptation,
            lineage: {
                parentModel: 'llama3.2:3b',
                rootModel: 'llama3.2',
                quantization: 'Q4_K_M',
                adaptedFrom: 'llama3.2:3b-fp16',
                createdVia: 'profiler'
            }
        });
        expect(doc.lineage.parentModel).toBe('llama3.2:3b');
        expect(doc.lineage.rootModel).toBe('llama3.2');
        expect(doc.lineage.quantization).toBe('Q4_K_M');
        expect(doc.lineage.createdVia).toBe('profiler');
    });

    it('rejects invalid createdVia enum value', async () => {
        await expect(
            ModelAdaptation.create({
                ...baseAdaptation,
                hostId: 'enum-test',
                lineage: { createdVia: 'automatic' }
            })
        ).rejects.toThrow();
    });

    it('stores deployment history array', async () => {
        const history = [
            { status: 'deployed', deployedAt: new Date('2025-01-01'), modelfileHash: 'abc123' },
            { status: 'failed', deployedAt: new Date('2025-01-02'), modelfileHash: 'def456', error: 'VRAM exhausted' }
        ];
        const doc = await ModelAdaptation.create({
            ...baseAdaptation,
            deployment: { status: 'failed', history }
        });
        expect(doc.deployment.history).toHaveLength(2);
        expect(doc.deployment.history[0].status).toBe('deployed');
        expect(doc.deployment.history[0].modelfileHash).toBe('abc123');
        expect(doc.deployment.history[1].error).toBe('VRAM exhausted');
    });

    it('stores extended config fields (num_predict, num_keep)', async () => {
        const doc = await ModelAdaptation.create({
            ...baseAdaptation,
            config: {
                num_ctx: 8192,
                num_gpu: 99,
                num_batch: 512,
                num_thread: 8,
                num_predict: 1024,
                num_keep: 256
            }
        });
        expect(doc.config.num_predict).toBe(1024);
        expect(doc.config.num_keep).toBe(256);
    });
});

describe('HostProfile schema extensions', () => {
    const baseProfile = {
        hostId: 'cpu-test-host',
        hostUrl: 'http://192.0.2.66:11434'
    };

    it('stores cpu data with cores', async () => {
        const doc = await HostProfile.create({
            ...baseProfile,
            cpu: { cores: 16 }
        });
        expect(doc.cpu.cores).toBe(16);
    });

    it('stores cpu with threadOverride', async () => {
        const doc = await HostProfile.create({
            ...baseProfile,
            hostId: 'cpu-thread-test',
            cpu: { cores: 16, threadOverride: 8 }
        });
        expect(doc.cpu.cores).toBe(16);
        expect(doc.cpu.threadOverride).toBe(8);
    });
});
