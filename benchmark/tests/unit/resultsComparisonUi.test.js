const fs = require('fs');
const path = require('path');
const vm = require('vm');

const escape = value => String(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
function load() {
    const dialog = { showModal: jest.fn(), close: jest.fn() };
    const content = { innerHTML: '' };
    const context = vm.createContext({
        allResults: [], selectedResults: new Set(), _profilerHostMap: {},
        escapeHtml: escape, renderScore: value => value.toFixed(1),
        formatRecordedAt: () => 'Recorded date', renderEvidenceAge: () => 'Recent',
        document: { getElementById: id => id === 'comparisonModal' ? dialog : content }
    });
    vm.runInContext(fs.readFileSync(path.resolve(__dirname, '../../public/js/results-explorer-comparison.js'), 'utf8'), context);
    return { context, dialog, content };
}
const response = (overrides = {}) => ({
    _id: 'a', model: 'model-a', prompt: 'Plan a short walk.', response: 'Walk to the park.',
    batch_id: 'run-a', success: true, quality_score: 8, evidence_mode: 'judge_scored',
    scoring_method: 'llm_judge', latency: 2000, tokens_per_sec: 40, ...overrides
});

test('shows one exact shared prompt, both answers, and the selected sample size', () => {
    const { context } = load();
    const html = context.renderResponseComparison([response(), response({ model: 'model-b', response: 'Try the nature trail.', quality_score: null, evidence_mode: 'unscored' })]);
    expect(html.match(/Plan a short walk\./g)).toHaveLength(1);
    expect(html).toContain('Walk to the park.');
    expect(html).toContain('Try the nature trail.');
    expect(html).toContain('2 selected responses · 2 models · 1 with a recorded quality score');
    expect(html).not.toContain('Different or missing prompts');
});

test('matching names never imply matching prompt text or comparable runs and score sources', () => {
    const { context } = load();
    const html = context.renderResponseComparison([response({ prompt_name: 'Same name' }), response({ prompt_name: 'Same name', prompt: 'What is 2 + 2?', batch_id: 'other-run', evidence_mode: 'deterministic_only' })]);
    expect(html).toContain('Different or missing prompts');
    expect(html).toContain('Different runs are selected');
    expect(html).toContain('different kinds of scoring');
    expect(html).toContain('Plan a short walk.');
    expect(html).toContain('What is 2 + 2?');
    expect(html).toContain('Rule-based checks');
    expect(html).toContain('Judge scored');
});

test('zero measurements and scores stay zero; missing and invalid values stay unavailable', () => {
    const { context } = load();
    expect(context.comparisonNumber(0, ' ms')).toBe('0 ms');
    expect(context.comparisonScore(0)).toBe('0.0 / 10');
    for (const value of [null, undefined, '', NaN, Infinity, -1]) {
        expect(context.comparisonNumber(value)).toBe('Not recorded');
        expect(context.comparisonScore(value)).toBe('Not recorded');
    }
    expect(context.comparisonScore(11)).toBe('Not recorded');
    expect(context.comparisonScore(100, 100)).toBe('100.0 / 100');
});

test('a pending or failed judge score has an explicit state', () => {
    const { context } = load();
    expect(context.comparisonScoring({ evidence_mode: 'unscored', scoring_method: 'pending' })).toBe('Judging pending');
    expect(context.comparisonScoring({ evidence_mode: 'unscored', scoring_method: 'llm_failed' })).toBe('Judging failed');
});

test('reasoning is separate from a missing final answer and failure stays visible', () => {
    const { context } = load();
    const html = context.renderComparisonCard(response({ response: '', prompt: null, thinking: 'Partial reasoning', success: false, error: 'No final answer', quality_score: 0 }));
    expect(html).toContain('Prompt not recorded.');
    expect(html).toContain('No answer text recorded.');
    expect(html).toContain('<summary>Captured reasoning</summary>');
    expect(html).toContain('Partial reasoning');
    expect(html).toContain('Failed');
    expect(html).toContain('No final answer');
});

test('run details preserve numeric zero and expose the actual recorded settings', () => {
    const { context } = load();
    const html = context.renderComparisonCard(response({ execution_settings: { num_ctx: 8192, num_predict: 512, temperature: 0, seed: 0 }, judge_model: 'judge-c' }));
    expect(html).toContain('<summary>Scoring and run details</summary>');
    expect(html).toContain('8,192');
    expect(html).toContain('512');
    expect(html).toContain('<dt>Temperature</dt><dd>0</dd>');
    expect(html).toContain('<dt>Seed</dt><dd>0</dd>');
    expect(html).toContain('judge-c');
});

test('self-judging notice requires matching model and host and judge evidence', () => {
    const { context } = load();
    const record = response({ model: 'model-a:latest', judge_model: 'model-a', host: 'http://fixture/', judge_host: 'http://fixture' });
    expect(context.renderComparisonCard(record)).toContain('judged its own answer');
    expect(context.renderComparisonCard({ ...record, judge_host: 'http://different' })).not.toContain('judged its own answer');
    expect(context.renderComparisonCard({ ...record, evidence_mode: 'deterministic_only' })).not.toContain('judged its own answer');
});

test('human overrides and exclusions remain distinct from the original scoring method', () => {
    const { context } = load();
    const record = response({ evidence_mode: 'deterministic_only', scoring_method: 'deterministic', human_review_status: 'overridden', quality_score: 6 });
    expect(context.comparisonScoring(record)).toBe('Human override');
    const html = context.renderComparisonCard({ ...record, human_review_status: 'rejected', excluded_from_leaderboard: true, review_reason: 'Unsupported answer', judge_quality_score: 0 });
    expect(html).toContain('Excluded from rankings.');
    expect(html).toContain('Unsupported answer');
    expect(html).toContain('<dt>Human review</dt><dd>rejected</dd>');
    expect(html).toContain('<dt>Original judge score</dt><dd>0.0 / 10</dd>');
});

test('recorded text is displayed as text even when it contains markup', () => {
    const { context } = load();
    const payload = '<img src=x onerror="throw 1">';
    const html = context.renderComparisonCard(response({ model: payload, response: payload, prompt: payload, thinking: payload, quality_explanation: payload, host: payload, judge_model: payload, hardware_snapshot: { backend: payload, quantization: payload } }));
    expect(html).not.toContain(payload);
    expect(html).toContain(escape(payload));
});

test('comparison uses current selected records and native dialog lifecycle', () => {
    const { context, dialog, content } = load();
    context.allResults = [response(), response({ _id: 'b', model: 'model-b' }), response({ _id: 'c', response: 'Not selected' })];
    context.selectedResults = new Set(['a', 'b', 'no-longer-loaded']);
    context.openComparisonModal();
    expect(dialog.showModal).toHaveBeenCalledTimes(1);
    expect(content.innerHTML).toContain('2 selected responses');
    expect(content.innerHTML).not.toContain('Not selected');
    dialog.onclick({ target: content });
    expect(dialog.close).not.toHaveBeenCalled();
    dialog.onclick({ target: dialog });
    expect(dialog.close).toHaveBeenCalledTimes(1);
});

test.each([0, 1, 5])('does not open an unsupported %i-record comparison', count => {
    const { context, dialog } = load();
    context.allResults = Array.from({ length: count }, (_, index) => response({ _id: String(index) }));
    context.selectedResults = new Set(context.allResults.map(result => result._id));
    context.openComparisonModal();
    expect(dialog.showModal).not.toHaveBeenCalled();
});
