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
const mockAcquireWorkloadAdmission = jest.fn();
const mockHeartbeatWorkloadAdmission = jest.fn();
const mockReleaseWorkloadAdmission = jest.fn();
const mockGetBenchmarkClaims = jest.fn();
const mockGetBenchmarkClaimIdentity = jest.fn();
jest.mock('../../../src/clients/coreApiClient', () => ({
    acquireWorkloadAdmission: (...args) => mockAcquireWorkloadAdmission(...args),
    heartbeatWorkloadAdmission: (...args) => mockHeartbeatWorkloadAdmission(...args),
    releaseWorkloadAdmission: (...args) => mockReleaseWorkloadAdmission(...args),
    claimHostForBenchmark: (...args) => mockClaimHostForBenchmark(...args),
    heartbeatBenchmarkClaim: (...args) => mockHeartbeatBenchmarkClaim(...args),
    releaseBenchmarkClaim: (...args) => mockReleaseBenchmarkClaim(...args),
    getBenchmarkClaims: (...args) => mockGetBenchmarkClaims(...args),
    getBenchmarkClaimIdentity: (...args) => mockGetBenchmarkClaimIdentity(...args),
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
        return normalized ? [normalized] : [];
    })
}));

jest.mock('../../../src/services/profiler/artifactIdentityService', () => ({
    identitiesMatch: jest.fn((left, right) => Boolean(
        left && right
        && left.model === right.model
        && left.hostId === right.hostId
        && left.hostUrl === right.hostUrl
        && left.digest === right.digest
        && left.runtimeFingerprint === right.runtimeFingerprint
        && right.registryQualified === true
    )),
    resolveArtifactIdentity: jest.fn(async (model, hostId, hostUrl) => ({
        model,
        hostId,
        hostUrl,
        digest: 'sha256:exact',
        runtimeFingerprint: 'runtime-a',
        registryQualified: true
    }))
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

const mockExecuteHarnessTarget = jest.fn();
const mockResolveHarnessTarget = jest.fn();
jest.mock('../../../src/services/benchmark/harnessBrokerClient', () => ({
    executeHarnessTarget: (...args) => mockExecuteHarnessTarget(...args),
    resolveHarnessTarget: (...args) => mockResolveHarnessTarget(...args)
}));

jest.mock('../../../src/services/benchmark/errorClassifier', () => ({
    classifyBenchmarkError: jest.fn(() => ({ infra: false }))
}));

jest.mock('../../../src/helpers/ollamaResponseHandler', () => ({
    extractThinkingBlocks: jest.fn((text) => ({ content: text, thinking: null }))
}));

const mockJudgeResult = jest.fn();
jest.mock('../../../src/services/benchmark/judging', () => ({
    judgeResult: (...args) => mockJudgeResult(...args)
}));

jest.mock('../../../src/services/qualityScorer', () => ({
    JUDGE_CONFIG: { model: 'judge-default' }
}));

const mockCountDocuments = jest.fn();
jest.mock('../../../models/BenchmarkResult', () => ({
    countDocuments: (...args) => mockCountDocuments(...args)
}));

const mockFindOnePerformanceProfile = jest.fn();
jest.mock('../../../models/ModelPerformanceProfile', () => ({
    findOne: (...args) => mockFindOnePerformanceProfile(...args)
}));

const mockFindOneModelProfile = jest.fn();
jest.mock('../../../models/ModelProfile', () => ({
    findOne: (...args) => mockFindOneModelProfile(...args)
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
    updateOne: jest.fn(() => Promise.resolve()),
    updateMany: jest.fn(() => Promise.resolve())
}));

const mockWaitForCapacity = jest.fn();
const mockAdd = jest.fn();
const mockGetStatus = jest.fn();
const mockDrain = jest.fn();
const mockCancel = jest.fn();
jest.mock('../../../src/services/benchmark/ConcurrencyQueue', () => jest.fn().mockImplementation(() => ({
    waitForCapacity: (...args) => mockWaitForCapacity(...args),
    add: (...args) => mockAdd(...args),
    getStatus: (...args) => mockGetStatus(...args),
    drain: (...args) => mockDrain(...args),
    cancel: (...args) => mockCancel(...args),
    get cancelled() { return mockCancel.mock.calls.length > 0; }
})));

const {
    runBatchOrchestrator,
    abortActiveBatchRequests,
    _getActiveBatchRequestCount: getActiveBatchRequestCount
} = require('../../../src/services/benchmark/batchOrchestrator');
const { estimateBenchmarkClaimDurationMs } = require('../../../src/services/benchmark/benchmarkClaimLifecycle');
const ollamaHostConfig = require('../../../src/helpers/ollamaHostConfig');
const { createProfilerAuthorityReceipt } = require('../../../src/services/profiler/profilerAuthorityReceipt');

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

function setRunnableBatchLookup() {
    const currentBatch = {
        completed: 0,
        select: jest.fn().mockReturnValue({
            lean: jest.fn().mockResolvedValue({ status: 'running' })
        })
    };
    let firstLookup = true;
    mockFindById.mockImplementation(() => {
        if (firstLookup) {
            firstLookup = false;
            return {
                select: jest.fn().mockReturnValue({
                    lean: jest.fn().mockResolvedValue({ checkpoint: { completed_pairs: [] } })
                })
            };
        }
        return currentBatch;
    });
}

describe('runBatchOrchestrator claim lifecycle', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        ollamaHostConfig.getConfiguredHosts.mockReturnValue([
            { id: 'primary', url: 'http://exec:11434' }
        ]);

        mockPreflight.mockResolvedValue({
            profilesNeeded: [],
            adaptsNeeded: [],
            warnings: []
        });
        mockRunPreflight.mockResolvedValue(undefined);
        mockClaimHostForBenchmark.mockResolvedValue({ claimed: true });
        mockAcquireWorkloadAdmission.mockResolvedValue({ acquired: true });
        mockHeartbeatWorkloadAdmission.mockResolvedValue({ heartbeat: true });
        mockReleaseWorkloadAdmission.mockResolvedValue({ released: true });
        mockHeartbeatBenchmarkClaim.mockResolvedValue({ heartbeat: true });
        mockGetBenchmarkClaimIdentity.mockImplementation((_host, batchId) => ({
            claimBatchId: String(batchId),
            claimGeneration: 'generation-1'
        }));
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
        const urlByHostId = {
            primary: 'http://exec:11434',
            'exec-a': 'http://exec-a:11434',
            'exec-b': 'http://exec-b:11434',
            judge: 'http://judge:11434'
        };
        const evidenceIdFor = (model, hostId) => `evidence-${model}-${hostId}`;
        const artifactFor = (model, hostId) => ({
            model,
            hostId,
            hostUrl: urlByHostId[hostId] || `http://${hostId}:11434`,
            digest: 'sha256:exact',
            runtimeFingerprint: 'runtime-a',
            registryQualified: true
        });
        const profileFor = () => ({
            tokensPerSec: 123.4,
            promptEvalTokensPerSec: 456.7,
            ttftMs: 321,
            ttftMeasurement: 'streamed_wall_clock',
            profileDepth: 'standard',
            requiredRetainedSamples: 5,
            measurementQuality: { reliability: 'medium', passingSampleCount: 5 },
            recommendedInteractiveContext: 4096,
            vramUsedMiB: 8192,
            profiledAt: new Date('2026-09-04T12:00:00.000Z')
        });
        mockFindOnePerformanceProfile.mockImplementation((query) => ({
            select: jest.fn().mockReturnValue({
                lean: jest.fn().mockResolvedValue((() => {
                    const evidenceId = evidenceIdFor(query.modelName, query.hostId);
                    return {
                        _id: evidenceId,
                        modelName: query.modelName,
                        hostId: query.hostId,
                        artifact: artifactFor(query.modelName, query.hostId),
                        profile: profileFor()
                    };
                })())
            })
        }));
        mockFindOneModelProfile.mockImplementation((query) => ({
            select: jest.fn().mockReturnValue({
                lean: jest.fn().mockResolvedValue({
                    readiness: Object.fromEntries(Object.keys(urlByHostId).map((hostId) => {
                        const evidenceId = evidenceIdFor(query.name, hostId);
                        return [hostId, {
                            evidenceId,
                            benchmarkQualified: true,
                            stale: false,
                            profileDepth: 'standard',
                            artifact: artifactFor(query.name, hostId),
                            authorityReceipt: createProfilerAuthorityReceipt({
                                modelName: query.name,
                                hostId,
                                artifact: artifactFor(query.name, hostId),
                                profile: profileFor(),
                                evidenceId
                            })
                        }];
                    }))
                })
            })
        }));
        mockTestModelOnHost.mockResolvedValue({ status: 'ok', testedAt: new Date('2026-04-19T18:00:00Z') });
        mockToPerformanceBaseline.mockReturnValue({ baseline: true });
        mockGroupModelsByHost.mockImplementation((defaultHost, models) => ({
            [defaultHost]: models
        }));
        mockCreateCurrentTestPersistenceStrategy.mockReturnValue(() => false);
        mockPersistSuccessfulResult.mockResolvedValue('result-1');
        mockPersistFailedResult.mockResolvedValue(undefined);
        mockResolveHarnessTarget.mockImplementation(async (target) => target);
        mockExecuteHarnessTarget.mockResolvedValue({
            output: 'cloud answer', thinking: null, finishReason: 'stop',
            publicReceipt: { fingerprint: 'r'.repeat(64) },
            receipt: {
                usage: { durationMs: 20, inputTokens: 4, outputTokens: 3, totalTokens: 7, costNanodollars: 0 },
                identity: { model: { digest: null } }
            }
        });
        mockJudgeResult.mockResolvedValue({ quality_score: 8 });
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
            expectedEstimateMs,
            { source: 'benchmark', owner: 'agentx-benchmark' }
        );

        releaseDrain.resolve();
        await runPromise;

        expect(mockRestoreAllDedication).not.toHaveBeenCalled();
        expect(mockReleaseBenchmarkClaim).toHaveBeenCalledWith(
            'http://exec:11434',
            'batch-judge-phase'
        );
        expect(recordBatchTimelineEvent).toHaveBeenCalledWith('benchmark_claim_released', {
            hosts: ['http://exec:11434']
        });
    });

    it('cancels and settles an active pipelined judge before releasing host lifecycle', async () => {
        const judgeStarted = deferred();
        const finishJudge = deferred();
        const stalledBodyStarted = deferred();
        let activeJudgePromise = null;

        mockGroupModelsByHost.mockReturnValue({
            'http://exec-a:11434': ['model-a'],
            'http://exec-b:11434': ['model-b']
        });
        ollamaHostConfig.getConfiguredHosts.mockReturnValue([
            { id: 'exec-a', url: 'http://exec-a:11434' },
            { id: 'exec-b', url: 'http://exec-b:11434' },
            { id: 'judge', url: 'http://judge:11434' }
        ]);
        mockResolveJudgeHost.mockReturnValue({
            judgeHost: 'http://judge:11434',
            resolution: 'explicit'
        });
        mockJudgeResult.mockImplementation(async () => {
            judgeStarted.resolve();
            return finishJudge.promise;
        });
        mockAdd.mockImplementation((task) => {
            activeJudgePromise = Promise.resolve().then(task);
            return activeJudgePromise;
        });
        mockDrain.mockImplementation(async () => {
            if (activeJudgePromise) await Promise.allSettled([activeJudgePromise]);
            return { completed: 0, failed: 0, timedOut: false, cancelled: true };
        });
        mockBenchmarkFetch.mockImplementation(async (_url, options) => {
            const payload = JSON.parse(options.body);
            if (payload.model === 'model-b') {
                return {
                    ok: true,
                    json: () => new Promise((_resolve, reject) => {
                        const onAbort = () => reject(
                            options.signal.reason || Object.assign(new Error('aborted'), { name: 'AbortError' })
                        );
                        if (options.signal.aborted) onAbort();
                        else options.signal.addEventListener('abort', onAbort, { once: true });
                        stalledBodyStarted.resolve();
                    })
                };
            }
            return {
                ok: true,
                json: async () => ({
                    message: { content: 'judge me' },
                    eval_count: 12,
                    prompt_eval_duration: 1_000_000,
                    done_reason: 'stop'
                })
            };
        });

        const runPromise = runBatchOrchestrator({
            batchId: 'batch-active-judge-cancel',
            defaultHost: 'http://exec-a:11434',
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
            recordBatchTimelineEvent: jest.fn(() => Promise.resolve()),
            queueBatchProgress: jest.fn(),
            flushBatchProgress: jest.fn(() => Promise.resolve()),
            setBatchPhase: jest.fn(() => Promise.resolve()),
            handleGracefulStop: jest.fn()
        });

        await Promise.all([judgeStarted.promise, stalledBodyStarted.promise]);
        expect(abortActiveBatchRequests('batch-active-judge-cancel')).toMatchObject({
            activeRequestCount: 2,
            abortedRequestCount: 2
        });

        await new Promise(resolve => setImmediate(resolve));
        expect(mockCancel).toHaveBeenCalled();
        expect(mockDrain).toHaveBeenCalledTimes(1);
        expect(mockReleaseBenchmarkClaim).not.toHaveBeenCalled();
        expect(mockRestoreAllDedication).not.toHaveBeenCalled();

        finishJudge.resolve({ quality_score: 8 });
        await expect(runPromise).resolves.toEqual({ stopped: true, cancelled: true });

        expect(mockReleaseBenchmarkClaim).toHaveBeenCalledTimes(3);
        expect(mockRestoreAllDedication).not.toHaveBeenCalled();
        const judgeCounterWrites = mockUpdateOne.mock.calls.filter(([, update]) => (
            update?.$inc?.judge_completed
        ));
        expect(judgeCounterWrites).toHaveLength(0);
        const JudgeQueueEntry = require('../../../models/JudgeQueueEntry');
        expect(JudgeQueueEntry.updateMany).toHaveBeenCalledWith(
            {
                batchId: 'batch-active-judge-cancel',
                status: { $in: ['pending', 'running'] }
            },
            expect.objectContaining({
                $set: expect.objectContaining({
                    status: 'cancelled',
                    error: 'BENCHMARK_BATCH_STOPPED'
                })
            })
        );
        expect(getActiveBatchRequestCount('batch-active-judge-cancel')).toBe(0);
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

    it('reuses exact-artifact profile baseline instead of running host test again', async () => {
        mockDrain.mockResolvedValue({ completed: 1, failed: 0, timedOut: false });

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
                source: 'exact_artifact_profile',
                tokensPerSec: 123.4,
                numCtx: 4096
            })
        );
    });

    it('refuses an incompatible execution context instead of inventing a live baseline', async () => {
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

        expect(mockTestModelOnHost).not.toHaveBeenCalled();
        expect(mockPersistSuccessfulResult).not.toHaveBeenCalled();
    });

    it('omits all thinking controls when the frozen campaign mode is native', async () => {
        mockDrain.mockResolvedValue({ completed: 1, failed: 0, timedOut: false });
        mockGetFrozenModelExecutionConfig.mockImplementation((_, __, ___, baseConfig) => ({
            ...baseConfig,
            response_max_tokens: 2048,
            num_ctx: 4096,
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
        expect(requestBody.options).toMatchObject({ num_ctx: 4096, num_predict: 2048 });
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
        expect(mockReleaseBenchmarkClaim).toHaveBeenCalledWith(
            'http://exec:11434',
            'batch-resume-stale-claim'
        );
        expect(mockRestoreAllDedication).not.toHaveBeenCalled();
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
        expect(mockRestoreAllDedication).not.toHaveBeenCalled();
        expect(recordBatchTimelineEvent).toHaveBeenCalledWith(
            'inference_contract_resume_blocked',
            expect.objectContaining({
                code: 'PIN_RELEASE_FAILED',
                model: 'pinned-model',
                reload_required: true
            })
        );
    });

    it('cancels a stalled response body without persisting, judging, checkpointing, or recovering', async () => {
        const bodyStarted = deferred();
        let requestSignal;
        setRunnableBatchLookup();
        mockDrain.mockResolvedValue({ completed: 0, failed: 0, timedOut: false });
        mockBenchmarkFetch.mockImplementation(async (_url, options) => {
            requestSignal = options.signal;
            return {
                ok: true,
                json: () => new Promise((resolve, reject) => {
                    const rejectOnAbort = () => reject(
                        requestSignal.reason || Object.assign(new Error('aborted'), { name: 'AbortError' })
                    );
                    if (requestSignal.aborted) rejectOnAbort();
                    else requestSignal.addEventListener('abort', rejectOnAbort, { once: true });
                    bodyStarted.resolve();
                })
            };
        });

        const handleGracefulStop = jest.fn();
        const runPromise = runBatchOrchestrator({
            batchId: 'batch-cancel-body',
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
            recordBatchTimelineEvent: jest.fn(() => Promise.resolve()),
            queueBatchProgress: jest.fn(),
            flushBatchProgress: jest.fn(() => Promise.resolve()),
            setBatchPhase: jest.fn(() => Promise.resolve()),
            handleGracefulStop
        });

        await bodyStarted.promise;
        // One batch-lifecycle controller plus the active response-body request.
        expect(getActiveBatchRequestCount('batch-cancel-body')).toBe(2);
        expect(requestSignal.aborted).toBe(false);

        expect(abortActiveBatchRequests('batch-cancel-body')).toMatchObject({
            activeRequestCount: 2,
            abortedRequestCount: 2
        });
        expect(abortActiveBatchRequests('batch-cancel-body')).toMatchObject({
            activeRequestCount: 2,
            abortedRequestCount: 0
        });

        await expect(runPromise).resolves.toEqual({ stopped: true, cancelled: true });

        expect(mockBenchmarkFetch).toHaveBeenCalledTimes(1);
        expect(mockPersistSuccessfulResult).not.toHaveBeenCalled();
        expect(mockPersistFailedResult).not.toHaveBeenCalled();
        expect(mockAdd).not.toHaveBeenCalled();
        expect(mockDrain).toHaveBeenCalledTimes(1);
        expect(mockUpdateOne.mock.calls.some(([, update]) => (
            update?.$addToSet?.['checkpoint.completed_pairs']
        ))).toBe(false);
        expect(mockWarmupModel).toHaveBeenCalledTimes(1);
        expect(handleGracefulStop).toHaveBeenCalled();
        expect(mockReleaseBenchmarkClaim).toHaveBeenCalledWith(
            'http://exec:11434',
            'batch-cancel-body'
        );
        expect(mockRestoreAllDedication).not.toHaveBeenCalled();
        expect(getActiveBatchRequestCount('batch-cancel-body')).toBe(0);
    });

    it('does not checkpoint or start another prompt when stop lands during judge enqueue', async () => {
        setRunnableBatchLookup();
        mockResolveJudgeHost.mockReturnValue({
            judgeHost: 'http://judge:11434',
            resolution: 'explicit'
        });
        mockDrain.mockResolvedValue({ completed: 0, failed: 0, timedOut: false, cancelled: true });
        mockAdd.mockImplementation(() => {
            expect(abortActiveBatchRequests('batch-cancel-after-persist')).toMatchObject({
                activeRequestCount: 1,
                abortedRequestCount: 1
            });
            return Promise.resolve();
        });

        const handleGracefulStop = jest.fn();
        await expect(runBatchOrchestrator({
            batchId: 'batch-cancel-after-persist',
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
            recordBatchTimelineEvent: jest.fn(() => Promise.resolve()),
            queueBatchProgress: jest.fn(),
            flushBatchProgress: jest.fn(() => Promise.resolve()),
            setBatchPhase: jest.fn(() => Promise.resolve()),
            handleGracefulStop
        })).resolves.toEqual({ stopped: true, cancelled: true });

        expect(mockPersistSuccessfulResult).toHaveBeenCalledTimes(1);
        expect(mockBenchmarkFetch).toHaveBeenCalledTimes(1);
        expect(mockUpdateOne.mock.calls.some(([, update]) => (
            update?.$addToSet?.['checkpoint.completed_pairs']
        ))).toBe(false);
        expect(handleGracefulStop).toHaveBeenCalled();
        expect(getActiveBatchRequestCount('batch-cancel-after-persist')).toBe(0);
    });

    it('keeps the per-test timeout active while a response body is stalled', async () => {
        const bodyStarted = deferred();
        let requestSignal;
        setRunnableBatchLookup();
        mockDrain.mockResolvedValue({ completed: 0, failed: 0, timedOut: false });
        mockBenchmarkFetch.mockImplementation(async (_url, options) => {
            requestSignal = options.signal;
            return {
                ok: true,
                json: () => new Promise((resolve, reject) => {
                    requestSignal.addEventListener('abort', () => {
                        reject(Object.assign(new Error('request timed out'), { name: 'AbortError' }));
                    }, { once: true });
                    bodyStarted.resolve();
                })
            };
        });

        const runPromise = runBatchOrchestrator({
            batchId: 'batch-timeout-body',
            defaultHost: 'http://exec:11434',
            models: ['model-a'],
            prompts: [
                { _id: 'prompt-1', name: 'Prompt 1', prompt: 'Say hello', level: 1, category: 'reasoning' }
            ],
            judgeConfig: { model: 'judge-1', concurrency: 2 },
            executionConfig: {
                per_test_timeout_ms: 25,
                judge_drain_timeout_ms: 120_000,
                judge_stall_timeout_ms: 30_000
            },
            executionMode: 'throughput',
            recordBatchTimelineEvent: jest.fn(() => Promise.resolve()),
            queueBatchProgress: jest.fn(),
            flushBatchProgress: jest.fn(() => Promise.resolve()),
            setBatchPhase: jest.fn(() => Promise.resolve()),
            handleGracefulStop: jest.fn()
        });

        await bodyStarted.promise;
        expect(getActiveBatchRequestCount('batch-timeout-body')).toBe(2);
        await expect(runPromise).resolves.toEqual({ stopped: false, cancelled: false });

        expect(requestSignal.aborted).toBe(true);
        expect(mockPersistSuccessfulResult).not.toHaveBeenCalled();
        expect(mockPersistFailedResult).toHaveBeenCalledTimes(1);
        expect(getActiveBatchRequestCount('batch-timeout-body')).toBe(0);
    });

    it('runs a mixed Ollama and harness batch while claiming only local hosts', async () => {
        const { buildOllamaTarget, normalizeBenchmarkTarget } = require('../../../../shared/benchmarkTargetContract');
        const local = buildOllamaTarget('http://exec:11434', 'model-local');
        const cloud = normalizeBenchmarkTarget({
            id: 'openclaw-cloud', label: 'Cloud model', executionKind: 'harness', mode: 'isolated_model', tier: 'free_cloud',
            provider: 'openrouter', model: 'vendor/model', modelVersion: 'v1',
            harness: { name: 'openclaw', version: '2026.8.1' }, adapter: { name: 'openclaw-benchmark', version: '1.0.0' },
            profile: { id: 'isolated', version: '1', fingerprint: '1'.repeat(64) },
            api: { name: 'openclaw-agent-cli', version: '2026.8.1' }, contextWindow: 128000,
            capabilities: { candidate: true, judge: true },
            pricing: { kind: 'free', currency: 'USD', source: 'fixture', effectiveAt: null, inputNanodollarsPerMillion: 0, outputNanodollarsPerMillion: 0, callNanodollars: 0 },
            available: true, observedAt: '2026-08-31T00:00:00.000Z', catalogFingerprint: 'a'.repeat(64)
        });
        mockResolveJudgeHost.mockReturnValue({ judgeHost: 'http://exec:11434', resolution: 'explicit' });

        await expect(runBatchOrchestrator({
            batchId: 'batch-mixed', defaultHost: local.host, models: [local.model, cloud.model], targets: [local, cloud],
            prompts: [{ _id: 'prompt-1', name: 'Prompt 1', prompt: 'Say hello', level: 1, category: 'reasoning' }],
            judgeConfig: { host: local.host, model: 'judge-1', concurrency: 2 },
            executionConfig: {
                per_test_timeout_ms: 60_000,
                judge_drain_timeout_ms: 120_000,
                judge_stall_timeout_ms: 30_000,
                think: true,
                think_mode: 'explicit_thinking'
            },
            executionMode: 'throughput', recordBatchTimelineEvent: jest.fn(() => Promise.resolve()),
            queueBatchProgress: jest.fn(), flushBatchProgress: jest.fn(() => Promise.resolve()),
            setBatchPhase: jest.fn(() => Promise.resolve()), handleGracefulStop: jest.fn(),
            qualityCohortFingerprint: 'c'.repeat(64), batchContractFingerprint: 'd'.repeat(64)
        })).resolves.toEqual({ stopped: false, cancelled: false });

        expect(mockBenchmarkFetch).toHaveBeenCalledTimes(1);
        expect(mockExecuteHarnessTarget).toHaveBeenCalledTimes(1);
        expect(mockExecuteHarnessTarget).toHaveBeenCalledWith(expect.objectContaining({
            parameters: expect.objectContaining({ thinking: true })
        }));
        expect(mockPersistSuccessfulResult).toHaveBeenCalledTimes(2);
        expect(mockPersistSuccessfulResult).toHaveBeenCalledWith(expect.objectContaining({
            executionTarget: expect.objectContaining({ executionKind: 'harness' }),
            executionSettings: expect.objectContaining({ think: true, think_mode: 'explicit_thinking' })
        }));
        expect(mockPersistSuccessfulResult.mock.calls.map(([args]) => args.executionTarget.executionKind).sort())
            .toEqual(['harness', 'ollama']);
        expect(mockClaimHostForBenchmark.mock.calls.flatMap(([hosts]) => hosts)).not.toContain('harness:openclaw');
    });
});
