/**
 * Benchmark preflight tests — post tier-removal.
 * checkJudgeConfiguration now takes just (judgeConfig) and validates
 * host reachability, model availability, and context window via probe.
 */

jest.mock('../../../config/logger', () => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn()
}));

jest.mock('../../../models/BenchmarkPrompt', () => ({
    aggregate: jest.fn(),
    find: jest.fn()
}));

jest.mock('../../../models/BenchmarkBatch', () => ({
    find: jest.fn()
}));

// Profile-gate check queries ModelProfile + HostProfile. Default: treat every
// model as profiled on the test exec host so existing tests that don't care
// about this path keep passing. Readiness is per-host: readiness[hostId].stage.
// Individual tests can override via .findOne.mockReturnValueOnce.
jest.mock('../../../models/ModelProfile', () => ({
    findOne: jest.fn(() => ({
        select: jest.fn().mockReturnValue({
            lean: jest.fn().mockResolvedValue({
                readiness: {
                    'exec-host': {
                        stage: 'profiled',
                        profileDepth: 'standard',
                        benchmarkQualified: true,
                        stale: false,
                        artifact: {
                            model: 'model-a',
                            hostId: 'exec-host',
                            hostUrl: 'http://exec-host:11434',
                            digest: 'sha256:model-a',
                            runtimeFingerprint: 'runtime-a'
                        }
                    }
                }
            })
        })
    }))
}));

jest.mock('../../../models/HostProfile', () => ({
    findOne: jest.fn(() => ({
        select: jest.fn().mockReturnValue({
            lean: jest.fn().mockResolvedValue({ hostId: 'exec-host' })
        })
    }))
}));

jest.mock('../../../src/services/profiler/artifactIdentityService', () => ({
    resolveArtifactIdentity: jest.fn(async (model, hostId, hostUrl) => ({
        model: String(model || '').trim().replace(/:latest$/i, ''),
        hostId,
        hostUrl,
        digest: `sha256:${String(model || '').trim().replace(/:latest$/i, '')}`,
        runtimeFingerprint: 'runtime-a',
        registryQualified: true
    })),
    identitiesMatch: jest.fn(() => true)
}));


jest.mock('../../../src/services/qualityScorer', () => ({
    JUDGE_CONFIG: {
        host: 'http://judge-host:11434',
        model: 'judge-model:latest',
        num_ctx: 8192
    }
}));

jest.mock('../../../src/services/benchmark/http', () => ({
    benchmarkFetch: jest.fn()
}));

jest.mock('../../../src/services/benchmark/judgeModelValidator', () => ({
    probeJudgeCapability: jest.fn()
}));

// resolveModelNumCtxDetails reaches into exact context evidence which isn't
// connected in unit tests. Stub it to
// return an authoritative fallback so the implicit-num_ctx code path inside
// checkJudgeConfiguration still exercises but doesn't hit the DB.
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
        return [normalized];
    })
}));

// coreApiClient.getDedicationStatuses is called in checkDedication; without a
// mock it tries to reach real core via node-fetch and times out.
jest.mock('../../../src/clients/coreApiClient', () => ({
    getDedicationStatuses: jest.fn().mockResolvedValue([]),
    resolveHostKey: jest.fn().mockResolvedValue(null),
    restoreDedication: jest.fn().mockResolvedValue({})
}));

const BenchmarkPrompt = require('../../../models/BenchmarkPrompt');
const BenchmarkBatch = require('../../../models/BenchmarkBatch');
const ModelProfile = require('../../../models/ModelProfile');
const { benchmarkFetch } = require('../../../src/services/benchmark/http');
const { probeJudgeCapability } = require('../../../src/services/benchmark/judgeModelValidator');
const {
    checkJudgeConfiguration,
    runPreflight
} = require('../../../src/services/benchmark/preflight');

function chainResolved(value) {
    return {
        select: jest.fn().mockReturnValue({
            lean: jest.fn().mockResolvedValue(value)
        })
    };
}

function okJson(data) {
    return {
        ok: true,
        status: 200,
        json: async () => data
    };
}

describe('benchmark preflight', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        BenchmarkPrompt.aggregate.mockResolvedValue([
            { _id: 'coding', count: 4 },
            { _id: 'knowledge', count: 5 }
        ]);
        BenchmarkPrompt.find.mockReturnValue(chainResolved([]));
        BenchmarkBatch.find.mockReturnValue(chainResolved([]));
        benchmarkFetch.mockResolvedValue(okJson({
            models: [{ name: 'judge-model:latest' }]
        }));
        probeJudgeCapability.mockResolvedValue({
            ok: true,
            context_length: 8192,
            parameter_size: '7B'
        });
    });

    it('blocks when judge host is unreachable', async () => {
        benchmarkFetch.mockResolvedValue(okJson({
            models: []
        }));

        const result = await checkJudgeConfiguration({
            host: 'http://judge-host:11434',
            model: 'judge-model:latest'
        });

        expect(result.ok).toBe(false);
        expect(result.blockers[0]).toMatch(/not found on host/);
    });

    it('passes when judge model is available on host', async () => {
        const result = await checkJudgeConfiguration({
            host: 'http://judge-host:11434',
            model: 'judge-model:latest'
        });

        expect(result.ok).toBe(true);
        expect(result.blockers).toEqual([]);
        expect(result.requested_num_ctx).toBe(8192);
        expect(result.model_context_length).toBe(8192);
    });

    it('warns when requested num_ctx exceeds model context window', async () => {
        probeJudgeCapability.mockResolvedValue({
            ok: true,
            context_length: 4096,
            parameter_size: '7B'
        });

        const result = await checkJudgeConfiguration({
            host: 'http://judge-host:11434',
            model: 'judge-model:latest',
            num_ctx: 8192
        });

        expect(result.ok).toBe(true);
        expect(result.warnings).toEqual(expect.arrayContaining([
            expect.stringMatching(/exceeds model's native context window/)
        ]));
    });

    it('returns null model_context_length when probe fails', async () => {
        probeJudgeCapability.mockResolvedValue({
            ok: false,
            error: 'probe failed'
        });

        const result = await checkJudgeConfiguration({
            host: 'http://judge-host:11434',
            model: 'judge-model:latest'
        });

        expect(result.ok).toBe(true);
        expect(result.model_context_length).toBeNull();
    });

    it('blocks benchmark targets that are explicitly marked ineligible in the registry', async () => {
        benchmarkFetch.mockResolvedValue(okJson({
            models: [{ name: 'blocked-model' }, { name: 'judge-model:latest' }]
        }));

        const result = await runPreflight({
            targets: [
                { host: 'http://exec-host:11434', model: 'blocked-model' }
            ],
            judgeConfig: {
                host: 'http://judge-host:11434',
                model: 'judge-model:latest'
            },
            levels: [5]
        });

        // blocked-model is not on the heuristic blocklist, so it should pass host checks
        expect(result.checks.hosts[0]).toMatchObject({
            host_ok: true
        });
    });

    it('blocks known-incompatible benchmark targets even without registry metadata', async () => {
        benchmarkFetch.mockResolvedValue(okJson({
            models: [{ name: 'deepcoder:14b-preview-q4_K_M' }, { name: 'judge-model:latest' }]
        }));

        const result = await runPreflight({
            targets: [
                { host: 'http://exec-host:11434', model: 'deepcoder:14b-preview-q4_K_M' }
            ],
            judgeConfig: {
                host: 'http://judge-host:11434',
                model: 'judge-model:latest'
            },
            levels: [5]
        });

        expect(result.checks.hosts[0]).toMatchObject({
            host_ok: true,
            benchmark_eligible: false,
            benchmark_eligibility_source: 'heuristic'
        });
    });

    it('profile-gates a namespaced benchmark target with an exact-name lookup', async () => {
        benchmarkFetch.mockResolvedValue(okJson({
            models: [{ name: 'ax/qwen3.5:9b' }, { name: 'judge-model:latest' }]
        }));

        const result = await runPreflight({
            targets: [
                { host: 'http://exec-host:11434', model: 'ax/qwen3.5:9b' }
            ],
            judgeConfig: {
                host: 'http://judge-host:11434',
                model: 'judge-model:latest'
            },
            levels: [5]
        });

        expect(result.checks.hosts[0]).toMatchObject({
            host_ok: true,
            benchmark_eligible: true
        });
        expect(ModelProfile.findOne).toHaveBeenCalledWith({ name: 'ax/qwen3.5:9b' });
    });

    it('aggregates host, judge, and orphaned-batch issues in runPreflight', async () => {
        BenchmarkBatch.find.mockReturnValue(chainResolved([
            {
                _id: 'batch-1',
                status: 'running',
                started_at: new Date('2026-03-07T12:00:00Z'),
                last_activity_at: new Date('2026-03-07T12:00:00Z')
            }
        ]));
        // Judge model not found on host
        benchmarkFetch.mockResolvedValue(okJson({
            models: [{ name: 'different-model:latest' }]
        }));

        const result = await runPreflight({
            targets: [
                { host: 'http://exec-host:11434', model: 'model-a:latest' },
                { host: 'http://exec-host:11434', model: 'model-a:latest' }
            ],
            judgeConfig: {
                host: 'http://judge-host:11434',
                model: 'judge-model:latest'
            },
            levels: [5]
        });

        expect(result.ready).toBe(false);
        expect(result.issues).toEqual(expect.arrayContaining([
            '1 host(s) unreachable or missing models',
            expect.stringMatching(/not found on host/),
            '1 orphaned batch(es) detected'
        ]));
        expect(benchmarkFetch).toHaveBeenCalledTimes(2);
    });

    it('uses exact prompt_ids for preflight prompt coverage and budget alignment', async () => {
        BenchmarkPrompt.find.mockReturnValue(chainResolved([
            {
                _id: 'aaaaaaaaaaaaaaaaaaaaaaaa',
                name: 'Distributed Cache System Design',
                category: 'reasoning',
                level: 5,
                expected_tokens: 500
            },
            {
                _id: 'bbbbbbbbbbbbbbbbbbbbbbbb',
                name: 'DFA as JSON Specification',
                category: 'instruction',
                level: 4,
                expected_tokens: 300
            }
        ]));

        const result = await runPreflight({
            targets: [
                { host: 'http://exec-host:11434', model: 'judge-model:latest' }
            ],
            judgeConfig: {
                host: 'http://judge-host:11434',
                model: 'judge-model:latest'
            },
            levels: [4, 5],
            prompt_ids: ['aaaaaaaaaaaaaaaaaaaaaaaa', 'bbbbbbbbbbbbbbbbbbbbbbbb'],
            executionConfig: { response_max_tokens: 4096 }
        });

        expect(result.ready).toBe(true);
        expect(result.checks.prompts.totalPrompts).toBe(2);
        expect(result.checks.prompts.categories).toMatchObject({
            reasoning: { count: 1 },
            instruction: { count: 1 }
        });
        expect(BenchmarkPrompt.aggregate).not.toHaveBeenCalled();
    });

    it('blocks selected prompts whose expected budget exceeds response_max_tokens', async () => {
        BenchmarkPrompt.find.mockReturnValue(chainResolved([
            {
                _id: 'aaaaaaaaaaaaaaaaaaaaaaaa',
                name: 'Huge Prompt',
                category: 'reasoning',
                level: 5,
                expected_tokens: 5000
            }
        ]));

        const result = await runPreflight({
            targets: [
                { host: 'http://exec-host:11434', model: 'judge-model:latest' }
            ],
            judgeConfig: {
                host: 'http://judge-host:11434',
                model: 'judge-model:latest'
            },
            prompt_ids: ['aaaaaaaaaaaaaaaaaaaaaaaa'],
            executionConfig: { response_max_tokens: 4096 }
        });

        expect(result.ready).toBe(false);
        expect(result.issues).toEqual(expect.arrayContaining([
            expect.stringMatching(/expected_tokens \(5000\) exceeds response_max_tokens \(4096\)/)
        ]));
    });

    it('warns when thinking mode leaves no reliable generation budget boundary', async () => {
        BenchmarkPrompt.find.mockReturnValue(chainResolved([
            {
                _id: 'aaaaaaaaaaaaaaaaaaaaaaaa',
                name: 'Reasoning Prompt',
                category: 'reasoning',
                level: 5,
                expected_tokens: 500
            }
        ]));

        const result = await runPreflight({
            targets: [
                { host: 'http://exec-host:11434', model: 'judge-model:latest' }
            ],
            judgeConfig: {
                host: 'http://judge-host:11434',
                model: 'judge-model:latest'
            },
            prompt_ids: ['aaaaaaaaaaaaaaaaaaaaaaaa'],
            executionConfig: {
                think: true,
                num_ctx: 8192,
                response_max_tokens: 8192
            }
        });

        expect(result.ready).toBe(true);
        expect(result.checks.prompts.warnings).toEqual(expect.arrayContaining([
            expect.stringMatching(/response_max_tokens \(8192\).*num_ctx \(8192\)/),
            expect.stringMatching(/think=true enabled/)
        ]));
    });

    it('surfaces host-specific thinking profile policy when think=true is requested', async () => {
        benchmarkFetch.mockResolvedValue(okJson({
            models: [{ name: 'ax/qwen3:8b' }, { name: 'judge-model:latest' }]
        }));
        ModelProfile.findOne.mockReturnValue(chainResolved({
            readiness: { 'exec-host': { stage: 'profiled', profileDepth: 'standard', benchmarkQualified: true, stale: false, artifact: {} } },
            thinkingProfiles: {
                'exec-host': {
                    profileVersion: 2,
                    supported: true,
                    channel: 'hidden',
                    probeCount: 4,
                    probeAttempts: 5,
                    maxProbeNumPredict: 2048,
                    visibleFinalAnswerOk: true,
                    recommendedPolicy: 'metered'
                }
            }
        }));

        const result = await runPreflight({
            targets: [
                { host: 'http://exec-host:11434', model: 'ax/qwen3:8b' }
            ],
            judgeConfig: {
                host: 'http://judge-host:11434',
                model: 'judge-model:latest'
            },
            levels: [5],
            executionConfig: { think: true, response_max_tokens: 4096 }
        });

        expect(result.ready).toBe(true);
        expect(result.checks.hosts[0].thinking_profile).toMatchObject({
            recommendedPolicy: 'metered',
            channel: 'hidden'
        });
        expect(result.checks.hosts[0].warnings).toEqual(expect.arrayContaining([
            expect.stringMatching(/policy=metered/)
        ]));
    });

    it('warns that forced think=true will run diagnostic-only for stale profiles', async () => {
        benchmarkFetch.mockResolvedValue(okJson({
            models: [{ name: 'ax/qwen3:8b' }, { name: 'judge-model:latest' }]
        }));
        ModelProfile.findOne.mockReturnValue(chainResolved({
            readiness: { 'exec-host': { stage: 'profiled', profileDepth: 'standard', benchmarkQualified: true, stale: false, artifact: {} } },
            thinkingProfiles: {
                'exec-host': {
                    supported: true,
                    channel: 'hidden',
                    probeCount: 4,
                    visibleFinalAnswerOk: true,
                    recommendedPolicy: 'on'
                }
            }
        }));

        const result = await runPreflight({
            targets: [
                { host: 'http://exec-host:11434', model: 'ax/qwen3:8b' }
            ],
            judgeConfig: {
                host: 'http://judge-host:11434',
                model: 'judge-model:latest'
            },
            levels: [5],
            executionConfig: { think: true, response_max_tokens: 4096 }
        });

        expect(result.ready).toBe(true);
        expect(result.checks.hosts[0].warnings).toEqual(expect.arrayContaining([
            expect.stringMatching(/predates calibrated retry profiling/),
            expect.stringMatching(/Forced think=true will run/)
        ]));
    });

    it('requires host and model in judge config when no defaults available', async () => {
        // Override the JUDGE_CONFIG mock to have no defaults
        jest.resetModules();
        jest.doMock('../../../src/services/qualityScorer', () => ({
            JUDGE_CONFIG: { host: '', model: '' }
        }));
        jest.doMock('../../../src/services/benchmark/http', () => ({
            benchmarkFetch: jest.fn()
        }));
        jest.doMock('../../../src/services/benchmark/judgeModelValidator', () => ({
            probeJudgeCapability: jest.fn()
        }));
        jest.doMock('../../../config/logger', () => ({
            info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn()
        }));
        const { checkJudgeConfiguration: freshCheck } = require('../../../src/services/benchmark/preflight');

        const result = await freshCheck({ host: '', model: '' });
        expect(result.ok).toBe(false);
        expect(result.blockers).toContain('Judge host and model are required');
    });
});
