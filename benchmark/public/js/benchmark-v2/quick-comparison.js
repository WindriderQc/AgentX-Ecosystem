import { apiFetch } from '../utils/api.js';
import { getSelectedJudge } from './judge-roster.js';

const bindings = new WeakMap();

export function buildQuickComparison() {
    return `<section class="bf-quick-comparison" aria-labelledby="bv2-quick-title">
      <div><h3 id="bv2-quick-title">Start with a small comparison</h3>
        <p>Choose two prepared local models and a judge. Use their measured settings for a short Basic test.</p></div>
      <button type="button" id="bv2-quick-comparison">Quick comparison</button>
      <div id="bv2-quick-status" role="status" aria-live="polite"></div>
    </section>`;
}

export function wireQuickComparison(container, { host, apply }) {
    bindings.get(container)?.();
    const button = container.querySelector('#bv2-quick-comparison');
    const status = container.querySelector('#bv2-quick-status');
    let controller = null;
    let revision = 0;
    let applying = false;
    let applied = false;

    const invalidate = () => {
        if (applying) return;
        revision++;
        controller?.abort();
        controller = null;
        delete container.dataset.quickPending;
        button.disabled = false;
        if (applied || status.textContent) status.textContent = 'Settings changed. Use Quick comparison again to match the current selection, or continue with custom settings.';
        applied = false;
    };
    container.addEventListener('change', invalidate);
    container.addEventListener('input', invalidate);
    container.addEventListener('config-changed', invalidate);
    bindings.set(container, () => {
        invalidate();
        container.removeEventListener('change', invalidate);
        container.removeEventListener('input', invalidate);
        container.removeEventListener('config-changed', invalidate);
    });

    button.addEventListener('click', async () => {
        const selected = [...container.querySelectorAll('.bv2-model-cb:checked')];
        const judge = getSelectedJudge(container);
        if (selected.length !== 2 || selected.some(input => input.dataset.executionKind === 'harness') || judge.targetId) {
            status.textContent = 'Choose exactly two local models and a local judge. Use custom settings for other comparisons.';
            return;
        }
        const requestRevision = ++revision;
        controller?.abort();
        const request = new AbortController();
        controller = request;
        const timeout = setTimeout(() => request.abort(), 30000);
        container.dataset.quickPending = 'true';
        button.disabled = true;
        status.textContent = 'Checking the models’ measurements and selected judge…';
        try {
            const response = await apiFetch('/api/benchmark/quick-comparison', {
                method: 'POST', signal: request.signal,
                body: { host: host?.hostUrl || host?.url || '', models: selected.map(input => input.value), judge_config: judge }
            });
            if (requestRevision !== revision) return;
            applying = true;
            apply(response.data);
            applied = true;
            status.textContent = `${response.data.summary} Review the total below, then launch.${response.data.warning ? ' ' + response.data.warning : ''}`;
        } catch (error) {
            if (requestRevision !== revision) return;
            status.textContent = error.name === 'AbortError'
                ? 'The measurements check timed out. Try Quick comparison again.'
                : error.message;
        } finally {
            clearTimeout(timeout);
            applying = false;
            if (requestRevision === revision) {
                controller = null;
                button.disabled = false;
                delete container.dataset.quickPending;
            }
        }
    });
}
