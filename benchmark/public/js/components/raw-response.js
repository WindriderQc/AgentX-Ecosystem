// raw-response.js — Helpers for rendering raw vs curated vs judge-raw response panes
//
// Background (task 0172):
//   The benchmark stores `response` as the curated text the judge consumed (with
//   <think>...</think> blocks already extracted into the `thinking` field). The
//   raw text Ollama returned is recoverable from `response + thinking` because
//   `extractThinkingBlocks` only splits/strips <think> tags; the textual content
//   is preserved (modulo trim() of inner whitespace and the literal tag chars).
//   See benchmark/src/helpers/ollamaResponseHandler.js + the unit test in
//   benchmark/tests/unit/extractThinkingBlocks.test.js.
//
// Public API:
//   - recomposeRawResponse(result): string — best-effort reconstruction of the
//     model's raw output before extractThinkingBlocks ran.
//   - hasNoContent(result): boolean — true when both curated and thinking are
//     empty, used to render the "model returned no content" placeholder.

// Local HTML escaper — matches the one in detail-panel utils. Keeping a copy
// avoids forcing every consumer to import the shared escHtml from utils/format.
function escapeHtml(str) {
    if (str == null) return '';
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

/**
 * Recompose the raw model response from curated text + extracted thinking.
 *
 * `extractThinkingBlocks` strips `<think>...</think>` blocks and trims the
 * inner content. We re-emit synthetic `<think>...</think>` wrappers so the
 * operator can see the full tokens stream the model produced. This is NOT a
 * byte-for-byte roundtrip (whitespace inside the original tags and the exact
 * tag positions are not preserved) but it captures every token of meaningful
 * output, which is what the diagnostic needs.
 *
 * @param {Object} result - BenchmarkResult document
 * @returns {string} reconstructed raw response (may be empty)
 */
export function recomposeRawResponse(result) {
    if (!result) return '';
    const curated = result.response || '';
    const thinking = result.thinking || '';
    if (!thinking) return curated;
    if (!curated) return `<think>${thinking}</think>`;
    return `<think>${thinking}</think>\n\n${curated}`;
}

/**
 * True when both curated response and thinking are empty.
 * Used to render the "model returned no content" placeholder for failure modes.
 */
export function hasNoContent(result) {
    if (!result) return true;
    const curated = (result.response || '').trim();
    const thinking = (result.thinking || '').trim();
    return curated === '' && thinking === '';
}

/**
 * Human-readable size badge: blank for 0, "Nc" for small, "N.Nk" for large.
 */
function fmtLen(n) {
    if (!n) return null; // empty — caller renders a dim dash
    if (n < 1000) return `${n}c`;
    return `${(n / 1000).toFixed(1)}k`;
}

/**
 * Build the three-pane "Raw / Curated / Judge raw" display HTML.
 *
 * Tabs are buttons with data-rrp-tab; panels are divs with data-rrp-panel.
 * Tab switching wiring lives in wireRawCuratedJudgePanes.
 *
 * @param {Object} result - BenchmarkResult document
 * @param {Object} [opts]
 * @param {string} [opts.idPrefix='rrp'] - DOM id namespace for multi-instance pages
 * @returns {string} HTML markup
 */
export function renderRawCuratedJudgePanes(result, opts = {}) {
    const idPrefix = opts.idPrefix || 'rrp';
    const curated = result?.response || '';
    const thinking = result?.thinking || '';
    const judgeRaw = result?.judge_raw_response || '';
    const raw = recomposeRawResponse(result);
    const empty = hasNoContent(result);
    const hasThinking = thinking.trim().length > 0;
    const rawSameAsCurated = raw === curated; // true when no thinking was extracted

    // ── Tab badges ──────────────────────────────────────────────────────────
    // Show human-readable char count; empty tabs get a dim "—"; when RAW and
    // CURATED are identical we badge RAW with "≡ curated" to make it obvious.
    const rawBadge = empty
        ? `<span class="rrp-tab-badge rrp-badge-empty">—</span>`
        : rawSameAsCurated
            ? `<span class="rrp-tab-badge rrp-badge-same" title="No thinking blocks — identical to Curated">≡ curated</span>`
            : `<span class="rrp-tab-badge">${fmtLen(raw.length)}</span>`;

    const curatedBadge = curated
        ? `<span class="rrp-tab-badge">${fmtLen(curated.length)}</span>`
        : `<span class="rrp-tab-badge rrp-badge-empty">—</span>`;

    const judgeBadge = judgeRaw
        ? `<span class="rrp-tab-badge">${fmtLen(judgeRaw.length)}</span>`
        : `<span class="rrp-tab-badge rrp-badge-empty">—</span>`;

    // ── Panel content ────────────────────────────────────────────────────────
    const rawPaneHTML = empty
        ? `<div class="rrp-empty">Model returned no content (response='', thinking='', tokens=${result?.tokens ?? 0})</div>`
        : `<pre class="rrp-pre">${escapeHtml(raw)}</pre>`;

    const curatedPaneHTML = curated
        ? `<pre class="rrp-pre">${escapeHtml(curated)}</pre>`
        : `<div class="rrp-empty">Curated response is empty${hasThinking ? ' — thinking is present, see Raw' : ''}</div>`;

    const judgePaneHTML = judgeRaw
        ? `<pre class="rrp-pre">${escapeHtml(judgeRaw)}</pre>`
        : `<div class="rrp-empty">No judge raw response captured — scoring was deterministic or judge output was not saved</div>`;

    // ── Contextual hints ──────────────────────────────────────────────────────
    // RAW: only mention thinking reconstruction when thinking was actually present.
    const rawHint = hasThinking
        ? 'Thinking blocks re-emitted as &lt;think&gt;…&lt;/think&gt; around the curated text. This is what the model generated before &lt;think&gt; stripping.'
        : rawSameAsCurated
            ? 'No thinking blocks were extracted — this is identical to the Curated tab.'
            : 'Verbatim model output.';

    const curatedHint = hasThinking
        ? '&lt;think&gt; blocks have been stripped. This is what the judge evaluated.'
        : 'This is the full model response — no thinking was present.';

    const judgeHint = judgeRaw
        ? 'Judge model verbatim output before score extraction. &lt;think&gt; reasoning (if any) shown as-is.'
        : 'Judge raw response is not available for deterministic or quick-score paths — no LLM was invoked.';

    return `<div class="rrp" id="${idPrefix}-root">
        <div class="rrp-tabs" role="tablist">
            <button class="rrp-tab is-active" data-rrp-tab="raw" role="tab" aria-selected="true">
                <span class="rrp-tab-main">RAW ${rawBadge}</span>
                <span class="rrp-tab-sub">model output</span>
            </button>
            <button class="rrp-tab" data-rrp-tab="curated" role="tab" aria-selected="false">
                <span class="rrp-tab-main">CURATED ${curatedBadge}</span>
                <span class="rrp-tab-sub">what judge saw</span>
            </button>
            <button class="rrp-tab" data-rrp-tab="judge" role="tab" aria-selected="false">
                <span class="rrp-tab-main">JUDGE RAW ${judgeBadge}</span>
                <span class="rrp-tab-sub">judge response</span>
            </button>
        </div>
        <div class="rrp-panels">
            <div class="rrp-panel is-active" data-rrp-panel="raw" role="tabpanel">
                ${rawPaneHTML}
                <div class="rrp-hint">${rawHint}</div>
            </div>
            <div class="rrp-panel" data-rrp-panel="curated" role="tabpanel" hidden>
                ${curatedPaneHTML}
                <div class="rrp-hint">${curatedHint}</div>
            </div>
            <div class="rrp-panel" data-rrp-panel="judge" role="tabpanel" hidden>
                ${judgePaneHTML}
                <div class="rrp-hint">${judgeHint}</div>
            </div>
        </div>
    </div>`;
}

/**
 * Wire the click handler that toggles the active tab/panel. Idempotent: safe
 * to call after each render.
 *
 * @param {HTMLElement} rootEl - the element returned in renderRawCuratedJudgePanes
 *   (or a parent containing it).
 */
export function wireRawCuratedJudgePanes(rootEl) {
    if (!rootEl) return;
    // Idempotency guard so callers that re-render their container on every
    // tick (e.g. live-detail.js) don't accumulate stacked listeners.
    if (rootEl.dataset.rrpWired === 'true') return;
    rootEl.dataset.rrpWired = 'true';
    rootEl.addEventListener('click', (e) => {
        const tab = e.target.closest('[data-rrp-tab]');
        if (!tab) return;
        const root = tab.closest('.rrp');
        if (!root) return;
        const which = tab.dataset.rrpTab;
        root.querySelectorAll('[data-rrp-tab]').forEach(t => {
            const active = t.dataset.rrpTab === which;
            t.classList.toggle('is-active', active);
            t.setAttribute('aria-selected', active ? 'true' : 'false');
        });
        root.querySelectorAll('[data-rrp-panel]').forEach(p => {
            const active = p.dataset.rrpPanel === which;
            p.classList.toggle('is-active', active);
            if (active) p.removeAttribute('hidden');
            else p.setAttribute('hidden', '');
        });
    });
}
