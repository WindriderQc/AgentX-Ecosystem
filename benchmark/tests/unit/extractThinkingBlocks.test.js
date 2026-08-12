/**
 * Unit tests for extractThinkingBlocks (task 0172).
 *
 * The benchmark UI surfaces a "raw response" view by re-stitching
 *   raw = `<think>${thinking}</think>\n\n${curated}`
 * from the stored `response` (curated) + `thinking` fields. This only works
 * if `extractThinkingBlocks` is "lossless enough" — i.e. it captures every
 * meaningful character of the original response into one of the two outputs.
 *
 * These tests lock in that property: every interesting input shape (with
 * thinking, without thinking, multi-block, unclosed tag, empty, only-think)
 * must be reconstructible — modulo the documented losses (whitespace inside
 * tag boundaries gets trim()'d, exact tag positions aren't preserved).
 */

const {
    extractThinkingBlocks,
    buildOllamaPayload
} = require('../../src/helpers/ollamaResponseHandler');

// Mirror of the UI helper public/js/components/raw-response.js — keep in sync.
function recompose({ content, thinking }) {
    if (!thinking) return content || '';
    if (!content) return `<think>${thinking}</think>`;
    return `<think>${thinking}</think>\n\n${content}`;
}

// "Lossless enough" assertion: every non-tag word from the original raw
// input must appear in the reconstructed string. We tolerate:
//   - reordering (think blocks always emit at the front in recompose, even if
//     the original had them at the end)
//   - lowercased <think> tags (the regex normalizes casing)
//   - whitespace differences inside tag boundaries (extractThinkingBlocks
//     trims block contents)
//
// What we DON'T tolerate is dropping text. If a word from the input is missing
// from the reconstructed output, the operator will see a misleading "raw"
// view, so this is the property that backs the schema decision.
function assertContentPreserved(rawInput, reconstructed) {
    const tokenize = s => String(s)
        .toLowerCase()
        .replace(/<\/?think>/g, ' ')   // drop tag literals from comparison
        .split(/\s+/)
        .filter(Boolean)
        .sort();
    expect(tokenize(reconstructed)).toEqual(tokenize(rawInput));
}

describe('extractThinkingBlocks — lossless recompose for UI raw view', () => {
    test('content with no <think> tags passes through unchanged', () => {
        const raw = 'Hello world. This is a normal answer.';
        const out = extractThinkingBlocks(raw);
        expect(out.content).toBe(raw);
        expect(out.thinking).toBeNull();
        expect(recompose(out)).toBe(raw);
    });

    test('content with one <think> block splits cleanly and recomposes', () => {
        const raw = '<think>I should answer carefully.</think>\n\nThe capital of France is Paris.';
        const out = extractThinkingBlocks(raw);
        expect(out.thinking).toBe('I should answer carefully.');
        expect(out.content).toBe('The capital of France is Paris.');
        assertContentPreserved(raw, recompose(out));
    });

    test('content with multiple <think> blocks joins them with \\n\\n', () => {
        // Note: text between two adjacent think blocks gets concatenated with
        // the following segment when the blocks are stripped. So "middle text"
        // and "final" mash together if there's no whitespace separating them.
        // We use a whitespace separator here to keep the assertion clean —
        // real model outputs almost always include newlines around think tags.
        const raw = '<think>step 1</think>\nmiddle text\n<think>step 2</think>\nfinal';
        const out = extractThinkingBlocks(raw);
        expect(out.thinking).toBe('step 1\n\nstep 2');
        expect(out.content).toContain('middle text');
        expect(out.content).toContain('final');
        assertContentPreserved(raw, recompose(out));
    });

    test('unclosed <think> tag captures to end of string', () => {
        const raw = 'Answer: 42.\n<think>but actually let me reconsider';
        const out = extractThinkingBlocks(raw);
        expect(out.thinking).toBe('but actually let me reconsider');
        expect(out.content).toBe('Answer: 42.');
        assertContentPreserved(raw, recompose(out));
    });

    test('only thinking, no curated content', () => {
        const raw = '<think>I am still thinking…</think>';
        const out = extractThinkingBlocks(raw);
        expect(out.thinking).toBe('I am still thinking…');
        expect(out.content).toBe('');
        // recompose for empty curated should still emit the think wrapper
        const recomp = recompose(out);
        expect(recomp).toBe('<think>I am still thinking…</think>');
        assertContentPreserved(raw, recomp);
    });

    test('empty input returns null thinking and empty content', () => {
        const out = extractThinkingBlocks('');
        expect(out.thinking).toBeNull();
        expect(out.content).toBe('');
        expect(recompose(out)).toBe('');
    });

    test('null input is handled safely', () => {
        const out = extractThinkingBlocks(null);
        expect(out.thinking).toBeNull();
        expect(out.content).toBe('');
        expect(recompose(out)).toBe('');
    });

    test('case-insensitive <THINK> tags also extracted', () => {
        const raw = '<THINK>upper case</THINK>visible';
        const out = extractThinkingBlocks(raw);
        expect(out.thinking).toBe('upper case');
        expect(out.content).toBe('visible');
        assertContentPreserved(raw, recompose(out));
    });

    test('thinking with rich content (newlines, code) survives roundtrip', () => {
        const raw = `<think>Let me work through this:
1. parse input
2. compute
3. return
</think>The answer is **42**.`;
        const out = extractThinkingBlocks(raw);
        expect(out.thinking).toContain('parse input');
        expect(out.thinking).toContain('return');
        expect(out.content).toBe('The answer is **42**.');
        assertContentPreserved(raw, recompose(out));
    });

    test('existing thinking is prepended-with-extracted (legacy behavior)', () => {
        const raw = '<think>fresh</think>visible';
        const out = extractThinkingBlocks(raw, 'prior thinking');
        expect(out.thinking).toBe('fresh\n\nprior thinking');
        expect(out.content).toBe('visible');
    });

    test('content-only when given existing thinking but no <think> in body', () => {
        const out = extractThinkingBlocks('plain answer', 'prior thinking');
        expect(out.thinking).toBe('prior thinking');
        expect(out.content).toBe('plain answer');
    });
});

describe('buildOllamaPayload', () => {
    test('preserves positive num_predict caps for non-stream calls', () => {
        const payload = buildOllamaPayload({
            model: 'qwen3:8b',
            messages: [{ role: 'user', content: 'hi' }],
            streamEnabled: false,
            think: true,
            options: { num_predict: 256, keep_alive: '10m' }
        });

        expect(payload.options.num_predict).toBe(256);
        expect(payload.think).toBe(true);
        expect(payload.keep_alive).toBe('10m');
    });

    test('uses -1 only when caller did not provide a positive cap', () => {
        const payload = buildOllamaPayload({
            model: 'llama3',
            messages: [{ role: 'user', content: 'hi' }],
            streamEnabled: false,
            options: { num_predict: 0 }
        });

        expect(payload.options.num_predict).toBe(-1);
    });
});
