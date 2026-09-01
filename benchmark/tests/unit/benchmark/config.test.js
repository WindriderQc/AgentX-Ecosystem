const {
    normalizeExecutionConfig,
    buildPromptHints,
    applyLengthHint,
    buildBenchmarkTrustPromptSamplingPolicy
} = require('../../../src/services/benchmark/config');
const { fingerprint } = require('../../../../shared/workerContract');

describe('benchmark execution config prompt hints', () => {
    it('defaults execution thinking to auto and preserves explicit controls', () => {
        expect(normalizeExecutionConfig({}).think).toBe('auto');
        expect(normalizeExecutionConfig({ think: 'auto' }).think).toBe('auto');
        expect(normalizeExecutionConfig({ think: 'on' }).think).toBe(true);
        expect(normalizeExecutionConfig({ think: 'off' }).think).toBe(false);
        expect(normalizeExecutionConfig({ think: true }).think).toBe(true);
        expect(normalizeExecutionConfig({ think: false }).think).toBe(false);
    });

    it('records whether the output budget came from the caller or a compatibility default', () => {
        expect(normalizeExecutionConfig({}).response_max_tokens_source).toBe('default');
        expect(normalizeExecutionConfig({ response_max_tokens: 8192 }).response_max_tokens_source).toBe('caller');
        expect(normalizeExecutionConfig(normalizeExecutionConfig({})).response_max_tokens_source).toBe('default');
    });

    it('preserves measured and explicit contexts above the former 131K ceiling', () => {
        expect(normalizeExecutionConfig({}).num_ctx).toBeNull();
        expect(normalizeExecutionConfig({ num_ctx: 262144 }).num_ctx).toBe(262144);
        expect(normalizeExecutionConfig({ force_num_ctx: 202752 }).force_num_ctx).toBe(202752);
    });

    it('keeps controlled sampling by default and omits overrides for production qualification', () => {
        const controlled = normalizeExecutionConfig({});
        expect(controlled).toMatchObject({
            sampling_profile: 'controlled',
            sampling_source: 'controlled_override',
            temperature: 0.2,
            top_p: 0.9,
            top_k: 40,
            repeat_penalty: 1.1,
            seed: 42
        });

        const production = normalizeExecutionConfig({
            sampling_profile: 'production',
            temperature: 0,
            top_p: 0.1,
            top_k: 1,
            repeat_penalty: 2,
            seed: 7
        });
        expect(production).toMatchObject({
            sampling_profile: 'production',
            sampling_source: 'modelfile_default',
            temperature: null,
            top_p: null,
            top_k: null,
            repeat_penalty: null,
            seed: null
        });
    });

    it('adds a visible answer contract by default when expected_tokens exists', () => {
        const config = normalizeExecutionConfig({
            response_max_tokens: 4096,
            include_length_hint: false
        });

        const hints = buildPromptHints(
            'Design a distributed cache.',
            500,
            4096,
            config
        );

        expect(hints.applied).toBe(true);
        expect(hints.lengthHintApplied).toBe(false);
        expect(hints.answerContract).toMatchObject({
            applied: true,
            target_tokens: 500,
            max_tokens: 1000,
            mode: 'auto'
        });
        expect(hints.promptText).toContain('Answer contract: Target about 500 tokens');
        expect(hints.promptText).toContain('Stay under 1000 tokens');
    });

    it('does not add an automatic answer contract when explicitly disabled', () => {
        const config = normalizeExecutionConfig({
            response_max_tokens: 4096,
            answer_contract_mode: 'off',
            include_length_hint: false
        });

        const prompt = applyLengthHint('Design a distributed cache.', 500, 4096, config);

        expect(prompt).toBe('Design a distributed cache.');
    });

    it('keeps explicit length_hint_template behavior authoritative', () => {
        const config = normalizeExecutionConfig({
            response_max_tokens: 4096,
            include_length_hint: true,
            length_hint_template: 'Keep it below {max} tokens.'
        });

        const hints = buildPromptHints('Design a distributed cache.', 500, 4096, config);

        expect(hints.lengthHintApplied).toBe(true);
        expect(hints.answerContract.applied).toBe(false);
        expect(hints.promptText).toContain('Keep it below 4096 tokens.');
        expect(hints.promptText).not.toContain('Answer contract:');
    });

    it('adds a visible-final-answer contract when thinking is enabled', () => {
        const config = normalizeExecutionConfig({
            response_max_tokens: 8192,
            think: true,
            answer_contract_mode: 'off'
        });

        const hints = buildPromptHints(
            'Solve the scheduling problem.',
            0,
            8192,
            config
        );

        expect(hints.applied).toBe(true);
        expect(hints.thinkingFinalAnswerContract).toMatchObject({
            applied: true,
            mode: 'visible_required'
        });
        expect(hints.promptText).toContain('final answer must appear in the visible response');
        expect(hints.promptText).toContain('Hidden thinking is preserved for audit but is not scored');
    });

    it('allows operators to disable only the thinking visible-answer hint', () => {
        const config = normalizeExecutionConfig({
            response_max_tokens: 8192,
            think: true,
            answer_contract_mode: 'off',
            thinking_final_answer_policy: 'off'
        });

        const hints = buildPromptHints(
            'Solve the scheduling problem.',
            0,
            8192,
            config
        );

        expect(hints.applied).toBe(false);
        expect(hints.thinkingFinalAnswerContract).toMatchObject({
            applied: false,
            mode: 'off'
        });
    });

    it('fingerprints the exact Trust prompt universe and transformation policy', () => {
        const campaignArtifact = { schema: 'prompt-policy-test/v1', frozen: true };
        const prompts = ['a'.repeat(64), 'b'.repeat(64)];
        const baseline = buildBenchmarkTrustPromptSamplingPolicy(
            campaignArtifact,
            { response_max_tokens: 1024 },
            prompts
        );
        expect(baseline.promptTransformation).toMatchObject({
            implementationFingerprint: expect.stringMatching(/^[0-9a-f]{64}$/)
        });
        expect(baseline.promptTransformation).not.toHaveProperty('implementationSourceSha256');

        expect(fingerprint(buildBenchmarkTrustPromptSamplingPolicy(
            campaignArtifact,
            { response_max_tokens: 1024 },
            [...prompts].reverse()
        ))).toBe(fingerprint(baseline));
        expect(fingerprint(buildBenchmarkTrustPromptSamplingPolicy(
            campaignArtifact,
            { response_max_tokens: 1024, custom_hint: 'changed' },
            prompts
        ))).not.toBe(fingerprint(baseline));
        expect(fingerprint(buildBenchmarkTrustPromptSamplingPolicy(
            campaignArtifact,
            { response_max_tokens: 1024 },
            ['a'.repeat(64), 'c'.repeat(64)]
        ))).not.toBe(fingerprint(baseline));
        expect(() => buildBenchmarkTrustPromptSamplingPolicy(
            campaignArtifact,
            { response_max_tokens: 1024 },
            ['a'.repeat(64), 'a'.repeat(64)]
        )).toThrow(/must be unique/);
    });
});
