'use strict';

jest.mock('../../models/ModelContextProbeSnapshot', () => ({ findOne: jest.fn() }));
jest.mock('../../src/services/modelContextProfileService', () => ({ findContextProfile: jest.fn() }));
jest.mock('../../src/helpers/ollamaHostConfig', () => ({
    normalizeHostUrl: jest.fn((url) => url ? String(url).replace(/\/+$/, '') : null)
}));

const ModelContextProbeSnapshot = require('../../models/ModelContextProbeSnapshot');
const contextProfiles = require('../../src/services/modelContextProfileService');
const {
    modelNameCandidates,
    resolveModelNumCtxDetails
} = require('../../src/services/modelContextResolver');

const ARTIFACT = {
    model: 'ax/qwen3.5:9b',
    hostId: 'host-beta',
    hostUrl: 'http://localhost:11434',
    digest: 'sha256:exact',
    runtimeFingerprint: 'runtime-a'
};

function sortedLean(value) {
    return {
        sort: jest.fn().mockReturnValue({ lean: jest.fn().mockResolvedValue(value) })
    };
}

describe('modelContextResolver exact-artifact evidence', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        contextProfiles.findContextProfile.mockResolvedValue(null);
        ModelContextProbeSnapshot.findOne.mockReturnValue(sortedLean(null));
    });

    it('does not collapse a namespaced tag into another artifact candidate', () => {
        expect(modelNameCandidates('ax/qwen3.5:9b')).toEqual(['ax/qwen3.5:9b']);
        expect(modelNameCandidates('qwen3.5:9b')).toEqual(['qwen3.5:9b']);
    });

    it('uses a materialized context profile bound to the exact artifact', async () => {
        contextProfiles.findContextProfile.mockResolvedValue({
            modelName: ARTIFACT.model,
            hostUrl: ARTIFACT.hostUrl,
            recommendedContext: 65536,
            verifiedMaxContext: 237568,
            verifiedInputTokens: 230000,
            lastValidatedAt: new Date('2026-06-16T00:00:00Z')
        });

        const result = await resolveModelNumCtxDetails(ARTIFACT.model, {
            targetHost: `${ARTIFACT.hostUrl}/`,
            artifactIdentity: ARTIFACT
        });

        expect(contextProfiles.findContextProfile).toHaveBeenCalledWith(
            ARTIFACT.model,
            ARTIFACT.hostUrl,
            ARTIFACT
        );
        expect(result).toMatchObject({
            num_ctx: 237568,
            source: 'model_context_profile',
            authoritative: true,
            targetHost: ARTIFACT.hostUrl
        });
        expect(ModelContextProbeSnapshot.findOne).not.toHaveBeenCalled();
    });

    it('uses only raw probe evidence with the same digest and runtime fingerprint', async () => {
        ModelContextProbeSnapshot.findOne.mockReturnValue(sortedLean({
            modelName: ARTIFACT.model,
            testedNumCtx: 202752,
            hostUrl: ARTIFACT.hostUrl,
            testedAt: new Date('2026-05-31T16:36:43Z'),
            status: 'completed'
        }));

        const result = await resolveModelNumCtxDetails(ARTIFACT.model, {
            targetHost: ARTIFACT.hostUrl,
            artifactIdentity: ARTIFACT
        });

        expect(ModelContextProbeSnapshot.findOne).toHaveBeenCalledWith({
            modelName: { $in: [ARTIFACT.model] },
            status: 'completed',
            hostUrl: ARTIFACT.hostUrl,
            artifactDigest: ARTIFACT.digest,
            runtimeFingerprint: ARTIFACT.runtimeFingerprint
        });
        expect(result).toMatchObject({
            num_ctx: 202752,
            source: 'benchmark_context_probe',
            authoritative: true
        });
    });

    it('rejects probe evidence with invalid throughput', async () => {
        ModelContextProbeSnapshot.findOne.mockReturnValue(sortedLean({
            testedNumCtx: 229376,
            atLimitTokensPerSec: 0,
            status: 'completed'
        }));

        const result = await resolveModelNumCtxDetails(ARTIFACT.model, {
            targetHost: ARTIFACT.hostUrl,
            artifactIdentity: ARTIFACT,
            fallback: 8192
        });

        expect(result).toMatchObject({
            num_ctx: 8192,
            source: 'caller_fallback',
            authoritative: false
        });
    });

    it('does not reuse raw probe evidence when artifact identity is unresolved', async () => {
        const result = await resolveModelNumCtxDetails(ARTIFACT.model, {
            targetHost: ARTIFACT.hostUrl
        });

        expect(ModelContextProbeSnapshot.findOne).not.toHaveBeenCalled();
        expect(result).toMatchObject({ num_ctx: null, source: 'unresolved', authoritative: false });
    });

    it('skips all prior profile artifacts during a re-profile warmup', async () => {
        const result = await resolveModelNumCtxDetails(ARTIFACT.model, {
            targetHost: ARTIFACT.hostUrl,
            artifactIdentity: ARTIFACT,
            skipPriorProfileArtifacts: true,
            fallback: 4096
        });

        expect(contextProfiles.findContextProfile).not.toHaveBeenCalled();
        expect(ModelContextProbeSnapshot.findOne).not.toHaveBeenCalled();
        expect(result).toMatchObject({ num_ctx: 4096, source: 'caller_fallback' });
    });
});
