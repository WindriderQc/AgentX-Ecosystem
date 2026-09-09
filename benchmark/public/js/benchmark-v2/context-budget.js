import { esc } from './helpers.js';

// Catalog measurements describe eligible prompts, not a tokenizer measurement
// or a promise of success. Runtime context remains resolved by the server.
export function summarizeContextBudget(prompts, depth = {}, settings = {}) {
    const levels = [1, 2, 3, 4, 5].map(level => {
        const pool = (Array.isArray(prompts) ? prompts : []).filter(p => Number(p.level) === level);
        const expected = pool.map(p => Number(p.expected_tokens)).filter(n => n > 0);
        return {
            level, selected: depth[level] !== 'off', count: pool.length,
            maxChars: Math.max(0, ...pool.map(p => String(p.prompt || '').length)),
            expectedMin: expected.length ? Math.min(...expected) : null,
            expectedMax: expected.length ? Math.max(...expected) : null
        };
    });
    const positive = value => Number(value) > 0 ? Number(value) : null;
    const output = positive(settings.response_max_tokens);
    const context = positive(settings.force_num_ctx);
    const warnings = [];
    if (context && output >= context) warnings.push('The response limit leaves no reserved room for input in the requested context.');
    const expectedMax = Math.max(0, ...levels.filter(l => l.selected).map(l => l.expectedMax || 0));
    if (output && expectedMax > output) warnings.push('Some eligible prompts request a longer answer than the response limit allows.');
    return { levels, output, context, judgeContext: positive(settings.num_ctx), warnings };
}

export function renderContextBudget(budget) {
    const tokens = n => n == null ? 'Resolved at runtime' : `${n.toLocaleString('en-US')} tokens`;
    return `<div class="bf-budget-overview">
      <strong>Response limit: ${esc(tokens(budget.output))}</strong>
      <span>Execution context: ${esc(tokens(budget.context))}</span>
      <span>Judge context: ${esc(tokens(budget.judgeContext))}</span>
    </div>
    <p>Input, reasoning and the final answer share the context window. The response limit caps reasoning and answer together.</p>
    ${budget.warnings.map(w => `<p class="bf-budget-warning">${esc(w)}</p>`).join('')}
    <details class="bf-budget-details">
      <summary>Context needs by test level</summary>
      <p>Level measures difficulty, not length. These are the eligible catalog prompts; sampled runs may use shorter ones. No context size guarantees success.</p>
      <div class="bf-budget-levels">${budget.levels.map(l => `<div class="bf-budget-level${l.selected ? '' : ' is-off'}">
        <strong>L${l.level}${l.selected ? '' : ' · off'}</strong>
        <span>${l.count} prompts · ${l.maxChars.toLocaleString('en-US')} input characters max</span>
        <span>Expected answer: ${l.expectedMin == null ? 'not specified' : `${l.expectedMin}–${l.expectedMax} tokens`}</span>
      </div>`).join('')}</div>
      <p>Input counts exclude wrappers and custom hints. Expected answer lengths are prompt metadata, not measured requirements. The judge also needs room for the full answer, reference, instructions and its verdict. Use measured prompt tokens and output truncation in results to adjust the next run.</p>
    </details>`;
}

const listeners = new WeakMap();
export function wireContextBudget(container, prompts, readDepth, readSettings) {
    listeners.get(container)?.abort();
    const controller = new AbortController();
    listeners.set(container, controller);
    const refresh = () => {
        const panel = container.querySelector('#bv2-context-budget');
        if (!panel) return;
        const open = panel.querySelector('details')?.open;
        panel.innerHTML = renderContextBudget(summarizeContextBudget(prompts, readDepth(), readSettings()));
        if (open) panel.querySelector('details').open = true;
    };
    // Defer until persistence/preset handlers have finished updating the form.
    const schedule = () => queueMicrotask(refresh);
    container.addEventListener('config-changed', schedule, { signal: controller.signal });
    container.addEventListener('input', schedule, { signal: controller.signal });
    container.addEventListener('change', schedule, { signal: controller.signal });
    container.addEventListener('click', event => {
        if (event.target.closest('button')) schedule();
    }, { signal: controller.signal });
    refresh();
}
