jest.mock('../../../config/logger', () => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn()
}));

const mockPreflight = jest.fn();
const mockRunPreflight = jest.fn();
jest.mock('../../../src/services/profiler/profilerOrchestrator', () => ({
    preflight: (...args) => mockPreflight(...args),
    runPreflight: (...args) => mockRunPreflight(...args)
}));

jest.mock('../../../src/helpers/httpAgent', () => ({
    getFetchOptions: jest.fn((_, options) => options)
}));

jest.mock('../../../src/helpers/ollamaHostConfig', () => ({
    normalizeHostUrl: jest.fn((url) => url),
    getConfiguredHosts: jest.fn(() => [{ id: 'primary', url: 'http://exec:11434' }])
}));

const mockClaimHostForBenchmark = jest.fn();
const mockHeartbeatBenchmarkClaim = jest.fn();
const mockReleaseBenchmarkClaim = jest.fn();
const mockGetBenchmarkClaims = jest.fn();
jest.mock('../../../src/clients/coreApiClient', () => ({
    claimHostForBenchmark: (...args) => mockClaimHostForBenchmark(...args),
    heartbeatBenchmarkClaim: (...args) => mockHeartbeatBenchmarkClaim(...args),
    releaseBenchmarkClaim: (...args) => mockReleaseBenchmarkClaim(...args),
    getBenchmarkClaims: (...args) => mockGetBenchmarkClaims(...args),
    getDedicationStatuses: jest.fn(() => Promise.resolve([])),
    resolveHostKey: jest.fn(() => Promise.resolve(null)),
    restoreDedication: jest.fn(() => Promise.resolve({}))
}));

const mockDetectDedication = jest.fn();
const mockReleaseAllDedication = jest.fn();
const mockRestoreAllDedication = jest.fn();
jest.mock('../../../src/services/benchmark/dedicationLifecycle', () => ({
    detectDedication: (...args) => mockDetectDedication(...args),
    releaseAllDedication: (...args) => mockReleaseAllDedication(...args),
    restoreAllDedication: (...args) => mockRestoreAllDedication(...args)
}));

const mockWarmupModel = jest.fn();
jest.mock('../../../src/services/benchmark/modelWarmup', () => ({
    warmupModel: (...args) => mockWarmupModel(...args)
}));

const mockBenchmarkFetch = jest.fn();
jest.mock('../../../src/services/benchmark/http', () => ({
    benchmarkFetch: (...args) => mockBenchmarkFetch(...args)
}));

const mockLoadOrResolveCampaignInferenceContracts = jest.fn();
const mockLoadOrResumeCampaignInferenceContracts = jest.fn();
const mockGetFrozenModelExecutionConfig = jest.fn();
const mockAssertFrozenArtifactDigest = jest.fn();
jest.mock('../../../src/services/benchmark/inferenceContractSnapshot', () => ({
    loadOrResolveCampaignInferenceContracts: (...args) => mockLoadOrResolveCampaignInferenceContracts(...args),
    loadOrResumeCampaignInferenceContracts: (...args) => mockLoadOrResumeCampaignInferenceContracts(...args),
    getFrozenModelExecutionConfig: (...args) => mockGetFrozenModelExecutionConfig(...args),
    assertFrozenArtifactDigest: (...args) => mockAssertFrozenArtifactDigest(...args)
}));

const mockResolveJudgeHost = jest.fn();
jest.mock('../../../src/services/benchmark/judgeHostResolution', () => ({
    resolveJudgeHost: (...args) => mockResolveJudgeHost(...args)
}));

// resolveModelNumCtxDetails reaches into Mongo (ModelProfile,
// ModelContextProbeSnapshot) which isn't connected in unit tests. Stub it
// so the orchestrator's judge-warmup ctx lookup doesn't time out.
jest.mock('../../../src/services/modelContextResolver', () => ({
    resolveModelNumCtxDetails: jest.fn().mockResolvedValue({
        num_ctx: 8192,
        source: 'fallback',
        authoritative: true,
        targetHost: null
    }),
    resolveModelNumCtx: jest.fn().mockResolvedValue(8192),
    normalizeModelName: jest.fn((name) => String(name || '').trim().replace(/:latest$/i, '')),
    modelNameCandidates: jest.fn((name) => {
        const normalized = String(name || '').trim().replace(/:latest$/i, '');
        if (!normalized) return [];
        const slashIdx = normalized.indexOf('/');
        if (slashIdx <= 0 || slashIdx === normalized.length - 1) return [normalized];
        const bare = normalized.slice(slashIdx + 1);
        return bare === normalized ? [normalized] : [normalized, bare];
    })
}));

const mockTestModelOnHost = jest.fn();
jest.mock('../../../src/services/hostTestService', () => ({
    testModelOnHost: (...args) => mockTestModelOnHost(...args)
}));

const mockToPerformanceBaseline = jest.fn();
const mockGroupModelsByHost = jest.fn();
const mockCreateCurrentTestPersistenceStrategy = jest.fn();
jest.mock('../../../src/services/benchmark/batchHelpers', () => ({
    toPerformanceBaseline: (...args) => mockToPerformanceBaseline(...args),
    groupModelsByHost: (...args) => mockGroupModelsByHost(...args),
    createCurrentTestPersistenceStrategy: (...args) => mockCreateCurrentTestPersistenceStrategy(...args)
}));

const mockPersistSuccessfulResult = jest.fn();
const mockPersistFailedResult = jest.fn();
jest.mock('../../../src/services/benchmark/batchResultPersistence', () => ({
    persistSuccessfulResult: (...args) => mockPersistSuccessfulResult(...args),
    persistFailedResult: (...args) => mockPersistFailedResult(...args)
}));

jest.mock('../../../src/services/benchmark/errorClassifier', () => ({
    classifyBenchmarkError: jest.fn(() => ({ infra: false }))
}));

jest.mock('../../../src/helpers/ollamaResponseHandler', () => ({
    extractThinkingBlocks: jest.fn((text) => ({ content: text, thinking: null }))
}));

jest.mock('../../../src/services/benchmark/judging', () => ({
    judgeResult: jest.fn()
}));

jest.mock('../../../src/services/qualityScorer', () => ({
    JUDGE_CONFIG: { model: 'judge-default' }
}));

const mockCountDocuments = jest.fn();
jest.mock('../../../models/BenchmarkResult', () => ({
    countDocuments: (...args) => mockCountDocuments(...args)
}));

const mockFindOneAdaptation = jest.fn();
jest.mock('../../../models/ModelAdaptation', () => ({
    findOne: (...args) => mockFindOneAdaptation(...args)
}));

const mockFindById = jest.fn();
const mockUpdateOne = jest.fn();
jest.mock('../../../models/BenchmarkBatch', () => ({
    findById: (...args) => mockFindById(...args),
    updateOne: (...args) => mockUpdateOne(...args),
    findOneAndUpdate: jest.fn()
}));

jest.mock('../../../models/BenchmarkTimelineEntry', () => ({
    insertMany: jest.fn(() => Promise.resolve()),
    create: jest.fn(() => Promise.resolve())
}));

jest.mock('../../../models/JudgeQueueEntry', () => ({
    create: jest.fn(() => Promise.resolve({ _id: 'queue-1' })),
    updateOne: jest.fn(() => Promise.resolve())
}));

const mockWaitForCapacity = jest.fn();
const mockAdd = jest.fn();
const mockGetStatus = jest.fn();
const mockDrain = jest.fn();
jest.mock('../../../src/services/benchmark/ConcurrencyQueue', () => jest.fn().mockImplementation(() => ({
    waitForCapacity: (...args) => mockWaitForCapacity(...args),
    add: (...args) => mockAdd(...args),
    getStatus: (...args) => mockGetStatus(...args),
    drain: (...args) => mockDrain(...args)
})));

const { runBatchOrchestrator } = require('../../../src/services/benchmark/batchOrchestrator');
const { estimateBenchmarkClaimDurationMs } = require('../../../src/services/benchmark/benchmarkClaimLifecycle');

function deferred() {
    let resolve;
    let reject;
    const promise = new Promise((res, rej) => {
        resolve = res;
        reject = rej;
    });
    return { promise, resolve, reject };
}

function setResumeCheckpoint({ completedPairs, lastModel, lastPrompt, currentBatch = { completed: 0 } }) {
    let findByIdCall = 0;
    mockFindById.mockImplementation(() => {
        findByIdCall += 1;
        if (findByIdCall === 1) {
            return {
                select: jest.fn().mockReturnValue({
                    lean: jest.fn().mockResolvedValue({
                        checkpoint: {
                            completed_pairs: completedPairs,
                            last_model: lastModel,
                            last_prompt: lastPrompt
                        }
                    })
                })
            };
        }
        if (findByIdCall === 2) return Promise.resolve(currentBatch);
        return {
            select: jest.fn().mockReturnValue({
                lean: jest.fn().mockResolvedValue({ status: 'running' })
            })
        };
    });
}

describe('runBatchOrchestrator claim lifecycle', () => {
    beforeEach(() => {
        jest.clearAllMocks();

        mockPreflight.mockResolvedValue({
            profilesNeeded: [],
            adaptsNeeded: [],
            warnings: []
        });
        mockRunPreflight.mockResolvedValue(undefined);
        mockClaimHostForBenchmark.mockResolvedValue({ claimed: true });
        mockHeartbeatBenchmarkClaim.mockResolvedValue({ heartbeat: true });
        mockReleaseBenchmarkClaim.mockResolvedValue({ released: true });
        mockDetectDedication.mockResolvedValue(new Map([
            ['http://exec:11434', { hostKey: 'primary', pinnedModels: ['pinned-model'] }]
        ]));
        mockReleaseAllDedication.mockResolvedValue(undefined);
        mockRestoreAllDedication.mockResolvedValue(undefined);
        mockWarmupModel.mockResolvedValue({ warmed: true });
        mockResolveJudgeHost.mockImplementation((hostUrl) => ({
            judgeHost: hostUrl,
            resolution: 'default'
        }));
        mockFindOneAdaptation.mockReturnValue({
            select: jest.fn().mockReturnValue({
                lean: jest.fn().mockResolvedValue(null)
            })
        });
        mockTestModelOnHost.mockResolvedValue({ status: 'ok', testedAt: new Date('2026-04-19T18:00:00Z') });
        mockToPerformanceBaseline.mockReturnValue({ baseline: true });
        mockGroupModelsByHost.mockImplementation((defaultHost, models) => ({
            [defaultHost]: models
        }));
        mockCreateCurrentTestPersistenceStrategy.mockReturnValue(() => false);
        mockPersistSuccessfulResult.mockResolvedValue('result-1');
        mockPersistFailedResult.mockResolvedValue(undefined);
        mockBenchmarkFetch.mockResolvedValue({
            ok: true,
            json: async () => ({
                message: { content: 'judge me' },
                eval_count: 12,
                prompt_eval_duration: 1_000_000,
                done_reason: 'stop'
            })
        });
        mockWaitForCapacity.mockResolvedValue(undefined);
        mockAdd.mockImplementation(() => Promise.resolve());
        mockGetStatus.mockImplementation(() => ({
            queued: 1,
            running: 0,
            completed: 0,
            failed: 0,
            lastActivityAt: Date.now(),
            stalledMs: 0
        }));
        mockUpdateOne.mockResolvedValue({ matchedCount: 1 });
        mockLoadOrResolveCampaignInferenceContracts.mockResolvedValue({
            requestFingerprint: 'campaign-fingerprint',
            candidates: []
        });
        mockLoadOrResumeCampaignInferenceContracts.mockResolvedValue({
            requestFingerprint: 'campaign-fingerprint',
            candidates: []
        });
        mockGetBenchmarkClaims.mockResolvedValue([
            { hostUrl: 'http://exec:11434', batchId: 'batch-resume-test', hostKey: 'primary' }
        ]);
        mockAssertFrozenArtifactDigest.mockResolvedValue('sha256:test');
        mockGetFrozenModelExecutionConfig.mockImplementation((_, __, ___, baseConfig) => ({
            ...baseConfig,
            send_think: true,
            rankable_mode: true,
            inference_contract_fingerprint: 'a'.repeat(64),
            artifact_digest: 'sha256:test'
        }));

        const currentBatchDoc = {
            completed: 0
        };
        let findByIdCall = 0;
        mockFindById.mockImplementation(() => {
            findByIdCall += 1;
            if (findByIdCall === 1) {
                return {
                    select: jest.fn().mockReturnValue({
                        lean: jest.fn().mockResolvedValue({ checkpoint: { completed_pairs: [] } })
                    })
                };
            }
            if (findByIdCall === 2) {
                return Promise.resolve(currentBatchDoc);
            }
            return {
                select: jest.fn().mockReturnValue({
                    lean: jest.fn().mockResolvedValue({ status: 'running' })
                })
            };
        });

        mockCountDocuments
            .mockResolvedValueOnce(1)
            .mockResolvedValueOnce(1)
            .mockResolvedValueOnce(1)
            .mockResolvedValueOnce(0);
    });

    it('keeps claims and dedication active until judge drain completes', async () => {
        const drainStarted = deferred();
        const releaseDrain = deferred();
        mockDrain.mockImplementation(async () => {
            drainStarted.resolve();
            await releaseDrain.promise;
            return { completed: 1, failed: 0, timedOut: false };
        });

        const recordBatchTimelineEvent = jest.fn(() => Promise.resolve());
        const flushBatchProgress = jest.fn(() => Promise.resolve());
        const executionConfig = {
            per_test_timeout_ms: 60_000,
            judge_drain_timeout_ms: 120_000,
            judge_stall_timeout_ms: 30_000
        };
        const expectedEstimateMs = estimateBenchmarkClaimDurationMs({
            hostCount: 1,
            modelCount: 1,
            promptCount: 1,
            executionConfig,
            executionMode: 'throughput',
            judgeConfig: { concurrency: 2 }
        });

        const runPromise = runBatchOrchestrator({
            batchId: 'batch-judge-phase',
            defaultHost: 'http://exec:11434',
            models: ['model-a'],
            prompts: [{
                _id: 'prompt-1',
                name: 'Prompt 1',
                prompt: 'Say hello',
                level: 1,
                category: 'reasoning'
            }],
            judgeConfig: { concurrency: 2 },
            executionConfig,
            executionMode: 'throughput',
            getModelExecutionConfig: jest.fn(async () => executionConfig),
            recordBatchTimelineEvent,
            queueBatchProgress: jest.fn(),
            flushBatchProgress,
            handleGracefulStop: jest.fn()
        });

        await drainStarted.promise;

        expect(mockClaimHostForBenchmark).toHaveBeenCalledWith(
            'http://exec:11434',
            'batch-judge-phase',
            expectedEstimateMs,
            { source: 'benchmark', owner: 'agentx-benchmark' }
        );
        expect(mockReleaseAllDedication).toHaveBeenCalledTimes(1);
        expect(mockReleaseAllDedication).toHaveBeenCalledWith(
            expect.any(Map),
            expect.objectContaining({
                batchId: 'batch-judge-phase',
                recordBatchTimelineEvent
            })
        );
        expect(mockClaimHostForBenchmark.mock.invocationCallOrder[0]).toBeLessThan(
            mockReleaseAllDedication.mock.invocationCallOrder[0]
        );
        expect(mockReleaseBenchmarkClaim).not.toHaveBeenCalled();
        expect(mockRestoreAllDedication).not.toHaveBeenCalled();
        expect(mockHeartbeatBenchmarkClaim).toHaveBeenCalledWith(
            'http://exec:11434',
            'batch-judge-phase',
            expectedEstimateMs
        );

        releaseDrain.resolve();
        await runPromise;

        expect(mockRestoreAllDedication).toHaveBeenCalledTimes(1);
        expect(mockReleaseBenchmarkClaim).toHaveBeenCalledWith('http://exec:11434', 'batch-judge-phase');
        expect(mockReleaseBenchmarkClaim.mock.invocationCallOrder[0]).toBeLessThan(
            mockRestoreAllDedication.mock.invocationCallOrder[0]
        );
        expect(recordBatchTimelineEvent).toHaveBeenCalledWith('benchmark_claim_released', {
            hosts: ['http://exec:11434']
        });
    });

    it('defers same-host judging until execution completes and warms the judge once', async () => {
        mockDrain.mockResolvedValue({ completed: 1, failed: 0, timedOut: false });

        await runBatchOrchestrator({
            batchId: 'batch-same-host-deferred',
            defaultHost: 'http://exec:11434',
            models: ['model-a'],
            prompts: [{
                _id: 'prompt-1',
                name: 'Prompt 1',
                prompt: 'Say hello',
                level: 1,
                category: 'reasoning'
            }],
            judgeConfig: { model: 'judge-1', concurrency: 2 },
            executionConfig: {
                per_test_timeout_ms: 60_000,
                judge_drain_timeout_ms: 120_000,
                judge_stall_timeout_ms: 30_000
            },
            executionMode: 'throughput',
            getModelExecutionConfig: jest.fn(async () => ({ per_test_timeout_ms: 60_000 })),
            recordBatchTimelineEvent: jest.fn(() => Promise.resolve()),
            queueBatchProgress: jest.fn(),
            flushBatchProgress: jest.fn(() => Promise.resolve()),
            handleGracefulStop: jest.fn()
        });

        expect(mockWarmupModel).toHaveBeenCalledTimes(2);
        expect(mockWarmupModel).toHaveBeenNthCalledWith(
            1,
            'http://exec:11434',
            'model-a',
            expect.objectContaining({ timelinePrefix: 'model_warmup' })
        );
        expect(mockWarmupModel).toHaveBeenNthCalledWith(
            2,
            'http://exec:11434',
            'judge-1',
            expect.objectContaining({
                timelinePrefix: 'judge_warmup',
                strict: true,
                timeoutOverride: 90000
            })
        );
        expect(mockAdd).toHaveBeenCalledTimes(1);
        expect(mockWarmupModel.mock.invocationCallOrder[1]).toBeLessThan(
            mockAdd.mock.invocationCallOrder[0]
        );
    });

    it('reuses profiler adaptation baseline instead of running host test again', async () => {
        mockDrain.mockResolvedValue({ completed: 1, failed: 0, timedOut: false });
        mockFindOneAdaptation.mockReturnValue({
            select: jest.fn().mockReturnValue({
                lean: jest.fn().mockResolvedValue({
                    profile: {
                        tokensPerSec: 123.4,
                        promptEvalTokensPerSec: 456.7,
                        ttftMs: 321,
                        vramUsedMiB: 8192,
                        profiledAt: new Date()
                    },
                    config: { num_ctx: 4096 }
                })
            })
        });

        await runBatchOrchestrator({
            batchId: 'batch-profiler-baseline',
            defaultHost: 'http://exec:11434',
            models: ['model-a'],
            prompts: [{
                _id: 'prompt-1',
                name: 'Prompt 1',
                prompt: 'Say hello',
                level: 1,
                category: 'reasoning'
            }],
            judgeConfig: { model: 'judge-1', concurrency: 2 },
            executionConfig: {
                per_test_timeout_ms: 60_000,
                judge_drain_timeout_ms: 120_000,
                judge_stall_timeout_ms: 30_000
            },
            executionMode: 'throughput',
            getModelExecutionConfig: jest.fn(async () => ({ per_test_timeout_ms: 60_000 })),
            recordBatchTimelineEvent: jest.fn(() => Promise.resolve()),
            queueBatchProgress: jest.fn(),
            flushBatchProgress: jest.fn(() => Promise.resolve()),
            handleGracefulStop: jest.fn()
        });

        expect(mockTestModelOnHost).not.toHaveBeenCalled();
        expect(mockToPerformanceBaseline).toHaveBeenCalledWith(
            'model-a',
            'http://exec:11434',
            expect.objectContaining({
                source: 'profiler_adaptation',
                tokensPerSec: 123.4,
                numCtx: 4096
            })
        );
    });

    it('passes execution num_ctx into live performance baseline probes', async () => {
        mockDrain.mockResolvedValue({ completed: 1, failed: 0, timedOut: false });

        const executionConfig = {
            num_ctx: 8192,
            per_test_timeout_ms: 60_000,
            judge_drain_timeout_ms: 120_000,
            judge_stall_timeout_ms: 30_000
        };

        await runBatchOrchestrator({
            batchId: 'batch-baseline-runtime-ctx',
            defaultHost: 'http://exec:11434',
            models: ['model-a'],
            prompts: [{
                _id: 'prompt-1',
                name: 'Prompt 1',
                prompt: 'Say hello',
                level: 1,
                category: 'reasoning'
            }],
            judgeConfig: { model: 'judge-1', concurrency: 2 },
            executionConfig,
            executionMode: 'throughput',
            getModelExecutionConfig: jest.fn(async () => ({
                ...executionConfig,
                num_ctx_source: 'force_override'
            })),
            recordBatchTimelineEvent: jest.fn(() => Promise.resolve()),
            queueBatchProgress: jest.fn(),
            flushBatchProgress: jest.fn(() => Promise.resolve()),
            handleGracefulStop: jest.fn()
        });

        expect(mockTestModelOnHost).toHaveBeenCalledWith(
            'model-a',
            'http://exec:11434',
            expect.objectContaining({
                _skipHostCheck: false,
                numCtx: 8192
            })
        );
    });

    it('omits all thinking controls when the frozen campaign mode is native', async () => {
        mockDrain.mockResolvedValue({ completed: 1, failed: 0, timedOut: false });
        mockGetFrozenModelExecutionConfig.mockImplementation((_, __, ___, baseConfig) => ({
            ...baseConfig,
            response_max_tokens: 2048,
            num_ctx: 16384,
            think: null,
            send_think: false,
            think_mode: 'native',
            rankable_mode: true,
            inference_contract_fingerprint: 'b'.repeat(64),
            artifact_digest: 'sha256:native'
        }));

        await runBatchOrchestrator({
            batchId: 'batch-native-mode',
            defaultHost: 'http://exec:11434',
            models: ['model-a'],
            prompts: [{
                _id: 'prompt-1',
                name: 'Prompt 1',
                prompt: 'Say hello',
                level: 1,
                category: 'reasoning'
            }],
            judgeConfig: { model: 'judge-1', concurrency: 2, think: false },
            executionConfig: {
                response_mode: 'native',
                per_test_timeout_ms: 60_000,
                judge_drain_timeout_ms: 120_000,
                judge_stall_timeout_ms: 30_000
            },
            executionMode: 'throughput',
            recordBatchTimelineEvent: jest.fn(() => Promise.resolve()),
            queueBatchProgress: jest.fn(),
            flushBatchProgress: jest.fn(() => Promise.resolve()),
            handleGracefulStop: jest.fn()
        });

        const requestBody = JSON.parse(mockBenchmarkFetch.mock.calls[0][1].body);
        expect(requestBody).not.toHaveProperty('think');
        expect(requestBody).not.toHaveProperty('includeThinking');
        expect(requestBody).not.toHaveProperty('suppressThinking');
        expect(requestBody.options).toMatchObject({ num_ctx: 16384, num_predict: 2048 });
    });

    // 0212 regression: a model whose warmup throws must NOT skip subsequent
    // models on the same host. Pre-fix, runHostBatch wrapped the whole
    // for-loop in a single try/catch and one throw bailed every remaining
    // model. This is what produced 0207 order-5's completed=0/315.
    it('continues to next model when one model throws during warmup (0212)', async () => {
        mockDrain.mockResolvedValue({ completed: 1, failed: 0, timedOut: false });
        // Map models to a single host so the orchestrator hits the per-model
        // loop with both models in one runHostBatch call.
        mockGroupModelsByHost.mockImplementation((defaultHost, models) => ({
            [defaultHost]: models
        }));
        // First model warmup rejects (simulates the 0207 order-5 scenario).
        // Subsequent calls succeed so model-b runs cleanly.
        mockWarmupModel
            .mockRejectedValueOnce(new Error('warmup failed: cold load timeout'))
            .mockResolvedValue({ warmed: true });

        const recordBatchTimelineEvent = jest.fn(() => Promise.resolve());

        await runBatchOrchestrator({
            batchId: 'batch-0212',
            defaultHost: 'http://exec:11434',
            models: ['model-a', 'model-b'],
            prompts: [{
                _id: 'prompt-1',
                name: 'Prompt 1',
                prompt: 'Say hello',
                level: 1,
                category: 'reasoning'
            }],
            judgeConfig: { model: 'judge-1', concurrency: 2 },
            executionConfig: {
                per_test_timeout_ms: 60_000,
                judge_drain_timeout_ms: 120_000,
                judge_stall_timeout_ms: 30_000
            },
            executionMode: 'throughput',
            getModelExecutionConfig: jest.fn(async () => ({ per_test_timeout_ms: 60_000 })),
            recordBatchTimelineEvent,
            queueBatchProgress: jest.fn(),
            flushBatchProgress: jest.fn(() => Promise.resolve()),
            handleGracefulStop: jest.fn()
        });

        // Pre-fix this would be 1 (model-a's warmup throws, host loop bails).
        // Post-fix: model-a's per-model catch swallows the throw and the loop
        // continues to model-b, whose warmup is called.
        const modelACalls = mockWarmupModel.mock.calls.filter(([_, m]) => m === 'model-a').length;
        const modelBCalls = mockWarmupModel.mock.calls.filter(([_, m]) => m === 'model-b').length;
        expect(modelACalls).toBeGreaterThanOrEqual(1);
        expect(modelBCalls).toBeGreaterThanOrEqual(1);

        // A model_execution_failed timeline event was recorded for model-a.
        const failureEvents = recordBatchTimelineEvent.mock.calls
            .filter(([eventName]) => eventName === 'model_execution_failed');
        expect(failureEvents.length).toBeGreaterThanOrEqual(1);
        expect(failureEvents[0][1]).toMatchObject({
            model: 'model-a',
            host: 'http://exec:11434'
        });
    });

    // 0469: Resume must use the frozen campaign snapshot and only validate
    // the affected model block, never reloading the full roster.
    it('resumes from checkpoint using frozen campaign without reloading full roster', async () => {
        mockDrain.mockResolvedValue({ completed: 1, failed: 0, timedOut: false });

        // Provide a valid host claim matching this batch so the resume check passes
        mockGetBenchmarkClaims.mockResolvedValue([
            { hostUrl: 'http://exec:11434', batchId: 'batch-resume-happy', hostKey: 'primary' }
        ]);

        setResumeCheckpoint({
            completedPairs: ['model-a::Prompt 1', 'model-a::Prompt 2'],
            lastModel: 'model-a',
            lastPrompt: 'Prompt 2',
            currentBatch: { completed: 2 }
        });

        const recordBatchTimelineEvent = jest.fn(() => Promise.resolve());

        await runBatchOrchestrator({
            batchId: 'batch-resume-happy',
            defaultHost: 'http://exec:11434',
            models: ['model-a', 'model-b'],
            prompts: [
                { _id: 'prompt-1', name: 'Prompt 1', prompt: 'Say hello', level: 1, category: 'reasoning' },
                { _id: 'prompt-2', name: 'Prompt 2', prompt: 'Say world', level: 1, category: 'reasoning' }
            ],
            judgeConfig: { model: 'judge-1', concurrency: 2 },
            executionConfig: {
                per_test_timeout_ms: 60_000,
                judge_drain_timeout_ms: 120_000,
                judge_stall_timeout_ms: 30_000
            },
            executionMode: 'throughput',
            getModelExecutionConfig: jest.fn(async () => ({ per_test_timeout_ms: 60_000 })),
            recordBatchTimelineEvent,
            queueBatchProgress: jest.fn(),
            flushBatchProgress: jest.fn(() => Promise.resolve()),
            handleGracefulStop: jest.fn()
        });

        // Resume path must call loadOrResume, never loadOrResolve
        expect(mockLoadOrResumeCampaignInferenceContracts).toHaveBeenCalledTimes(1);
        expect(mockLoadOrResolveCampaignInferenceContracts).not.toHaveBeenCalled();

        // Claim, artifact and warmup work touches only the next pending block.
        expect(mockGetBenchmarkClaims).toHaveBeenCalledTimes(1);
        expect(mockAssertFrozenArtifactDigest).toHaveBeenCalledWith(
            expect.any(Object),
            'model-b',
            'http://exec:11434'
        );
        expect(mockAssertFrozenArtifactDigest).not.toHaveBeenCalledWith(
            expect.any(Object),
            'model-a',
            expect.any(String)
        );
        expect(mockWarmupModel).toHaveBeenCalledWith(
            'http://exec:11434',
            'model-b',
            expect.any(Object)
        );
        expect(mockWarmupModel.mock.calls.filter(([, model]) => model === 'model-a')).toHaveLength(0);
        expect(mockPreflight).toHaveBeenCalledWith({
            models: [{ name: 'model-b', host: 'http://exec:11434', hostUrl: 'http://exec:11434' }]
        });

        // Resume decision was recorded
        const resumeEvent = recordBatchTimelineEvent.mock.calls
            .find(([eventName]) => eventName === 'inference_contract_resumed');
        expect(resumeEvent).toBeTruthy();
        expect(resumeEvent[1]).toMatchObject({
            resume_decision: 'reuse_frozen_snapshot',
            reload_required: false,
            last_checkpoint_model: 'model-a',
            model: 'model-b',
            completed_pairs_count: 2
        });
    });

    it('fails closed on resume when frozen campaign snapshot is missing', async () => {
        mockDrain.mockResolvedValue({ completed: 1, failed: 0, timedOut: false });
        mockLoadOrResumeCampaignInferenceContracts.mockRejectedValue(
            Object.assign(new Error('Resume blocked: missing frozen campaign snapshot. A full restart is required.'), {
                resumeBlocked: true,
                code: 'MISSING_OR_INCOMPATIBLE_CAMPAIGN'
            })
        );

        const currentBatchDoc = { completed: 0 };
        let findByIdCall = 0;
        mockFindById.mockImplementation(() => {
            findByIdCall += 1;
            if (findByIdCall === 1) {
                return {
                    select: jest.fn().mockReturnValue({
                        lean: jest.fn().mockResolvedValue({
                            checkpoint: {
                                completed_pairs: ['model-a::Prompt 1'],
                                last_model: 'model-a',
                                last_prompt: 'Prompt 1'
                            }
                        })
                    })
                };
            }
            if (findByIdCall === 2) {
                return Promise.resolve(currentBatchDoc);
            }
            return {
                select: jest.fn().mockReturnValue({
                    lean: jest.fn().mockResolvedValue({ status: 'running' })
                })
            };
        });

        const recordBatchTimelineEvent = jest.fn(() => Promise.resolve());

        await expect(runBatchOrchestrator({
            batchId: 'batch-resume-drift',
            defaultHost: 'http://exec:11434',
            models: ['model-a'],
            prompts: [
                { _id: 'prompt-1', name: 'Prompt 1', prompt: 'Say hello', level: 1, category: 'reasoning' }
            ],
            judgeConfig: { model: 'judge-1', concurrency: 2 },
            executionConfig: {
                per_test_timeout_ms: 60_000,
                judge_drain_timeout_ms: 120_000,
                judge_stall_timeout_ms: 30_000
            },
            executionMode: 'throughput',
            getModelExecutionConfig: jest.fn(async () => ({ per_test_timeout_ms: 60_000 })),
            recordBatchTimelineEvent,
            queueBatchProgress: jest.fn(),
            flushBatchProgress: jest.fn(() => Promise.resolve()),
            handleGracefulStop: jest.fn()
        })).rejects.toThrow('Resume blocked: missing frozen campaign snapshot');

        // No unrelated model load was attempted
        expect(mockLoadOrResolveCampaignInferenceContracts).not.toHaveBeenCalled();

        // Metadata failure happens before any claim, pin or model side effect.
        expect(mockClaimHostForBenchmark).not.toHaveBeenCalled();
        expect(mockDetectDedication).not.toHaveBeenCalled();
        expect(mockWarmupModel).not.toHaveBeenCalled();
        expect(recordBatchTimelineEvent).toHaveBeenCalledWith(
            'inference_contract_resume_blocked',
            expect.objectContaining({
                code: 'MISSING_OR_INCOMPATIBLE_CAMPAIGN',
                reload_required: true
            })
        );
        expect(mockUpdateOne).toHaveBeenCalledWith(
            { _id: 'batch-resume-drift' },
            expect.objectContaining({
                $set: expect.objectContaining({
                    'checkpoint.resume_decision': 'blocked',
                    'checkpoint.reload_required': true
                })
            })
        );
    });

    it('keeps the judge host claimed when every model prompt is already checkpointed', async () => {
        mockDrain.mockResolvedValue({ completed: 1, failed: 0, timedOut: false });
        setResumeCheckpoint({
            completedPairs: ['model-a::Prompt 1', 'model-a::Prompt 2'],
            lastModel: 'model-a',
            lastPrompt: 'Prompt 2'
        });
        const recordBatchTimelineEvent = jest.fn(() => Promise.resolve());

        await runBatchOrchestrator({
            batchId: 'batch-resume-judge-only',
            defaultHost: 'http://exec:11434',
            models: ['model-a'],
            prompts: [
                { _id: 'prompt-1', name: 'Prompt 1', prompt: 'Say hello', level: 1, category: 'reasoning' },
                { _id: 'prompt-2', name: 'Prompt 2', prompt: 'Say world', level: 1, category: 'reasoning' }
            ],
            judgeConfig: { model: 'judge-1', concurrency: 2 },
            executionConfig: {
                per_test_timeout_ms: 60_000,
                judge_drain_timeout_ms: 120_000,
                judge_stall_timeout_ms: 30_000
            },
            executionMode: 'throughput',
            getModelExecutionConfig: jest.fn(async () => ({ per_test_timeout_ms: 60_000 })),
            recordBatchTimelineEvent,
            queueBatchProgress: jest.fn(),
            flushBatchProgress: jest.fn(() => Promise.resolve()),
            handleGracefulStop: jest.fn()
        });

        expect(mockClaimHostForBenchmark).toHaveBeenCalledWith(
            'http://exec:11434',
            'batch-resume-judge-only',
            expect.any(Number),
            expect.any(Object)
        );
        expect(mockWarmupModel).not.toHaveBeenCalled();
        expect(mockGetBenchmarkClaims).not.toHaveBeenCalled();
        expect(recordBatchTimelineEvent).toHaveBeenCalledWith(
            'inference_contract_resumed',
            expect.objectContaining({ model: null, pending_model_count: 0 })
        );
    });

    it('fails closed on resume when host claim is stale', async () => {
        mockDrain.mockResolvedValue({ completed: 1, failed: 0, timedOut: false });
        // No active claim for this host
        mockGetBenchmarkClaims.mockResolvedValue([]);

        const currentBatchDoc = { completed: 1 };
        let findByIdCall = 0;
        mockFindById.mockImplementation(() => {
            findByIdCall += 1;
            if (findByIdCall === 1) {
                return {
                    select: jest.fn().mockReturnValue({
                        lean: jest.fn().mockResolvedValue({
                            checkpoint: {
                                completed_pairs: ['model-a::Prompt 1'],
                                last_model: 'model-a',
                                last_prompt: 'Prompt 1'
                            }
                        })
                    })
                };
            }
            if (findByIdCall === 2) {
                return Promise.resolve(currentBatchDoc);
            }
            return {
                select: jest.fn().mockReturnValue({
                    lean: jest.fn().mockResolvedValue({ status: 'running' })
                })
            };
        });

        const recordBatchTimelineEvent = jest.fn(() => Promise.resolve());

        await expect(runBatchOrchestrator({
            batchId: 'batch-resume-stale-claim',
            defaultHost: 'http://exec:11434',
            models: ['model-a'],
            prompts: [
                { _id: 'prompt-1', name: 'Prompt 1', prompt: 'Say hello', level: 1, category: 'reasoning' },
                { _id: 'prompt-2', name: 'Prompt 2', prompt: 'Say world', level: 1, category: 'reasoning' }
            ],
            judgeConfig: { model: 'judge-1', concurrency: 2 },
            executionConfig: {
                per_test_timeout_ms: 60_000,
                judge_drain_timeout_ms: 120_000,
                judge_stall_timeout_ms: 30_000
            },
            executionMode: 'throughput',
            getModelExecutionConfig: jest.fn(async () => ({ per_test_timeout_ms: 60_000 })),
            recordBatchTimelineEvent,
            queueBatchProgress: jest.fn(),
            flushBatchProgress: jest.fn(() => Promise.resolve()),
            handleGracefulStop: jest.fn()
        })).rejects.toThrow('Resume blocked: host claim lost for model-a on http://exec:11434');

        // Claims and pins are still cleaned up despite the stale claim
        expect(mockReleaseBenchmarkClaim).toHaveBeenCalledWith('http://exec:11434', 'batch-resume-stale-claim');
        expect(mockRestoreAllDedication).toHaveBeenCalledTimes(1);
        expect(recordBatchTimelineEvent).toHaveBeenCalledWith(
            'inference_contract_resume_blocked',
            expect.objectContaining({
                code: 'STALE_HOST_CLAIM',
                model: 'model-a',
                reload_required: true
            })
        );
    });

    it('fails closed before claims or model loads when pin detection fails on resume', async () => {
        mockDrain.mockResolvedValue({ completed: 1, failed: 0, timedOut: false });
        mockDetectDedication.mockRejectedValue(
            Object.assign(new Error('pin registry unavailable'), { code: 'PIN_DETECTION_FAILED' })
        );
        setResumeCheckpoint({
            completedPairs: ['model-a::Prompt 1'],
            lastModel: 'model-a',
            lastPrompt: 'Prompt 1'
        });

        const recordBatchTimelineEvent = jest.fn(() => Promise.resolve());

        await expect(runBatchOrchestrator({
            batchId: 'batch-resume-pin-detection',
            defaultHost: 'http://exec:11434',
            models: ['model-a'],
            prompts: [
                { _id: 'prompt-1', name: 'Prompt 1', prompt: 'Say hello', level: 1, category: 'reasoning' },
                { _id: 'prompt-2', name: 'Prompt 2', prompt: 'Say world', level: 1, category: 'reasoning' }
            ],
            judgeConfig: { model: 'judge-1', concurrency: 2 },
            executionConfig: {
                per_test_timeout_ms: 60_000,
                judge_drain_timeout_ms: 120_000,
                judge_stall_timeout_ms: 30_000
            },
            executionMode: 'throughput',
            getModelExecutionConfig: jest.fn(async () => ({ per_test_timeout_ms: 60_000 })),
            recordBatchTimelineEvent,
            queueBatchProgress: jest.fn(),
            flushBatchProgress: jest.fn(() => Promise.resolve()),
            handleGracefulStop: jest.fn()
        })).rejects.toThrow('pin registry unavailable');

        expect(mockClaimHostForBenchmark).not.toHaveBeenCalled();
        expect(mockReleaseAllDedication).not.toHaveBeenCalled();
        expect(mockWarmupModel).not.toHaveBeenCalled();
        expect(recordBatchTimelineEvent).toHaveBeenCalledWith(
            'inference_contract_resume_blocked',
            expect.objectContaining({
                code: 'PIN_DETECTION_FAILED',
                reload_required: true
            })
        );
    });

    it('fails closed on pin release and still restores pins and releases claims', async () => {
        mockDrain.mockResolvedValue({ completed: 1, failed: 0, timedOut: false });
        mockReleaseAllDedication.mockRejectedValue(Object.assign(new Error('pin unload failed'), {
            code: 'PIN_RELEASE_FAILED',
            resumeContext: { host: 'http://exec:11434', model: 'pinned-model' }
        }));
        setResumeCheckpoint({
            completedPairs: ['model-a::Prompt 1'],
            lastModel: 'model-a',
            lastPrompt: 'Prompt 1'
        });
        const recordBatchTimelineEvent = jest.fn(() => Promise.resolve());

        await expect(runBatchOrchestrator({
            batchId: 'batch-resume-pin-release',
            defaultHost: 'http://exec:11434',
            models: ['model-a'],
            prompts: [
                { _id: 'prompt-1', name: 'Prompt 1', prompt: 'Say hello', level: 1, category: 'reasoning' },
                { _id: 'prompt-2', name: 'Prompt 2', prompt: 'Say world', level: 1, category: 'reasoning' }
            ],
            judgeConfig: { model: 'judge-1', concurrency: 2 },
            executionConfig: {
                per_test_timeout_ms: 60_000,
                judge_drain_timeout_ms: 120_000,
                judge_stall_timeout_ms: 30_000
            },
            executionMode: 'throughput',
            getModelExecutionConfig: jest.fn(async () => ({ per_test_timeout_ms: 60_000 })),
            recordBatchTimelineEvent,
            queueBatchProgress: jest.fn(),
            flushBatchProgress: jest.fn(() => Promise.resolve()),
            handleGracefulStop: jest.fn()
        })).rejects.toThrow('pin unload failed');

        expect(mockReleaseAllDedication).toHaveBeenCalledTimes(1);
        expect(mockWarmupModel).not.toHaveBeenCalled();
        expect(mockReleaseBenchmarkClaim).toHaveBeenCalledWith(
            'http://exec:11434',
            'batch-resume-pin-release'
        );
        expect(mockRestoreAllDedication).toHaveBeenCalledTimes(1);
        expect(recordBatchTimelineEvent).toHaveBeenCalledWith(
            'inference_contract_resume_blocked',
            expect.objectContaining({
                code: 'PIN_RELEASE_FAILED',
                model: 'pinned-model',
                reload_required: true
            })
        );
    });
});
