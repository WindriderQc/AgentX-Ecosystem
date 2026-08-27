'use strict';

const {
    attributeProviderCall,
    buildCampaignPlan,
    checkPaidApproval,
    compareLaneObservations,
    fingerprint,
    validateAttributionReceipt
} = require('../../../src/services/benchmark/cloudLaneAccounting');

const FIXTURE = 'f'.repeat(64);
const LOCAL_DIGEST = 'a'.repeat(64);
const NOW = '2026-08-27T12:00:00.000Z';

function contract(overrides = {}) {
    return {
        version: 'agentx.lane-comparison.v1',
        lane: 'coding',
        suite: 'portable-coding-contracts',
        suiteVersion: '1.0.0',
        fixtureFingerprint: FIXTURE,
        graderVersion: 'hybrid-grader-v1',
        responseMode: 'final_only',
        maxOutputTokens: 1200,
        temperature: 0,
        seed: 42,
        thinking: false,
        toolProtocol: 'openai-tools-v1',
        ...overrides
    };
}

function price(overrides = {}) {
    return {
        provider: 'openrouter',
        model: 'vendor/ultimate-model',
        modelVersion: '2026-08-01',
        currency: 'USD',
        effectiveAt: '2026-08-01T00:00:00.000Z',
        source: 'provider price card 2026-08-01',
        rates: {
            input: 1_500_000_000,
            output: 7_500_000_000,
            cacheRead: 0,
            cacheWrite: 0
        },
        ...overrides
    };
}

function localCandidate(overrides = {}) {
    return {
        id: 'local-qwen',
        tier: 'local',
        provider: 'ollama',
        model: 'qwen:27b',
        modelVersion: 'sha256:a',
        apiVersion: 'ollama-0.12',
        provenanceSource: 'exact artifact registry',
        contextWindow: 131072,
        artifactDigest: LOCAL_DIGEST,
        ...overrides
    };
}

function freeCandidate(overrides = {}) {
    return {
        id: 'free-nemotron',
        tier: 'free_cloud',
        provider: 'openrouter',
        model: 'nvidia/nemotron:free',
        modelVersion: 'openrouter-2026-08-20',
        apiVersion: 'openrouter-chat-v1',
        provenanceSource: 'provider model catalog receipt',
        contextWindow: 131072,
        priceSnapshot: price({
            model: 'nvidia/nemotron:free',
            modelVersion: 'openrouter-2026-08-20',
            rates: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
        }),
        ...overrides
    };
}

function paidCandidate(overrides = {}) {
    return {
        id: 'paid-ultimate',
        tier: 'paid_cloud',
        provider: 'openrouter',
        model: 'vendor/ultimate-model',
        modelVersion: '2026-08-01',
        apiVersion: 'openrouter-chat-v1',
        provenanceSource: 'provider model catalog receipt',
        contextWindow: 200000,
        priceSnapshot: price(),
        ...overrides
    };
}

function plan(overrides = {}) {
    return buildCampaignPlan({
        campaignId: 'campaign-1',
        lane: 'coding',
        contract: contract(),
        candidates: [localCandidate(), freeCandidate(), paidCandidate()],
        estimatedCalls: 3,
        spendCeilingNanodollars: 10_000_000,
        ...overrides
    });
}

function paidReceipt(overrides = {}) {
    return attributeProviderCall({
        callId: 'call-paid-1',
        campaignId: 'campaign-1',
        lane: 'coding',
        tier: 'paid_cloud',
        provider: 'openrouter',
        model: 'vendor/ultimate-model',
        modelVersion: '2026-08-01',
        observedAt: NOW,
        usage: { input: 1000, output: 500, cacheRead: 0, cacheWrite: 0 },
        pricing: price(),
        ...overrides
    });
}

function observation(candidate, metrics, overrides = {}) {
    return {
        campaignId: 'campaign-1',
        lane: 'coding',
        evidenceType: 'measured',
        candidate,
        contract: contract(),
        observedAt: NOW,
        attempts: 4,
        successes: 4,
        metrics,
        ...overrides
    };
}

describe('cloud/local lane campaign policy', () => {
    test('freezes generation settings into the exact contract fingerprint', () => {
        const base = plan({ candidates: [localCandidate(), freeCandidate()], estimatedCalls: 2 });
        const changed = plan({
            candidates: [localCandidate(), freeCandidate()],
            estimatedCalls: 2,
            contract: contract({ seed: 43 })
        });
        expect(base.contract).toMatchObject({ temperature: 0, seed: 42, thinking: false });
        expect(changed.contract.fingerprint).not.toBe(base.contract.fingerprint);
    });

    test('rejects ambiguous non-boolean thinking settings', () => {
        expect(() => plan({ contract: contract({ thinking: 'false' }) }))
            .toThrow(expect.objectContaining({ code: 'INVALID_BOOLEAN' }));
    });

    test('keeps local, free-cloud, and paid-cloud candidates in separate cohorts', () => {
        const result = plan();
        expect(result.cohorts).toEqual({
            local: ['local-qwen'],
            free_cloud: ['free-nemotron'],
            paid_cloud: ['paid-ultimate']
        });
        expect(result.policy).toMatchObject({ universalWinner: null, routeMutation: false, networkAuthorized: false });
        expect(result.paidGate.status).toBe('operator_approval_required');
    });

    test.each(['family', 'kid'])('%s lanes reject every non-local candidate', (lane) => {
        expect(() => buildCampaignPlan({
            campaignId: 'family-campaign',
            lane,
            contract: contract({ lane }),
            candidates: [localCandidate({ id: 'local-a' }), freeCandidate()],
            estimatedCalls: 2
        })).toThrow(/local-only/);
    });

    test('paid approval is exact, short-lived, and still not a network authorization', () => {
        const campaign = plan();
        const unsigned = {
            schemaVersion: 1,
            approvalId: 'approval-1',
            campaignId: campaign.campaignId,
            planFingerprint: campaign.planFingerprint,
            approvedBy: 'operator-y',
            approvedAt: '2026-08-27T11:55:00.000Z',
            expiresAt: '2026-08-27T12:55:00.000Z',
            maxCalls: 3,
            maxSpendNanodollars: 10_000_000,
            candidateIds: ['paid-ultimate']
        };
        const approval = { ...unsigned, fingerprint: fingerprint(unsigned) };
        const gate = checkPaidApproval(campaign, approval, { now: NOW });
        expect(gate).toMatchObject({ status: 'declaration_valid', declarationValid: true, networkAuthorized: false });
        expect(gate.reason).toMatch(/authenticated operator execution boundary/);
    });

    test('paid approval fails closed when missing, expired, or ceiling-mismatched', () => {
        const campaign = plan();
        expect(() => checkPaidApproval(campaign)).toThrow(/operator approval/);

        const base = {
            approvalId: 'approval-1', campaignId: campaign.campaignId, planFingerprint: campaign.planFingerprint,
            approvedBy: 'operator-y', approvedAt: '2026-08-27T10:00:00.000Z',
            expiresAt: '2026-08-27T11:00:00.000Z', maxCalls: 3,
            maxSpendNanodollars: 10_000_000, candidateIds: ['paid-ultimate']
        };
        expect(() => checkPaidApproval(campaign, base, { now: NOW })).toThrow(/active/);
        expect(() => checkPaidApproval(campaign, { ...base, expiresAt: '2026-08-27T13:00:00.000Z', maxCalls: 4 }, { now: NOW }))
            .toThrow(/ceilings/);
    });
});

describe('integer provider-call attribution', () => {
    test('attributes an exact $0.005250000 receipt using integer nanodollars', () => {
        const receipt = paidReceipt();
        expect(receipt.components.input.costNanodollars).toBe(1_500_000);
        expect(receipt.components.output.costNanodollars).toBe(3_750_000);
        expect(receipt.totalCostNanodollars).toBe(5_250_000);
        expect(receipt.totalCostUsd).toBe('0.005250000');
        expect(validateAttributionReceipt(receipt)).toEqual(receipt);
    });

    test('detects usage, price, and provider-version tampering', () => {
        const receipt = paidReceipt();
        expect(() => validateAttributionReceipt({ ...receipt, usage: { ...receipt.usage, output: 501 } }))
            .toThrow(/fingerprint/);
        expect(() => paidReceipt({ modelVersion: 'different-version' })).toThrow(/must match/);
    });

    test('allows an explicit zero-priced free-cloud receipt but never a priced one', () => {
        const zeroPrice = price({
            model: 'nvidia/nemotron:free', modelVersion: 'openrouter-2026-08-20',
            rates: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
        });
        const receipt = attributeProviderCall({
            callId: 'free-1', campaignId: 'campaign-1', lane: 'coding', tier: 'free_cloud',
            provider: 'openrouter', model: 'nvidia/nemotron:free', modelVersion: 'openrouter-2026-08-20',
            observedAt: NOW, usage: { input: 1000, output: 100 }, pricing: zeroPrice
        });
        expect(receipt.totalCostNanodollars).toBe(0);
        expect(() => attributeProviderCall({ ...receipt, pricing: price() })).toThrow();
    });
});

describe('exact-contract lane comparison', () => {
    const local = observation(localCandidate(), {
        qualityScore: 0.84, latencyMs: 1200, contextTokens: 120000
    });
    const free = observation(freeCandidate(), {
        qualityScore: 0.88, latencyMs: 2400, contextTokens: 120000
    }, { attempts: 4, successes: 3 });
    const paid = observation(paidCandidate(), {
        qualityScore: 0.94, latencyMs: 1500, contextTokens: 120000
    }, { attribution: paidReceipt() });

    test('compares exact-contract cohorts without inventing a universal winner or route change', () => {
        const report = compareLaneObservations({ lane: 'coding', observations: [local, free, paid], generatedAt: NOW });
        expect(report.exactContractComparable).toBe(true);
        expect(report.contractGroups).toHaveLength(1);
        expect(report.contractGroups[0].comparableTiers).toEqual(['local', 'free_cloud', 'paid_cloud']);
        expect(report.contractGroups[0].leadersByCohort).toEqual({
            local: 'local-qwen', free_cloud: 'free-nemotron', paid_cloud: 'paid-ultimate'
        });
        expect(report).toMatchObject({ universalWinner: null, routeMutation: false, networkAuthorized: false });
        expect(report.paidCostUsd).toBe('0.005250000');
    });

    test('separates mismatched contracts instead of comparing them', () => {
        const changed = { ...free, contract: contract({ suiteVersion: '2.0.0' }) };
        const report = compareLaneObservations({ lane: 'coding', observations: [local, changed], generatedAt: NOW });
        expect(report.exactContractComparable).toBe(false);
        expect(report.contractGroups).toHaveLength(2);
        expect(report.contractGroups.every((group) => group.crossTierComparable === false)).toBe(true);
    });

    test('rejects a paid observation without an untampered attribution receipt', () => {
        expect(() => compareLaneObservations({
            lane: 'coding',
            observations: [local, { ...paid, attribution: null }]
        })).toThrow(/requires an untampered/);
    });

    test('marks a fixture-only comparison synthetic rather than performance evidence', () => {
        const report = compareLaneObservations({
            lane: 'coding',
            generatedAt: NOW,
            observations: [
                { ...local, evidenceType: 'synthetic' },
                { ...free, evidenceType: 'synthetic' }
            ]
        });
        expect(report.evidenceScope).toBe('synthetic');
        expect(report.policy.syntheticEvidenceIsNotPerformanceEvidence).toBe(true);
    });
});
