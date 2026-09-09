const fs = require('fs');
const path = require('path');
const vm = require('vm');

const source = fs.readFileSync(path.resolve(__dirname, '../../public/js/benchmark-v2/context-budget.js'), 'utf8')
    .replace(/^import[^\n]+\n/gm, '').replace(/export function/g, 'function');
const context = vm.createContext({ esc: text => String(text) });
vm.runInContext(source + '\nglobalThis.api = { summarizeContextBudget, renderContextBudget };', context);
const { summarizeContextBudget, renderContextBudget } = context.api;

test('depth counts use the catalog, including empty levels and category sampling', () => {
    const formSource = fs.readFileSync(path.resolve(__dirname, '../../public/js/benchmark-v2/batch-config.js'), 'utf8')
        .replace(/^import[\s\S]*?from ['"][^'"]+['"];\r?\n/gm, '').replace(/export function/g, 'function');
    const form = vm.createContext({});
    vm.runInContext(formSource + `
        _promptCatalog = [{ level: 2, category: 'math' }, { level: 2, category: 'math' }, { level: 2, category: 'code' }];
        globalThis.count = _estimateCount;
    `, form);
    expect(form.count(2, 'full')).toBe(3);
    expect(form.count(2, 'light')).toBe(2);
    expect(form.count(2, 'single')).toBe(1);
    expect(form.count(2, 'off')).toBe(0);
    expect(form.count(1, 'single')).toBe(0);
});

test('difficulty and length stay independent, using the live eligible catalog', () => {
    const budget = summarizeContextBudget([
        { level: 1, prompt: 'x'.repeat(18000), expected_tokens: 2000 },
        { level: 1, prompt: 'short', expected_tokens: 10 },
        { level: 5, prompt: 'hard', expected_tokens: 20 }
    ], { 1: 'off', 5: 'single' }, { response_max_tokens: 1024, force_num_ctx: 8192 });
    expect(budget.levels[0]).toMatchObject({ count: 2, selected: false, maxChars: 18000, expectedMin: 10, expectedMax: 2000 });
    expect(budget.levels[4]).toMatchObject({ selected: true, maxChars: 4 });
    expect(budget.warnings).toHaveLength(0);
    expect(budget.context).toBe(8192);
    expect(budget.output).toBe(1024);
    expect(renderContextBudget(budget)).toContain('No context size guarantees success');
});

test('warns about incompatible requested budgets without changing either parameter', () => {
    const settings = Object.freeze({ response_max_tokens: 512, force_num_ctx: 512, num_ctx: 4096 });
    const budget = summarizeContextBudget([{ level: 2, prompt: 'task', expected_tokens: 1000 }], { 2: 'full' }, settings);
    expect(budget.warnings).toHaveLength(2);
    expect(budget).toMatchObject({ output: 512, context: 512, judgeContext: 4096 });
});

test('missing measurements remain unknown, including runtime-resolved contexts', () => {
    const budget = summarizeContextBudget(null, {}, {});
    expect(budget.context).toBeNull();
    expect(budget.judgeContext).toBeNull();
    expect(budget.levels[0].expectedMax).toBeNull();
    const html = renderContextBudget(budget);
    expect(html).toContain('Resolved at runtime');
    expect(html).toContain('not specified');
});
