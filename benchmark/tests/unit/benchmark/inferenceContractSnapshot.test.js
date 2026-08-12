'use strict';

const {
    MODES,
    assertFrozenArtifactDigest,
    getFrozenModelExecutionConfig,
    loadOrResolveCampaignInferenceContracts,
    loadOrResumeCampaignInferenceContracts,
    resolveStandaloneCampaignInferenceContracts,
    resolveFrozenMode
} = require('../../../src/services/benchmark/inferenceContractSnapshot');

function snapshot(overrides = {}) {
    return {
        version: 'agentx.inference-contract.v1',
        artifact: {
            model: 'model-a',
            host: 'http://exec:11434',
            digest: 'sha256:artifact-a',
            identityQualified: true
        },
        qualification: { qualified: true, state: 'benchmarked' },
        capabilities: {
            thinking: {
                supported: true,
                modes: ['off', 'on'],
                recommendedPolicy: 'metered',
                visibleFinalAnswer: { qualified: true }
            }
        },
        contextBudget: {
            windowTokens: 32768,
            validatedWindowTokens: 32768,
            source: 'model_context_profile',
            output: { reservedTokens: 8192 }
        },
        snapshot: {
            fingerprint: 'a'.repeat(64),
            resolvedAt: '2026-07-25T12:00:00.000Z'
        },
        ...overrides
    };
}

function response(payload) {
    return {
        ok: true,
        status: 200,
        json: jest.fn(async () => payload)
    };
}

function batchModel(existingDocs = []) {
    const findById = jest.fn();
    for (const doc of existingDocs) {
        findById.mockImplementationOnce(() => ({
            select: jest.fn().mockReturnValue({
                lean: jest.fn().mockResolvedValue(doc)
            })
        }));
    }
    return {
        findById,
        updateOne: jest.fn(async () => ({ matchedCount: 1 }))
    };
}

describe('campaign inference contract snapshots', () => {
    it('resolves a standalone immutable campaign without Mongo persistence', async () => {
        const fetchImpl = jest.fn(async () => response(snapshot()));
        const campaign = await resolveStandaloneCampaignInferenceContracts({
            hostGroups: [['http://exec:11434', ['model-a']]],
            executionConfig: {
                force_num_ctx: 8192,
                response_max_tokens: 4096,
                response_max_tokens_source: 'caller',
                response_mode: 'final_only',
                temperature: 0.2
            }
        }, { fetchImpl, coreUrl: 'http://core:3080' });

        expect(fetchImpl).toHaveBeenCalledTimes(1);
        expect(campaign).toMatchObject({
            schemaVersion: 1,
            responseMode: MODES.FINAL_ONLY,
            rankable: true,
            candidates: [{
                artifactDigest: 'sha256:artifact-a',
                contractFingerprint: 'a'.repeat(64),
                mode: { think: false, sendThink: true, rankable: true },
                execution: { num_ctx: 32768, num_predict: 8192 }
            }]
        });
        expect(campaign.requestFingerprint).toMatch(/^[a-f0-9]{64}$/);
    });

    it('resolves each artifact/host once, persists fixed settings, and reuses them for attempts', async () => {
        const BatchModel = batchModel([{}]);
        const fetchImpl = jest.fn(async () => response(snapshot()));
        const executionConfig = {
            force_num_ctx: 32768,
            response_max_tokens: 8192,
            response_max_tokens_source: 'caller',
            response_mode: 'explicit_thinking',
            temperature: 0.2,
            top_p: 0.9,
            top_k: 40,
            repeat_penalty: 1.1,
            seed: 42
        };

        const campaign = await loadOrResolveCampaignInferenceContracts({
            batchId: 'batch-1',
            hostGroups: [['http://exec:11434', ['model-a']]],
            executionConfig,
            recordBatchTimelineEvent: jest.fn(async () => {})
        }, { BatchModel, fetchImpl, coreUrl: 'http://core:3080' });

        expect(fetchImpl).toHaveBeenCalledTimes(1);
        expect(JSON.parse(fetchImpl.mock.calls[0][1].body)).toEqual({
            model: 'model-a',
            host: 'http://exec:11434',
            options: { num_ctx: 32768, num_predict: 8192 }
        });
        expect(BatchModel.updateOne).toHaveBeenCalledWith(
            expect.objectContaining({ _id: 'batch-1' }),
            expect.objectContaining({
                $set: expect.objectContaining({
                    inference_contract_campaign: expect.objectContaining({
                        responseMode: MODES.EXPLICIT_THINKING,
                        rankable: true
                    })
                })
            })
        );

        const fixed = getFrozenModelExecutionConfig(campaign, 'model-a', 'http://exec:11434', executionConfig);
        expect(fixed).toMatchObject({
            num_ctx: 32768,
            response_max_tokens: 8192,
            think: true,
            send_think: true,
            think_mode: MODES.EXPLICIT_THINKING,
            rankable_mode: true,
            artifact_digest: 'sha256:artifact-a',
            inference_contract_fingerprint: 'a'.repeat(64)
        });
    });

    it('reuses a persisted campaign on resume without resolving live state again', async () => {
        const firstBatchModel = batchModel([{}]);
        const fetchImpl = jest.fn(async () => response(snapshot()));
        const input = {
            batchId: 'batch-resume',
            hostGroups: [['http://exec:11434', ['model-a']]],
            executionConfig: {
                response_max_tokens_source: 'default',
                response_mode: 'final_only'
            }
        };
        const campaign = await loadOrResolveCampaignInferenceContracts(input, {
            BatchModel: firstBatchModel,
            fetchImpl
        });

        const resumeBatchModel = batchModel([{ inference_contract_campaign: campaign }]);
        const resumed = await loadOrResolveCampaignInferenceContracts(input, {
            BatchModel: resumeBatchModel,
            fetchImpl
        });

        expect(resumed.requestFingerprint).toBe(campaign.requestFingerprint);
        expect(fetchImpl).toHaveBeenCalledTimes(1);
        expect(resumeBatchModel.updateOne).not.toHaveBeenCalled();
    });

    it('loads the frozen resume campaign without resolving any live candidate snapshot', async () => {
        const input = {
            batchId: 'batch-bounded-resume',
            hostGroups: [['http://exec:11434', ['model-a']]],
            executionConfig: { response_mode: 'final_only' }
        };
        const fetchImpl = jest.fn(async () => response(snapshot()));
        const campaign = await loadOrResolveCampaignInferenceContracts(input, {
            BatchModel: batchModel([{}]),
            fetchImpl
        });
        const resumeBatchModel = batchModel([{ inference_contract_campaign: campaign }]);

        const resumed = await loadOrResumeCampaignInferenceContracts(input, {
            BatchModel: resumeBatchModel
        });

        expect(resumed).toBe(campaign);
        expect(fetchImpl).toHaveBeenCalledTimes(1);
        expect(resumeBatchModel.updateOne).not.toHaveBeenCalled();
    });

    it('fails closed when the frozen resume campaign is missing or fingerprint-drifted', async () => {
        const input = {
            batchId: 'batch-invalid-resume',
            hostGroups: [['http://exec:11434', ['model-a']]],
            executionConfig: { response_mode: 'final_only' }
        };
        await expect(loadOrResumeCampaignInferenceContracts(input, {
            BatchModel: batchModel([{}])
        })).rejects.toMatchObject({
            code: 'MISSING_OR_INCOMPATIBLE_CAMPAIGN',
            resumeBlocked: true
        });

        const campaign = await loadOrResolveCampaignInferenceContracts(input, {
            BatchModel: batchModel([{}]),
            fetchImpl: jest.fn(async () => response(snapshot()))
        });
        await expect(loadOrResumeCampaignInferenceContracts({
            ...input,
            executionConfig: { response_mode: 'native' }
        }, {
            BatchModel: batchModel([{ inference_contract_campaign: campaign }])
        })).rejects.toMatchObject({
            code: 'CAMPAIGN_FINGERPRINT_MISMATCH',
            resumeBlocked: true
        });
    });

    it('omits thinking controls for native mode and never ranks profile-auto mode', () => {
        expect(resolveFrozenMode(snapshot(), { response_mode: 'native' })).toMatchObject({
            name: MODES.NATIVE,
            think: null,
            sendThink: false,
            rankable: true
        });
        expect(resolveFrozenMode(snapshot(), { response_mode: 'auto' })).toMatchObject({
            name: MODES.PROFILE_AUTO,
            think: true,
            sendThink: true,
            rankable: false
        });
    });

    it('rejects snapshots that are not bound to an exact deployed digest', async () => {
        const BatchModel = batchModel([{}]);
        const fetchImpl = jest.fn(async () => response(snapshot({
            artifact: {
                model: 'model-a',
                host: 'http://exec:11434',
                digest: null,
                identityQualified: false
            }
        })));

        await expect(loadOrResolveCampaignInferenceContracts({
            batchId: 'batch-no-digest',
            hostGroups: [['http://exec:11434', ['model-a']]],
            executionConfig: { response_mode: 'final_only' }
        }, { BatchModel, fetchImpl })).rejects.toThrow(/artifact digest is unresolved/);
        expect(BatchModel.updateOne).not.toHaveBeenCalled();
    });

    it('fails closed if a mutable model tag changes after the campaign freeze', async () => {
        const BatchModel = batchModel([{}]);
        const campaign = await loadOrResolveCampaignInferenceContracts({
            batchId: 'batch-drift',
            hostGroups: [['http://exec:11434', ['model-a']]],
            executionConfig: { response_mode: 'final_only' }
        }, {
            BatchModel,
            fetchImpl: jest.fn(async () => response(snapshot()))
        });

        await expect(assertFrozenArtifactDigest(
            campaign,
            'model-a',
            'http://exec:11434',
            { getModelDigest: jest.fn(async () => 'sha256:repulled') }
        )).rejects.toThrow(/changed after campaign freeze/);
    });

    it('rejects a context request above the validated artifact/host window', async () => {
        const BatchModel = batchModel([{}]);
        const fetchImpl = jest.fn(async () => response(snapshot({
            contextBudget: {
                windowTokens: 32768,
                validatedWindowTokens: 16384,
                source: 'caller',
                output: { reservedTokens: 8192 }
            }
        })));

        await expect(loadOrResolveCampaignInferenceContracts({
            batchId: 'batch-unsafe-context',
            hostGroups: [['http://exec:11434', ['model-a']]],
            executionConfig: {
                force_num_ctx: 32768,
                response_max_tokens: 8192,
                response_max_tokens_source: 'caller',
                response_mode: 'final_only'
            }
        }, { BatchModel, fetchImpl })).rejects.toThrow(/not within a validated/);
    });
});
