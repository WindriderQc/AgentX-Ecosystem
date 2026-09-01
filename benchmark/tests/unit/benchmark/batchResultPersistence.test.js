jest.mock('../../../config/logger', () => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn()
}));

const savedDocs = [];
jest.mock('../../../models/BenchmarkResult', () => jest.fn().mockImplementation(function BenchmarkResult(doc) {
    Object.assign(this, doc);
    this._id = 'result-id';
    this.save = jest.fn(async () => {
        savedDocs.push(this);
        return this;
    });
}));

const {
    persistSuccessfulResult,
    persistFailedResult
} = require('../../../src/services/benchmark/batchResultPersistence');
const { normalizeBenchmarkTarget } = require('../../../../shared/benchmarkTargetContract');
const { computePromptSourceFingerprint } = require('../../../src/services/benchmark/benchmarkTrustSourceEvidence');
const { promptEvidenceRow } = require('../../../src/services/benchmark/benchmarkTrustCampaignRuntime');

const hex = character => character.repeat(64);

function trustTarget() {
    return normalizeBenchmarkTarget({
        id: 'trust-target', label: 'Trust target', executionKind: 'harness',
        mode: 'isolated_model', tier: 'free_cloud', provider: 'provider', model: 'test-model',
        modelVersion: '1', harness: { name: 'harness', version: '1' },
        adapter: { name: 'adapter', version: '1' },
        profile: { id: 'profile', version: '1', fingerprint: hex('1') },
        api: { name: 'api', version: '1' }, contextWindow: 131072,
        capabilities: { candidate: true, judge: true },
        pricing: {
            kind: 'free', currency: 'USD', source: 'fixture', effectiveAt: null,
            inputNanodollarsPerMillion: 0, outputNanodollarsPerMillion: 0, callNanodollars: 0
        },
        available: true, observedAt: '2026-09-01T00:00:00.000Z', catalogFingerprint: hex('2')
    });
}

function trustArgs(overrides = {}) {
    const target = trustTarget();
    const args = baseArgs({
        executionTarget: target,
        executionReceipt: { identity: { model: { digest: `sha256:${hex('3')}` } } },
        trustExecutionReceipt: { fingerprint: hex('4') },
        ...overrides
    });
    const promptFingerprint = computePromptSourceFingerprint(promptEvidenceRow(args.prompt, args.promptText));
    args.trustEvidenceContext = {
        candidates: [{
            candidateId: `candidate_${'a'.repeat(32)}`,
            sourceIdentity: { executionTargetFingerprint: target.fingerprint }
        }],
        prompts: [{ promptId: `prompt_${'b'.repeat(32)}`, fingerprint: promptFingerprint }]
    };
    return args;
}

function baseArgs(overrides = {}) {
    return {
        batchId: 'batch-id',
        judgeConfig: { model: 'judge-model' },
        queueBatchProgress: jest.fn(),
        flushBatchProgress: jest.fn(async () => {}),
        model: 'test-model',
        hostUrl: 'http://exec-host:11434',
        judgeHostUrl: 'http://judge-host:11434',
        prompt: {
            _id: 'prompt-id',
            name: 'Distributed Cache System Design',
            prompt: 'Design a distributed cache.',
            level: 5,
            category: 'reasoning',
            expected_answer: 'Complete architecture.',
            expected_tokens: 500
        },
        promptText: 'Design a distributed cache.',
        latency: 1000,
        tokens: 4096,
        tokensPerSec: 40,
        timeToFirstTokenMs: 100,
        cleanedResponse: 'partial answer',
        extractedThinking: null,
        hasEmptyResponse: false,
        responseTruncated: true,
        doneReason: 'length',
        numPredict: 4096,
        hintApplied: false,
        hintText: null,
        hardwareSnapshot: null,
        modelWarmupData: null,
        performanceBaseline: null,
        currentBatch: { completed: 0 },
        pendingModelTimeline: [],
        inputTruncated: false,
        promptEvalCount: 100,
        inputBudget: 12000,
        executionSettings: {},
        ...overrides
    };
}

describe('batchResultPersistence truncation quarantine', () => {
    beforeEach(() => {
        savedDocs.length = 0;
    });

    it('quarantines a response that hits a hidden runtime cap', async () => {
        await persistSuccessfulResult(baseArgs());

        const doc = savedDocs[0];
        expect(doc.needs_review).toBe(true);
        expect(doc.excluded_from_leaderboard).toBe(true);
        expect(doc.review_reason).toMatch(/hidden runtime token cap/);
        expect(doc.truncation).toMatchObject({
            response_truncated: true,
            hidden_response_cap: true,
            visible_response_budget: false,
            truncation_invalidates_score: true
        });
    });

    it('does not treat visible-budget truncation as a hidden cap', async () => {
        await persistSuccessfulResult(baseArgs({
            hintApplied: true,
            hintText: 'Answer contract: Target about 500 tokens.',
            lengthHintApplied: false,
            answerContract: {
                applied: true,
                text: 'Answer contract: Target about 500 tokens.',
                target_tokens: 500,
                max_tokens: 1000,
                mode: 'auto'
            }
        }));

        const doc = savedDocs[0];
        expect(doc.needs_review).toBe(false);
        expect(doc.excluded_from_leaderboard).toBe(false);
        expect(doc.truncation.hidden_response_cap).toBe(false);
        expect(doc.truncation.visible_response_budget).toBe(true);
    });

    it('records thinking-only output as an empty visible response without dropping the hidden reasoning', async () => {
        await persistSuccessfulResult(baseArgs({
            cleanedResponse: '',
            extractedThinking: 'internal chain of thought with no final answer',
            hasEmptyResponse: false,
            responseTruncated: false,
            doneReason: 'stop',
            executionSettings: {
                think: true,
                thinking_final_answer_policy: 'visible_required',
                thinking_final_answer_text: 'Final answer must be visible.'
            }
        }));

        const doc = savedDocs[0];
        expect(doc.response).toBe('');
        expect(doc.thinking).toBe('internal chain of thought with no final answer');
        expect(doc.quality_score).toBeNull();
        expect(doc.scoring_method).toBe('response_contract_failed');
        expect(doc.quality_explanation).toMatch(/no visible final answer/);
        expect(doc.needs_review).toBe(true);
        expect(doc.excluded_from_leaderboard).toBe(true);
        expect(doc.review_reason).toMatch(/hidden reasoning but no visible final answer/);
        expect(doc.truncation).toMatchObject({
            thinking_present: true,
            thinking_only_response: true,
            thinking_runaway: false,
            truncation_invalidates_score: false,
            visible_response_chars: 0
        });
        expect(doc.execution_settings).toMatchObject({
            think: true,
            thinking_final_answer_policy: 'visible_required',
            thinking_final_answer_text: 'Final answer must be visible.'
        });
    });

    it('invalidates visible-budget rows when thinking consumes the generation cap', async () => {
        await persistSuccessfulResult(baseArgs({
            cleanedResponse: 'partial final answer',
            extractedThinking: 'long hidden reasoning',
            hasEmptyResponse: false,
            responseTruncated: true,
            doneReason: 'length',
            hintApplied: true,
            hintText: 'Answer contract: Target about 500 tokens.',
            answerContract: {
                applied: true,
                text: 'Answer contract: Target about 500 tokens.',
                target_tokens: 500,
                max_tokens: 1000,
                mode: 'auto'
            },
            executionSettings: {
                think: true,
                thinking_final_answer_policy: 'visible_required'
            }
        }));

        const doc = savedDocs[0];
        expect(doc.quality_score).toBeNull();
        expect(doc.scoring_method).toBe('pending');
        expect(doc.needs_review).toBe(true);
        expect(doc.excluded_from_leaderboard).toBe(true);
        expect(doc.review_reason).toMatch(/generation token limit while hidden reasoning was present/);
        expect(doc.truncation).toMatchObject({
            response_truncated: true,
            hidden_response_cap: false,
            visible_response_budget: true,
            thinking_present: true,
            thinking_only_response: false,
            thinking_runaway: true,
            truncation_invalidates_score: true
        });
    });

    it('treats native-mode hidden reasoning without a final answer as a contract failure', async () => {
        await persistSuccessfulResult(baseArgs({
            cleanedResponse: '',
            extractedThinking: 'native hidden reasoning only',
            hasEmptyResponse: true,
            responseTruncated: false,
            doneReason: 'stop',
            executionSettings: {
                think: false,
                think_mode: 'native',
                rankable_mode: true
            }
        }));

        const doc = savedDocs[0];
        expect(doc.response).toBe('');
        expect(doc.thinking).toBe('native hidden reasoning only');
        expect(doc.quality_score).toBeNull();
        expect(doc.scoring_method).toBe('response_contract_failed');
        expect(doc.excluded_from_leaderboard).toBe(true);
        expect(doc.truncation.thinking_only_response).toBe(true);
    });

    it('quarantines thinking runaway even when no visible answer was produced', async () => {
        await persistSuccessfulResult(baseArgs({
            cleanedResponse: '',
            extractedThinking: 'hidden reasoning consumed the full generation budget',
            hasEmptyResponse: true,
            responseTruncated: true,
            doneReason: 'length',
            hintApplied: true,
            hintText: 'Keep your response under 8192 tokens.',
            lengthHintApplied: true,
            executionSettings: {
                think: true,
                thinking_final_answer_policy: 'visible_required'
            }
        }));

        const doc = savedDocs[0];
        expect(doc.quality_score).toBeNull();
        expect(doc.scoring_method).toBe('response_contract_failed');
        expect(doc.excluded_from_leaderboard).toBe(true);
        expect(doc.review_reason).toMatch(/hidden reasoning but no visible final answer/);
        expect(doc.review_reason).toMatch(/generation token limit while hidden reasoning was present/);
        expect(doc.truncation).toMatchObject({
            response_truncated: true,
            visible_response_budget: true,
            thinking_present: true,
            thinking_only_response: true,
            thinking_runaway: true,
            truncation_invalidates_score: true
        });
    });

    it('quarantines infra execution failures for rerun instead of leaderboard use', async () => {
        const args = baseArgs({
            err: new Error('request to http://core:3080/api/inference/generate failed, reason: getaddrinfo ENOTFOUND core'),
            errorDuration: 250,
            promptText: undefined
        });
        delete args.latency;
        delete args.tokens;
        delete args.tokensPerSec;
        delete args.timeToFirstTokenMs;
        delete args.cleanedResponse;
        delete args.extractedThinking;
        delete args.hasEmptyResponse;
        delete args.responseTruncated;
        delete args.doneReason;
        delete args.numPredict;
        delete args.hintApplied;
        delete args.hintText;
        delete args.hardwareSnapshot;
        delete args.modelWarmupData;
        delete args.performanceBaseline;
        delete args.inputTruncated;
        delete args.promptEvalCount;
        delete args.inputBudget;
        delete args.executionSettings;

        await persistFailedResult(args);

        const doc = savedDocs[0];
        expect(doc.success).toBe(false);
        expect(doc.infra_error).toBe(true);
        expect(doc.error_type).toBe('infra');
        expect(doc.needs_review).toBe(true);
        expect(doc.excluded_from_leaderboard).toBe(true);
        expect(doc.review_reason).toMatch(/Infrastructure failure/);
    });

    it('maps strict results to frozen opaque identities and retains the private WorkerReceipt', async () => {
        const args = trustArgs();
        await persistSuccessfulResult(args);

        const doc = savedDocs[0];
        expect(doc).toMatchObject({
            trust_candidate_id: `candidate_${'a'.repeat(32)}`,
            trust_prompt_id: `prompt_${'b'.repeat(32)}`,
            trust_execution_receipt: args.trustExecutionReceipt
        });
        expect(doc).not.toHaveProperty('timestamp');
    });

    it('fails closed before persistence when a strict result lacks its full WorkerReceipt', async () => {
        const args = trustArgs({ trustExecutionReceipt: null });
        await expect(persistSuccessfulResult(args)).rejects.toMatchObject({
            code: 'BENCHMARK_TRUST_EXECUTION_RECEIPT_REQUIRED'
        });
        expect(savedDocs).toHaveLength(0);
    });
});
