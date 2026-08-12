const fs = require('fs');
const path = require('path');

const promptPath = path.resolve(__dirname, '../../data/benchmark-prompts.json');
const prompts = JSON.parse(fs.readFileSync(promptPath, 'utf8'));

function tryParseJson(text) {
    try {
        return { ok: true, value: JSON.parse(text) };
    } catch (error) {
        return { ok: false, error };
    }
}

function joinedPromptText(prompt) {
    return [prompt.prompt, ...(prompt.judge_criteria || [])].join(' ').toLowerCase();
}

describe('Benchmark prompt alignment', () => {
    it('keeps any remaining deterministic json prompts backed by parseable JSON expected answers', () => {
        const jsonPrompts = prompts.filter(
            prompt => prompt.deterministic_scoring && prompt.deterministic_scoring.type === 'json'
        );

        for (const prompt of jsonPrompts) {
            expect(tryParseJson(prompt.expected_answer).ok).toBe(true);
        }
    });

    it('uses exact deterministic scoring for prompts that require strict whitespace or key order', () => {
        const strictPrompts = prompts.filter((prompt) => {
            const text = joinedPromptText(prompt);
            return text.includes('no extra whitespace') || text.includes('keys in this order');
        });

        for (const prompt of strictPrompts) {
            expect(prompt.deterministic_scoring).toBeTruthy();
            expect(prompt.deterministic_scoring.type).toBe('exact');
            expect(prompt.output_contract).toEqual({
                type: 'exact',
                template: prompt.expected_answer
            });
        }
    });

    it('keeps exact-scored instruction prompts backed by exact output contracts', () => {
        const exactInstructionPrompts = prompts.filter(
            prompt => prompt.category === 'instruction'
                && prompt.deterministic_scoring
                && prompt.deterministic_scoring.type === 'exact'
        );

        for (const prompt of exactInstructionPrompts) {
            expect(prompt.output_contract).toEqual({
                type: 'exact',
                template: prompt.expected_answer
            });
        }
    });

    it('keeps number-only math prompts aligned with numeric deterministic scoring', () => {
        const numberOnlyMathPrompts = prompts.filter(
            prompt => prompt.category === 'math'
                && prompt.output_contract
                && prompt.output_contract.type === 'number_only'
        );

        for (const prompt of numberOnlyMathPrompts) {
            expect(prompt.deterministic_scoring).toBeTruthy();
            expect(prompt.deterministic_scoring.type).toBe('numeric');
        }
    });

    it('attaches structured_text contracts to instruction prompts with explicit structure constraints', () => {
        const structuredPrompts = prompts.filter((prompt) => {
            if (prompt.category !== 'instruction') return false;
            const text = joinedPromptText(prompt);
            return text.includes('exactly two sentences')
                || text.includes('three sentences')
                || text.includes('three paragraphs')
                || text.includes('4-line')
                || text.includes('three bullet');
        });

        for (const prompt of structuredPrompts) {
            expect(prompt.output_contract).toBeTruthy();
            expect(prompt.output_contract.type).toBe('structured_text');
        }
    });

    it('keeps the DFA prompt aligned to a canonical JSON target', () => {
        const prompt = prompts.find((entry) => entry.name === 'DFA as JSON Specification');
        expect(prompt).toBeTruthy();
        expect(prompt.deterministic_scoring.type).toBe('exact');
        expect(prompt.output_contract.type).toBe('exact');
        expect(tryParseJson(prompt.expected_answer).ok).toBe(true);
    });
});
