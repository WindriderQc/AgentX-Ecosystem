const {
    normalizeExecutionConfig,
    buildPromptHints,
    applyLengthHint
} = require('../../../src/services/benchmark/config');

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
});
