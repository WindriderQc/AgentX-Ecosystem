'use strict';

const {
    BUILTIN_GRADER_VERSION,
    executeCampaign,
    normalizeFixtureSuite,
    validateExecutionReceipt
} = require('../../../src/services/benchmark/cloudLaneCampaignRunner');
const { buildCampaignPlan, fingerprint } = require('../../../src/services/benchmark/cloudLaneAccounting');

const NOW = '2026-08-27T16:00:00.000Z';
const DIGEST = 'a'.repeat(64);

function fixtureSuite() {
    return {
        suite: 'portable-smoke',
        suiteVersion: '1.0.0',
        fixtures: [{
            id: 'echo-house',
            messages: [{ role: 'user', content: 'Return exactly: HOUSE' }],
            tools: [],
            grader: { type: 'exact_text', expected: 'HOUSE' },
            maxInputTokens: 64,
            maxCacheReadTokens: 0,
            maxCacheWriteTokens: 0
        }]
    };
}

function zeroPrice(model = 'cloud/free', modelVersion = 'cloud/free-20260827') {
    return {
        provider: 'openrouter',
        model,
        modelVersion,
        effectiveAt: NOW,
        source: 'https://openrouter.ai/api/v1/models',
        rates: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
    };
}

function localCandidate(overrides = {}) {
    return {
        id: 'local-a',
        tier: 'local',
        provider: 'ollama',
        model: 'qwen3:8b',
        modelVersion: 'qwen3:8b-build-1',
        apiVersion: 'ollama-0.11.10',
        provenanceSource: 'local Ollama manifest',
        contextWindow: 4096,
        artifactDigest: DIGEST,
        ...overrides
    };
}

function freeCandidate(overrides = {}) {
    return {
        id: 'free-a',
        tier: 'free_cloud',
        provider: 'openrouter',
        model: 'cloud/free',
        modelVersion: 'cloud/free-20260827',
        apiVersion: 'openrouter-chat-completions-v1',
        provenanceSource: 'https://openrouter.ai/api/v1/models',
        contextWindow: 8192,
        priceSnapshot: zeroPrice(),
        ...overrides
    };
}

function paidCandidate(overrides = {}) {
    const model = 'cloud/paid';
    const modelVersion = 'cloud/paid-20260827';
    return {
        id: 'paid-a',
        tier: 'paid_cloud',
        provider: 'openrouter',
        model,
        modelVersion,
        apiVersion: 'openrouter-chat-completions-v1',
        provenanceSource: 'https://openrouter.ai/api/v1/models',
        contextWindow: 8192,
        priceSnapshot: {
            ...zeroPrice(model, modelVersion),
            rates: { input: 1_000_000_000, output: 1_000_000_000, cacheRead: 0, cacheWrite: 0 }
        },
        ...overrides
    };
}

function campaign(candidates = [localCandidate(), freeCandidate()], overrides = {}) {
    const fixtures = fixtureSuite();
    const fixtureFingerprint = normalizeFixtureSuite(fixtures).fingerprint;
    return {
        fixtures,
        plan: buildCampaignPlan({
            campaignId: 'campaign-portable-1',
            lane: 'worker',
            contract: {
                version: '1.0.0',
                suite: fixtures.suite,
                suiteVersion: fixtures.suiteVersion,
                fixtureFingerprint,
                graderVersion: BUILTIN_GRADER_VERSION,
                responseMode: 'final_only',
                maxOutputTokens: 32,
                temperature: 0,
                seed: 42,
                thinking: false,
                toolProtocol: null
            },
            candidates,
            estimatedCalls: candidates.length,
            spendCeilingNanodollars: 0,
            ...overrides
        })
    };
}

function authorization(plan, overrides = {}) {
    return {
        authorized: true,
        authorizationId: 'os-session-1',
        authenticatedActor: 'operator@example.invalid',
        authenticationMethod: 'test-authenticator',
        authenticatedAt: NOW,
        planFingerprint: plan.planFingerprint,
        maxCalls: plan.estimatedCalls,
        maxSpendNanodollars: plan.spendCeilingNanodollars,
        ...overrides
    };
}

function transport(candidate, overrides = {}) {
    return {
        preflight: jest.fn(async () => ({
            ready: true,
            checkedAt: NOW,
            provider: candidate.provider,
            model: candidate.model,
            modelVersion: candidate.modelVersion,
            apiVersion: candidate.apiVersion,
            contextWindow: candidate.contextWindow,
            artifactDigest: candidate.artifactDigest || null,
            priceSnapshot: candidate.priceSnapshot || null
        })),
        execute: jest.fn(async () => ({
            ok: true,
            observedAt: NOW,
            latencyMs: candidate.tier === 'local' ? 12 : 25,
            identity: {
                provider: candidate.provider,
                model: candidate.model,
                modelVersion: candidate.modelVersion,
                apiVersion: candidate.apiVersion,
                contextWindow: candidate.contextWindow,
                artifactDigest: candidate.artifactDigest || null,
                priceSnapshot: candidate.priceSnapshot || null
            },
            usage: { input: 8, output: 2, cacheRead: 0, cacheWrite: 0 },
            response: { text: 'HOUSE', toolCalls: [], raw: { portable: true } }
        })),
        ...overrides
    };
}

describe('cloud/local exact campaign execution', () => {
    test('runs one exact measured call per candidate and emits tamper-evident raw evidence', async () => {
        const { fixtures, plan } = campaign();
        const transports = Object.fromEntries(plan.candidates.map((candidate) => [candidate.id, transport(candidate)]));
        const result = await executeCampaign({
            fixtures,
            plan,
            transports,
            now: NOW,
            authorizeExecution: async () => authorization(plan)
        });

        expect(result.calls).toHaveLength(2);
        expect(result.calls.every((call) => call.executionReceipt.fingerprint.length === 64)).toBe(true);
        expect(validateExecutionReceipt(result.calls[0].executionReceipt)).toEqual(result.calls[0].executionReceipt);
        expect(() => validateExecutionReceipt({
            ...result.calls[0].executionReceipt,
            qualityScore: 0.5
        })).toThrow(expect.objectContaining({ code: 'EXECUTION_RECEIPT_TAMPERED' }));
        expect(result.calls[1].attribution).toMatchObject({ totalCostNanodollars: 0, tier: 'free_cloud' });
        expect(result.comparison).toMatchObject({
            evidenceScope: 'measured',
            exactContractComparable: true,
            universalWinner: null,
            routeMutation: false,
            networkAuthorized: false
        });
        expect(result.calls[0].result.response.raw).toEqual({ portable: true });
        expect(result.fingerprint).toHaveLength(64);
        expect(transports['local-a'].execute).toHaveBeenCalledTimes(1);
        expect(transports['free-a'].execute).toHaveBeenCalledTimes(1);
    });

    test('performs zero transport activity without an authenticated execution callback', async () => {
        const { fixtures, plan } = campaign();
        const candidateTransport = transport(plan.candidates[0]);
        await expect(executeCampaign({
            fixtures,
            plan,
            transports: { 'local-a': candidateTransport }
        })).rejects.toMatchObject({ code: 'EXECUTION_AUTHORIZATION_REQUIRED' });
        expect(candidateTransport.preflight).not.toHaveBeenCalled();
        expect(candidateTransport.execute).not.toHaveBeenCalled();
    });

    test('rejects a stale or plan-mismatched runner authorization before preflight', async () => {
        const { fixtures, plan } = campaign();
        const transports = Object.fromEntries(plan.candidates.map((candidate) => [candidate.id, transport(candidate)]));
        await expect(executeCampaign({
            fixtures,
            plan,
            transports,
            now: NOW,
            authorizeExecution: async () => authorization(plan, { planFingerprint: fingerprint({ wrong: true }) })
        })).rejects.toMatchObject({ code: 'AUTHORIZATION_PLAN_MISMATCH' });
        expect(transports['local-a'].preflight).not.toHaveBeenCalled();
    });

    test('stops all calls when any preflight identity drifts', async () => {
        const { fixtures, plan } = campaign();
        const transports = Object.fromEntries(plan.candidates.map((candidate) => [candidate.id, transport(candidate)]));
        transports['free-a'].preflight.mockResolvedValue({
            ready: true,
            checkedAt: NOW,
            provider: 'openrouter',
            model: 'cloud/free',
            modelVersion: 'drifted',
            apiVersion: 'openrouter-chat-completions-v1',
            contextWindow: 8192,
            priceSnapshot: plan.candidates[1].priceSnapshot
        });
        await expect(executeCampaign({
            fixtures,
            plan,
            transports,
            now: NOW,
            authorizeExecution: async () => authorization(plan)
        })).rejects.toMatchObject({ code: 'PREFLIGHT_IDENTITY_DRIFT' });
        expect(transports['local-a'].execute).not.toHaveBeenCalled();
        expect(transports['free-a'].execute).not.toHaveBeenCalled();
    });

    test('requires an explicit zero-price snapshot for a real free-cloud run', async () => {
        const noPrice = freeCandidate({ priceSnapshot: null });
        const { fixtures, plan } = campaign([localCandidate(), noPrice]);
        const transports = Object.fromEntries(plan.candidates.map((candidate) => [candidate.id, transport(candidate)]));
        await expect(executeCampaign({
            fixtures,
            plan,
            transports,
            now: NOW,
            authorizeExecution: async () => authorization(plan)
        })).rejects.toMatchObject({ code: 'CURRENT_PRICE_REQUIRED' });
        expect(transports['local-a'].preflight).toHaveBeenCalledTimes(1);
        expect(transports['free-a'].preflight).not.toHaveBeenCalled();
        expect(transports['local-a'].execute).not.toHaveBeenCalled();
    });

    test('enforces worst-case paid spend before the first paid provider call', async () => {
        const candidates = [paidCandidate(), localCandidate()];
        const { fixtures, plan } = campaign(candidates, { spendCeilingNanodollars: 1 });
        const paidApproval = {
            approvalId: 'approval-1',
            campaignId: plan.campaignId,
            planFingerprint: plan.planFingerprint,
            approvedBy: 'owner@example.invalid',
            approvedAt: '2026-08-27T15:55:00.000Z',
            expiresAt: '2026-08-27T16:55:00.000Z',
            maxCalls: plan.estimatedCalls,
            maxSpendNanodollars: plan.spendCeilingNanodollars,
            candidateIds: ['paid-a']
        };
        const transports = Object.fromEntries(plan.candidates.map((candidate) => [candidate.id, transport(candidate)]));
        await expect(executeCampaign({
            fixtures,
            plan,
            transports,
            paidApproval,
            now: NOW,
            authorizeExecution: async ({ paidApproval: checked }) => authorization(plan, {
                paidApprovalFingerprint: checked.fingerprint
            })
        })).rejects.toMatchObject({ code: 'SPEND_CEILING_EXCEEDED' });
        expect(transports['paid-a'].execute).not.toHaveBeenCalled();
        expect(transports['local-a'].execute).not.toHaveBeenCalled();
    });

    test('rejects provider token usage above a frozen fixture ceiling', async () => {
        const { fixtures, plan } = campaign();
        const transports = Object.fromEntries(plan.candidates.map((candidate) => [candidate.id, transport(candidate)]));
        transports['local-a'].execute.mockImplementation(async () => ({
            ...(await transport(plan.candidates[0]).execute()),
            usage: { input: 65, output: 2, cacheRead: 0, cacheWrite: 0 }
        }));
        await expect(executeCampaign({
            fixtures,
            plan,
            transports,
            now: NOW,
            authorizeExecution: async () => authorization(plan)
        })).rejects.toMatchObject({ code: 'TOKEN_CEILING_EXCEEDED' });
    });
});
