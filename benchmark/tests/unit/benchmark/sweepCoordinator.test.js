'use strict';

const { buildSweepPlan, _internal } = require('../../../src/services/benchmark/sweepCoordinator');

const HOST = {
    hostId: 'secondary',
    hostUrl: 'http://ollama-host:11434',
    displayName: 'Host Beta',
    vramMb: 16000
};

function artifact(model, overrides = {}) {
    return {
        model,
        hostId: HOST.hostId,
        hostUrl: HOST.hostUrl,
        digest: `sha256:${model}`,
        runtimeFingerprint: 'runtime-a',
        registryQualified: true,
        ...overrides
    };
}

function queryResult(doc, withSelect = false) {
    const query = { lean: jest.fn().mockResolvedValue(doc) };
    if (withSelect) query.select = jest.fn().mockReturnValue(query);
    return query;
}

function makeDeps({
    inventory = [],
    profileByName = {},
    performanceByName = {},
    contextByName = {},
    identityErrorByName = {},
    host = {}
} = {}) {
    const resolvedHost = { ...HOST, ...host };
    return {
        checkHost: jest.fn().mockResolvedValue({ available: true, models: inventory }),
        hostProfileService: {
            getById: jest.fn().mockResolvedValue(resolvedHost),
            getByUrl: jest.fn().mockResolvedValue(resolvedHost)
        },
        resolveArtifactIdentity: jest.fn(async (model) => {
            if (identityErrorByName[model]) throw new Error(identityErrorByName[model]);
            return artifact(model, { hostId: resolvedHost.hostId, hostUrl: resolvedHost.hostUrl });
        }),
        ModelProfile: {
            findOne: jest.fn(({ name }) => queryResult(profileByName[name] || null, true))
        },
        ModelPerformanceProfile: {
            findOne: jest.fn(({ modelName }) => queryResult(performanceByName[modelName] || null))
        },
        ModelContextProfile: {
            findOne: jest.fn(({ modelName }) => queryResult(contextByName[modelName] || null))
        }
    };
}

function readyEvidence(model, { vramUsedMiB = 3139 } = {}) {
    const id = artifact(model);
    return {
        profile: {
            readiness: {
                [HOST.hostId]: {
                    stage: 'profiled',
                    profileDepth: 'standard',
                    benchmarkQualified: true,
                    stale: false,
                    artifact: id
                }
            }
        },
        performance: {
            modelName: model,
            hostId: HOST.hostId,
            active: true,
            stale: false,
            artifact: id,
            profile: { vramUsedMiB }
        },
        context: {
            modelName: model,
            hostId: HOST.hostId,
            hostUrl: HOST.hostUrl,
            artifactDigest: id.digest,
            runtimeFingerprint: id.runtimeFingerprint,
            recommendedInteractiveContext: 16384,
            recommendedDocumentContext: 32768,
            maxVerifiedContext: 65536,
            recommendationStatus: 'verified',
            revalidationRequired: false,
            stale: false
        }
    };
}

describe('benchmark sweep coordinator exact-artifact planning', () => {
    it('returns a benchmark payload for an exact qualified artifact without rewriting its tag', async () => {
        const model = 'ax/gemma4:e4b';
        const evidence = readyEvidence(model);
        const deps = makeDeps({
            inventory: [model],
            profileByName: { [model]: evidence.profile },
            performanceByName: { [model]: evidence.performance },
            contextByName: { [model]: evidence.context }
        });

        const plan = await buildSweepPlan({
            hostId: HOST.hostId,
            candidates: [model],
            levels: [1, 2, 3],
            run_name: 'sweep-run'
        }, deps);

        expect(plan.summary).toMatchObject({ ready: 1, benchmarkReadyModels: 1 });
        expect(plan.payloads.profileQueue).toBeNull();
        expect(plan.payloads.benchmark).toMatchObject({
            host: HOST.hostUrl,
            models: [model],
            levels: [1, 2, 3],
            run_name: 'sweep-run'
        });
        expect(plan.candidates[0]).not.toHaveProperty('adaptedModel');
    });

    it('queues a standard profile when exact context evidence is missing', async () => {
        const model = 'gemma4:e4b';
        const evidence = readyEvidence(model);
        const deps = makeDeps({
            inventory: [model],
            profileByName: { [model]: evidence.profile },
            performanceByName: { [model]: evidence.performance }
        });

        const plan = await buildSweepPlan({ hostId: HOST.hostId, candidates: [model] }, deps);

        expect(plan.candidates[0]).toMatchObject({
            model,
            readiness: 'needs_profile',
            contextValidated: false,
            reason: 'exact digest/runtime context evidence is missing or stale'
        });
        expect(plan.candidates[0].actions).toEqual([
            { type: 'profile', model, reason: 'context_validation' }
        ]);
        expect(plan.payloads.profileQueue).toMatchObject({
            hostId: HOST.hostId,
            depth: 'standard',
            modelNames: [model]
        });
        expect(plan.payloads.benchmark).toBeNull();
    });

    it('never authorizes a sweep from a legacy 262K recommendation', async () => {
        const model = 'qwen-legacy:latest';
        const evidence = readyEvidence(model);
        evidence.context = {
            ...evidence.context,
            recommendedInteractiveContext: null,
            recommendedDocumentContext: null,
            maxVerifiedContext: 262144,
            recommendedContext: 262144,
            recommendationStatus: 'unknown',
            revalidationRequired: true,
            stale: true
        };
        const deps = makeDeps({
            inventory: [model],
            profileByName: { [model]: evidence.profile },
            performanceByName: { [model]: evidence.performance },
            contextByName: { [model]: evidence.context }
        });

        const plan = await buildSweepPlan({ hostId: HOST.hostId, candidates: [model] }, deps);
        expect(plan.candidates[0]).toMatchObject({
            readiness: 'needs_profile',
            contextValidated: false
        });
        expect(plan.payloads.benchmark).toBeNull();
    });

    it('does not treat a namespaced installation as the requested bare tag', async () => {
        const model = 'gemma4:e4b';
        const deps = makeDeps({ inventory: ['ax/gemma4:e4b'] });
        const plan = await buildSweepPlan({ hostId: HOST.hostId, candidates: [model] }, deps);

        expect(plan.candidates[0]).toMatchObject({
            model,
            readiness: 'not_on_host',
            onHost: { exact: false }
        });
        expect(plan.payloads.benchmark).toBeNull();
    });

    it('does not benchmark quick evidence that is not benchmark-qualified', async () => {
        const model = 'qwen2.5:7b-instruct-q5_K_M';
        const evidence = readyEvidence(model);
        evidence.profile.readiness[HOST.hostId].profileDepth = 'quick';
        evidence.profile.readiness[HOST.hostId].benchmarkQualified = false;
        const deps = makeDeps({
            inventory: [model],
            profileByName: { [model]: evidence.profile },
            performanceByName: { [model]: evidence.performance },
            contextByName: { [model]: evidence.context }
        });

        const plan = await buildSweepPlan({ hostId: HOST.hostId, candidates: [model] }, deps);
        expect(plan.summary.needsProfile).toBe(1);
        expect(plan.payloads.benchmark).toBeNull();
    });

    it('blocks an installed artifact when registry identity cannot be resolved', async () => {
        const model = 'owner/model:8b-q4';
        const deps = makeDeps({
            inventory: [model],
            identityErrorByName: { [model]: 'registry digest mismatch' }
        });

        const plan = await buildSweepPlan({ hostId: HOST.hostId, candidates: [model] }, deps);
        expect(plan.candidates[0]).toMatchObject({
            readiness: 'identity_unqualified',
            reason: 'registry digest mismatch'
        });
        expect(plan.summary.identityUnqualified).toBe(1);
    });

    it('drops candidates whose measured VRAM exceeds the host limit', async () => {
        const model = 'huge:30b';
        const evidence = readyEvidence(model, { vramUsedMiB: 18000 });
        const deps = makeDeps({
            inventory: [model],
            host: { vramMb: null, gpu: { vramTotalMiB: 12000 } },
            profileByName: { [model]: evidence.profile },
            performanceByName: { [model]: evidence.performance },
            contextByName: { [model]: evidence.context }
        });

        const plan = await buildSweepPlan({ hostId: HOST.hostId, candidates: [model] }, deps);
        expect(plan.candidates[0]).toMatchObject({
            filterStatus: 'dropped',
            readiness: 'filtered_vram',
            vramUsedMiB: 18000,
            vramLimitMiB: 12000
        });
    });

    it('estimates active-parameter and named-quant fit from the exact model tag', () => {
        const active = _internal.estimateCandidateFit({ model: 'gemma4:e4b' }, 12288);
        expect(active).toMatchObject({ paramBillions: 4 });
        expect(active.bestFittingQuant).toBeTruthy();

        const quantized = _internal.estimateCandidateFit({ model: 'gemma4:12b-it-q8_0' }, 12288);
        expect(quantized).toMatchObject({ namedQuant: 'Q8_0', fitsAsNamed: false });
        expect(quantized.bestFittingQuant).toBeTruthy();
    });
});
