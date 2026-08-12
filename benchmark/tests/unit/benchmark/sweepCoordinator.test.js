'use strict';

const { buildSweepPlan, _internal } = require('../../../src/services/benchmark/sweepCoordinator');

function queryResult(doc) {
    return {
        select: jest.fn().mockReturnValue({
            lean: jest.fn().mockResolvedValue(doc)
        })
    };
}

function makeDeps({ inventory, profileByName = {}, adaptationByName = {}, contextByName = {}, host = {} } = {}) {
    const resolvedHost = {
        hostId: 'secondary',
        hostUrl: 'http://ollama-host:11434',
        displayName: 'Host Beta',
        vramMb: 16000,
        ...host
    };

    return {
        checkHost: jest.fn().mockResolvedValue({
            available: true,
            models: inventory || []
        }),
        hostProfileService: {
            getById: jest.fn().mockResolvedValue(resolvedHost),
            getByUrl: jest.fn().mockResolvedValue(resolvedHost)
        },
        ModelProfile: {
            findOne: jest.fn((query) => {
                const names = query?.name?.$in || [];
                const foundName = names.find(name => profileByName[name]);
                return queryResult(foundName ? profileByName[foundName] : null);
            })
        },
        ModelAdaptation: {
            findOne: jest.fn((query) => {
                const names = query?.modelName?.$in || [];
                const foundName = names.find(name => adaptationByName[name]);
                return {
                    lean: jest.fn().mockResolvedValue(foundName ? adaptationByName[foundName] : null)
                };
            })
        },
        ModelContextProfile: {
            findOne: jest.fn((query) => {
                const names = query?.modelName?.$in || [];
                const foundName = names.find(name => contextByName[name]);
                return {
                    lean: jest.fn().mockResolvedValue(foundName ? contextByName[foundName] : null)
                };
            })
        }
    };
}

describe('benchmark sweep coordinator', () => {
    it('returns a benchmark payload for deployed ready adapted models', async () => {
        const deps = makeDeps({
            inventory: ['gemma4:e4b', 'ax/gemma4:e4b'],
            profileByName: {
                'gemma4:e4b': { readiness: { secondary: { stage: 'adapted', stale: false } } }
            },
            adaptationByName: {
                'gemma4:e4b': {
                    deployment: { status: 'deployed' },
                    profile: { vramUsedMiB: 3139 }
                }
            },
            contextByName: {
                'gemma4:e4b': {
                    recommendedContext: 16384,
                    verifiedMaxContext: 32768,
                    stale: false
                }
            }
        });

        const plan = await buildSweepPlan({
            hostId: 'secondary',
            lane: 'lightweight',
            candidates: ['gemma4:e4b'],
            levels: [1, 2, 3],
            judge_config: { host: 'http://judge:11434', model: 'judge-model' },
            run_name: 'sweep-run'
        }, deps);

        expect(plan.summary).toMatchObject({
            total: 1,
            ready: 1,
            benchmarkReadyModels: 1,
            droppedVram: 0
        });
        expect(plan.payloads.profileQueue).toBeNull();
        expect(plan.payloads.benchmark).toMatchObject({
            host: 'http://ollama-host:11434',
            models: ['ax/gemma4:e4b'],
            levels: [1, 2, 3],
            run_name: 'sweep-run'
        });
    });

    it('profiles a deployed adapted model when its validated context window is missing', async () => {
        const deps = makeDeps({
            inventory: ['ax/gemma4:e4b'],
            profileByName: {
                'gemma4:e4b': { readiness: { secondary: { stage: 'adapted', stale: false } } }
            },
            adaptationByName: {
                'gemma4:e4b': {
                    deployment: { status: 'deployed' },
                    profile: { vramUsedMiB: 3139 }
                }
            }
        });

        const plan = await buildSweepPlan({
            hostId: 'secondary',
            candidates: ['gemma4:e4b']
        }, deps);

        expect(plan.profileDepth).toBe('standard');
        expect(plan.candidates[0]).toMatchObject({
            readiness: 'needs_profile',
            contextValidated: false,
            reason: 'validated host/artifact context profile is missing'
        });
        expect(plan.candidates[0].actions).toEqual([
            { type: 'profile', model: 'ax/gemma4:e4b', reason: 'context_validation' }
        ]);
        expect(plan.payloads.profileQueue).toMatchObject({
            hostId: 'secondary',
            depth: 'standard',
            modelNames: ['ax/gemma4:e4b']
        });
        expect(plan.payloads.benchmark).toBeNull();
    });

    it('drops candidates whose profiled VRAM exceeds the host limit', async () => {
        const deps = makeDeps({
            inventory: ['huge:30b', 'ax/huge:30b'],
            host: { vramMb: null, gpu: { vramTotalMiB: 12000 } },
            profileByName: {
                'huge:30b': { readiness: { secondary: { stage: 'adapted', stale: false } } }
            },
            adaptationByName: {
                'huge:30b': {
                    deployment: { status: 'deployed' },
                    profile: { vramUsedMiB: 18000 }
                }
            }
        });

        const plan = await buildSweepPlan({
            hostId: 'secondary',
            candidates: ['huge:30b'],
            maxVramFraction: 1
        }, deps);

        expect(plan.summary.droppedVram).toBe(1);
        expect(plan.candidates[0]).toMatchObject({
            filterStatus: 'dropped',
            readiness: 'filtered_vram',
            vramUsedMiB: 18000,
            vramLimitMiB: 12000
        });
        expect(plan.payloads.benchmark).toBeNull();
    });

    it('plans profiling for raw models present on host without readiness evidence', async () => {
        const deps = makeDeps({
            inventory: ['qwen2.5:7b-instruct-q5_K_M']
        });

        const plan = await buildSweepPlan({
            hostId: 'secondary',
            candidates: ['qwen2.5:7b-instruct-q5_K_M'],
            profileDepth: 'quick'
        }, deps);

        expect(plan.summary).toMatchObject({
            needsProfile: 1,
            benchmarkReadyModels: 0
        });
        expect(plan.candidates[0].actions).toEqual([
            { type: 'profile', model: 'qwen2.5:7b-instruct-q5_K_M' }
        ]);
        expect(plan.payloads.profileQueue).toMatchObject({
            hostId: 'secondary',
            depth: 'quick',
            skipRecentDays: 0,
            includeAdapted: true,
            modelNames: ['qwen2.5:7b-instruct-q5_K_M']
        });
        expect(plan.payloads.benchmark).toBeNull();
    });

    it('blocks benchmark payloads when a profiled model still needs adaptation', async () => {
        const deps = makeDeps({
            inventory: ['qwen2.5:7b-instruct-q5_K_M'],
            profileByName: {
                'qwen2.5:7b-instruct-q5_K_M': {
                    readiness: { secondary: { stage: 'profiled', stale: false } }
                }
            },
            adaptationByName: {
                'qwen2.5:7b-instruct-q5_K_M': {
                    deployment: { status: 'pending' },
                    profile: { vramUsedMiB: 6689 }
                }
            }
        });

        const plan = await buildSweepPlan({
            hostId: 'secondary',
            candidates: ['qwen2.5:7b-instruct-q5_K_M']
        }, deps);

        expect(plan.summary.needsAdaptation).toBe(1);
        expect(plan.candidates[0]).toMatchObject({
            readiness: 'needs_adaptation',
            deployed: false
        });
        expect(plan.candidates[0].actions).toEqual([
            {
                type: 'adapt',
                model: 'qwen2.5:7b-instruct-q5_K_M',
                target: 'ax/qwen2.5:7b-instruct-q5_K_M'
            }
        ]);
        expect(plan.payloads.profileQueue).toBeNull();
        expect(plan.payloads.benchmark).toBeNull();
    });

    it('attaches an advisory analytical fit estimate to candidates (B2)', async () => {
        const deps = makeDeps({
            inventory: ['qwen2.5:7b-instruct-q5_K_M'],
            host: { vramMb: null, gpu: { vramTotalMiB: 12288 } } // .120-like 12GB
        });

        const plan = await buildSweepPlan({
            hostId: 'tertiary',
            candidates: ['qwen2.5:7b-instruct-q5_K_M'],
            maxVramFraction: 1
        }, deps);

        const est = plan.candidates[0].estimate;
        expect(est).toMatchObject({ paramBillions: 7, namedQuant: 'Q5_K_M', fitsAsNamed: true });
        expect(est.bestFittingQuant).toBeTruthy();
        expect(plan.summary.analyticalUnlikelyFit).toBe(0);
    });

    it('flags a candidate that analytically cannot fit the host VRAM (B2 advisory, not a hard drop)', async () => {
        const deps = makeDeps({
            inventory: ['huge:70b-instruct-q8_0'],
            host: { vramMb: null, gpu: { vramTotalMiB: 12288 } } // 70B Q8 cannot fit 12GB
        });

        const plan = await buildSweepPlan({
            hostId: 'tertiary',
            candidates: ['huge:70b-instruct-q8_0'],
            maxVramFraction: 1
        }, deps);

        const c = plan.candidates[0];
        expect(c.estimate.bestFittingQuant).toBeNull();
        expect(c.estimate.note).toMatch(/unlikely to fit/);
        expect(plan.summary.analyticalUnlikelyFit).toBe(1);
        // Advisory only: with no empirical profile it is NOT hard-dropped.
        expect(c.filterStatus).not.toBe('dropped');
    });

    it('estimates fit for an effective-param (eNb) model with no total-param tag', () => {
        // gemma4:e4b has no parseable total-param count; the e4b tag → 4B.
        const est = _internal.estimateCandidateFit(
            { adaptedModel: 'ax/gemma4:e4b', rawModel: 'gemma4:e4b', inputModel: 'gemma4:e4b' },
            12288
        );
        expect(est).not.toBeNull();
        expect(est.paramBillions).toBe(4);
        expect(est.bestFittingQuant).toBeTruthy();
    });

    it('estimateCandidateFit recommends a smaller quant when the named one overflows', () => {
        // 12B Q8 (~13.5 GiB weights) won't fit 12GB, but a lower quant will.
        const est = _internal.estimateCandidateFit(
            { adaptedModel: 'ax/gemma4:12b-it-q8_0', rawModel: 'gemma4:12b-it-q8_0', inputModel: 'gemma4:12b-it-q8_0' },
            12288
        );
        expect(est.namedQuant).toBe('Q8_0');
        expect(est.fitsAsNamed).toBe(false);
        expect(est.bestFittingQuant).toBeTruthy();
        expect(est.note).toMatch(/won't fit|would/);
    });
});
