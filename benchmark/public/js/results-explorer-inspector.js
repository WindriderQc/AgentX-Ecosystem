// Results Explorer — Test Inspector
// Continuation of results-explorer.js — loaded last in results-explorer.html

// ─── Raw / Curated / Judge-raw helpers (task 0172) ─────────────────────────
// Mirrors public/js/components/raw-response.js (which is an ES module and
// can't be imported here without a bigger refactor of how this file is
// loaded). Keep behavior in sync if you change one.
function _rrpRecompose(r) {
    if (!r) return '';
    const curated = r.response || '';
    const thinking = r.thinking || '';
    if (!thinking) return curated;
    if (!curated) return `<think>${thinking}</think>`;
    return `<think>${thinking}</think>\n\n${curated}`;
}

function _rrpHasNoContent(r) {
    if (!r) return true;
    return (r.response || '').trim() === '' && (r.thinking || '').trim() === '';
}

function renderRawCuratedJudgePanesHTML(r, idPrefix) {
    const curated = r?.response || '';
    const thinking = r?.thinking || '';
    const judgeRaw = r?.judge_raw_response || '';
    const raw = _rrpRecompose(r);
    const empty = _rrpHasNoContent(r);

    const rawPaneHTML = empty
        ? `<div class="rrp-empty">model returned no content (response='', thinking='', tokens=${r?.tokens ?? 0})</div>`
        : `<pre class="rrp-pre">${escapeHtml(raw)}</pre>`;
    const curatedPaneHTML = curated
        ? `<pre class="rrp-pre">${escapeHtml(curated)}</pre>`
        : `<div class="rrp-empty">curated response is empty${thinking ? ' (thinking present — see Raw)' : ''}</div>`;
    const judgePaneHTML = judgeRaw
        ? `<pre class="rrp-pre">${escapeHtml(judgeRaw)}</pre>`
        : `<div class="rrp-empty">no judge raw response captured</div>`;

    return `<div class="rrp" id="${idPrefix}-root">
        <div class="rrp-tabs" role="tablist">
            <button class="rrp-tab is-active" data-rrp-tab="raw" role="tab" aria-selected="true">Raw <span class="rrp-tab-len">${raw.length}</span></button>
            <button class="rrp-tab" data-rrp-tab="curated" role="tab" aria-selected="false">Curated <span class="rrp-tab-len">${curated.length}</span></button>
            <button class="rrp-tab" data-rrp-tab="judge" role="tab" aria-selected="false">Judge raw <span class="rrp-tab-len">${judgeRaw.length}</span></button>
        </div>
        <div class="rrp-panels">
            <div class="rrp-panel is-active" data-rrp-panel="raw" role="tabpanel">
                ${rawPaneHTML}
                <div class="rrp-hint">Reconstructed from curated + thinking. &lt;think&gt; tags re-emitted around extracted reasoning.</div>
            </div>
            <div class="rrp-panel" data-rrp-panel="curated" role="tabpanel" hidden>
                ${curatedPaneHTML}
                <div class="rrp-hint">This is what the judge actually scored.</div>
            </div>
            <div class="rrp-panel" data-rrp-panel="judge" role="tabpanel" hidden>
                ${judgePaneHTML}
                <div class="rrp-hint">Raw judge model output before parsing. &lt;think&gt; blocks (if any) shown verbatim.</div>
            </div>
        </div>
    </div>`;
}

function wireRawCuratedJudgePanesGlobal(rootEl) {
    if (!rootEl || rootEl.dataset.rrpWired === 'true') return;
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

// Open Test Inspector modal
async function openTestInspector(resultId) {
    const modal = document.getElementById('testInspectorModal');
    const content = document.getElementById('inspectorContent');

    // Show loading state
    content.innerHTML = `
        <div class="inspector-loading">
            <i class="fas fa-spinner fa-spin"></i>
            <p>Loading test details...</p>
        </div>
    `;
    modal.style.display = 'block';

    try {
        // Fetch full result details
        const response = await fetch(`/api/benchmark/results/${resultId}`);
        if (!response.ok) throw new Error('Failed to fetch result details');

        const data = await response.json();
        currentInspectorResult = data.data;

        // Set default tab
        currentInspectorTab = 'warmup';

        // Render content
        renderInspectorContent();
        setupInspectorTabs();

    } catch (error) {
        console.error('Error loading result details:', error);
        content.innerHTML = `
            <div class="error-state">
                <i class="fas fa-exclamation-triangle"></i>
                <p>Failed to load test details: ${escapeHtml(error.message)}</p>
            </div>
        `;
    }
}

// Setup tab click handlers
function setupInspectorTabs() {
    document.querySelectorAll('.inspector-tab').forEach(tab => {
        tab.addEventListener('click', () => {
            const tabName = tab.dataset.tab;
            currentInspectorTab = tabName;

            // Update active tab
            document.querySelectorAll('.inspector-tab').forEach(t => t.classList.remove('active'));
            tab.classList.add('active');

            // Re-render content
            renderInspectorContent();
        });
    });
}

// Render inspector content based on current tab
function renderInspectorContent() {
    const content = document.getElementById('inspectorContent');
    const r = currentInspectorResult;

    if (!r) {
        content.innerHTML = '<div class="no-data"><i class="fas fa-database"></i><p>No data available</p></div>';
        return;
    }

    let html = '';

    switch (currentInspectorTab) {
        case 'warmup':
            html = renderWarmupTab(r);
            break;
        case 'execution':
            html = renderExecutionTab(r);
            break;
        case 'judging':
            html = renderJudgingTab(r);
            break;
        case 'hardware':
            html = renderHardwareTab(r);
            break;
    }

    content.innerHTML = `${renderInspectorEvidenceNotice(r)}${html}`;

    // Wire Raw / Curated / Judge-raw tab toggles (task 0172). Each .rrp root
    // gets its own delegate; wireRawCuratedJudgePanesGlobal is idempotent via
    // a data-rrp-wired marker.
    content.querySelectorAll('.rrp').forEach(wireRawCuratedJudgePanesGlobal);

    // Setup copy buttons
    content.querySelectorAll('.copy-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            const targetId = btn.dataset.target;
            const textEl = document.getElementById(targetId);
            if (textEl) {
                navigator.clipboard.writeText(textEl.textContent);
                btn.innerHTML = '<i class="fas fa-check"></i> Copied';
                setTimeout(() => btn.innerHTML = '<i class="fas fa-copy"></i> Copy', 2000);
            }
        });
    });
}

function renderInspectorEvidenceNotice(result) {
    const exactRecordedAt = formatRecordedAt(result);
    return `
        <aside class="inspector-evidence-notice result-era-${result.evidence_era || 'undated'}" aria-label="Result evidence age">
            ${renderEvidenceAge(result)}
            <div>
                <strong>Recorded ${exactRecordedAt}</strong>
                <span>Age band uses only this timestamp: recent ≤30 days, aging 31–90 days, historical 91+ days.</span>
            </div>
        </aside>
    `;
}

// Render Warmup tab
function renderWarmupTab(r) {
    const warmup = r.warmup;
    const judgeWarmup = r.judge_warmup;

    return `
        <!-- Model Warmup Phase -->
        <div class="phase-card">
            <div class="phase-header">
                <h3><i class="fas fa-fire"></i> Model Warmup</h3>
                <span class="phase-status ${warmup?.response ? 'success' : 'pending'}">
                    <i class="fas fa-${warmup?.response ? 'check-circle' : 'clock'}"></i>
                    ${warmup?.response ? 'Completed' : 'No data captured'}
                </span>
            </div>
            <div class="phase-body">
                ${warmup ? `
                    <div class="prompt-response-pair">
                        <div class="prompt-block">
                            <div class="block-header">
                                <h4><i class="fas fa-arrow-right"></i> Warmup Prompt</h4>
                                <button class="copy-btn" data-target="warmup-prompt"><i class="fas fa-copy"></i> Copy</button>
                            </div>
                            <div class="block-content" id="warmup-prompt">${escapeHtml(warmup.prompt || 'N/A')}</div>
                        </div>
                        <div class="response-block">
                            <div class="block-header">
                                <h4><i class="fas fa-arrow-left"></i> Warmup Response</h4>
                                <button class="copy-btn" data-target="warmup-response"><i class="fas fa-copy"></i> Copy</button>
                            </div>
                            <div class="block-content" id="warmup-response">${escapeHtml(warmup.response || 'N/A')}</div>
                        </div>
                    </div>
                    <div class="metrics-grid">
                        <div class="metric-card">
                            <div class="metric-label">Warmup Latency</div>
                            <div class="metric-value">${warmup.latency_ms ? warmup.latency_ms.toFixed(0) + ' ms' : 'N/A'}</div>
                        </div>
                        <div class="metric-card">
                            <div class="metric-label">Already Loaded</div>
                            <div class="metric-value ${warmup.already_loaded ? 'positive' : 'warning'}">
                                ${warmup.already_loaded === null ? 'Unknown' : (warmup.already_loaded ? 'Yes' : 'No')}
                            </div>
                        </div>
                    </div>
                ` : `
                    <div class="no-data">
                        <i class="fas fa-info-circle"></i>
                        <p>Model warmup data was not captured for this test.</p>
                        <p style="font-size: 0.875rem; opacity: 0.7; margin-top: 0.5rem;">
                            This may be from a batch run before warmup capture was enabled.
                        </p>
                    </div>
                `}
            </div>
        </div>

        <!-- Judge Warmup Phase -->
        ${r.judge_model ? `
        <div class="phase-card">
            <div class="phase-header">
                <h3><i class="fas fa-gavel"></i> Judge Warmup</h3>
                <span class="phase-status ${judgeWarmup?.response ? 'success' : 'pending'}">
                    <i class="fas fa-${judgeWarmup?.response ? 'check-circle' : 'clock'}"></i>
                    ${judgeWarmup?.response ? 'Completed' : 'No data captured'}
                </span>
            </div>
            <div class="phase-body">
                ${judgeWarmup ? `
                    <div class="prompt-response-pair">
                        <div class="prompt-block">
                            <div class="block-header">
                                <h4><i class="fas fa-arrow-right"></i> Warmup Prompt</h4>
                            </div>
                            <div class="block-content">${escapeHtml(judgeWarmup.prompt || 'N/A')}</div>
                        </div>
                        <div class="response-block">
                            <div class="block-header">
                                <h4><i class="fas fa-arrow-left"></i> Warmup Response</h4>
                            </div>
                            <div class="block-content">${escapeHtml(judgeWarmup.response || 'N/A')}</div>
                        </div>
                    </div>
                    <div class="metrics-grid">
                        <div class="metric-card">
                            <div class="metric-label">Warmup Latency</div>
                            <div class="metric-value">${judgeWarmup.latency_ms ? judgeWarmup.latency_ms.toFixed(0) + ' ms' : 'N/A'}</div>
                        </div>
                        <div class="metric-card">
                            <div class="metric-label">Already Loaded</div>
                            <div class="metric-value ${judgeWarmup.already_loaded ? 'positive' : 'warning'}">
                                ${judgeWarmup.already_loaded === null ? 'Unknown' : (judgeWarmup.already_loaded ? 'Yes' : 'No')}
                            </div>
                        </div>
                    </div>
                ` : `
                    <div class="no-data">
                        <i class="fas fa-info-circle"></i>
                        <p>Judge warmup data was not captured for this test.</p>
                    </div>
                `}
            </div>
        </div>
        ` : ''}
    `;
}

// Render Execution tab
function renderExecutionTab(r) {
    return `
        <div class="phase-card">
            <div class="phase-header">
                <h3><i class="fas fa-play"></i> Test Execution</h3>
                <span class="phase-status ${r.success ? 'success' : 'failed'}">
                    <i class="fas fa-${r.success ? 'check-circle' : 'times-circle'}"></i>
                    ${r.success ? 'Success' : 'Failed'}
                </span>
            </div>
            <div class="phase-body">
                <!-- Test Metadata -->
                <div class="metrics-grid" style="margin-bottom: 1.5rem;">
                    <div class="metric-card">
                        <div class="metric-label">Model</div>
                        <div class="metric-value" style="font-size: 1rem;">${escapeHtml(r.model)}</div>
                    </div>
                    <div class="metric-card">
                        <div class="metric-label">Category</div>
                        <div class="metric-value" style="font-size: 1rem;">${r.prompt_category || 'N/A'}</div>
                    </div>
                    <div class="metric-card">
                        <div class="metric-label">Level</div>
                        <div class="metric-value">${r.prompt_level || 'N/A'}</div>
                    </div>
                    <div class="metric-card">
                        <div class="metric-label">Prompt Name</div>
                        <div class="metric-value" style="font-size: 0.875rem;">${escapeHtml(r.prompt_name || 'N/A')}</div>
                    </div>
                </div>

                <!-- Prompt Hint (if applied) -->
                ${r.execution_settings?.hint_text ? `
                <div class="hint-banner" style="display: flex; align-items: center; gap: 8px; padding: 8px 12px; margin-bottom: 12px; background: linear-gradient(90deg, rgba(34, 197, 94, 0.15), rgba(34, 197, 94, 0.05)); border: 1px solid rgba(34, 197, 94, 0.3); border-radius: 6px; font-size: 0.85rem;">
                    <i class="fas fa-magic" style="color: #22c55e;"></i>
                    <span style="color: var(--muted);">Hint appended:</span>
                    <code style="background: rgba(0,0,0,0.2); padding: 2px 8px; border-radius: 4px; color: #22c55e; font-size: 0.8rem;">${escapeHtml(r.execution_settings.hint_text)}</code>
                </div>
                ` : ''}

                <!-- Prompt and Response (three-pane raw / curated / judge-raw, task 0172) -->
                <div class="prompt-response-pair">
                    <div class="prompt-block">
                        <div class="block-header">
                            <h4><i class="fas fa-comment"></i> Test Prompt</h4>
                            <button class="copy-btn" data-target="test-prompt"><i class="fas fa-copy"></i> Copy</button>
                        </div>
                        <div class="block-content" id="test-prompt">${escapeHtml(r.prompt || 'N/A')}</div>
                    </div>
                    <div class="response-block">
                        <div class="block-header">
                            <h4><i class="fas fa-reply"></i> Model Response</h4>
                        </div>
                        ${renderRawCuratedJudgePanesHTML(r, 'rxp-rrp')}
                    </div>
                </div>

                ${r.expected_answer ? `
                <div style="margin-top: 1rem;">
                    <div class="prompt-block" style="width: 100%;">
                        <div class="block-header">
                            <h4><i class="fas fa-bullseye"></i> Expected Answer</h4>
                        </div>
                        <div class="block-content">${escapeHtml(r.expected_answer)}</div>
                    </div>
                </div>
                ` : ''}

                <!-- Performance Metrics -->
                <div class="metrics-grid" style="margin-top: 1.5rem;">
                    <div class="metric-card">
                        <div class="metric-label">Latency</div>
                        <div class="metric-value">${r.latency ? r.latency.toFixed(0) + ' ms' : 'N/A'}</div>
                    </div>
                    <div class="metric-card">
                        <div class="metric-label">Tokens Generated</div>
                        <div class="metric-value">${r.tokens || 'N/A'}</div>
                    </div>
                    <div class="metric-card">
                        <div class="metric-label">Token Limit</div>
                        <div class="metric-value ${r.truncation?.response_truncated ? 'negative' : ''}">${r.truncation?.response_limit || 'N/A'}</div>
                    </div>
                    <div class="metric-card">
                        <div class="metric-label">Tokens/sec</div>
                        <div class="metric-value">${r.tokens_per_sec ? parseFloat(r.tokens_per_sec).toFixed(1) : 'N/A'}</div>
                    </div>
                    <div class="metric-card">
                        <div class="metric-label">Host</div>
                        <div class="metric-value" style="font-size: 0.875rem;">${escapeHtml(r.host || 'N/A')}</div>
                    </div>
                </div>

                ${r.truncation?.response_truncated ? `
                <div class="truncation-warning">
                    <i class="fas fa-exclamation-triangle"></i>
                    <span>Response was truncated at ${r.truncation.response_tokens} tokens (limit: ${r.truncation.response_limit})</span>
                </div>
                ` : ''}

            </div>
        </div>
    `;
}

// Render Judging tab
function renderJudgingTab(r) {
    const hasJudging = r.scoring_method && r.scoring_method !== 'disabled' && r.scoring_method !== 'pending';

    if (!hasJudging) {
        const canRejudge = r.scoring_method === 'pending' && r.success && r.response;
        return `
            <div class="phase-card">
                <div class="phase-header">
                    <h3><i class="fas fa-gavel"></i> Quality Judging</h3>
                    <span class="phase-status pending">
                        <i class="fas fa-minus-circle"></i>
                        ${r.scoring_method === 'disabled' ? 'Disabled' : 'Pending'}
                    </span>
                </div>
                <div class="phase-body">
                    <div class="no-data">
                        <i class="fas fa-gavel"></i>
                        <p>Quality scoring was ${r.scoring_method === 'disabled' ? 'not enabled' : 'not completed'} for this test.</p>
                        ${canRejudge ? `
                        <button class="rejudge-btn" onclick="rejudgeResult('${r._id}')" style="margin-top: 1rem; padding: 0.75rem 1.5rem; background: var(--primary, #6366f1); color: white; border: none; border-radius: 6px; cursor: pointer; font-weight: 500;">
                            <i class="fas fa-redo"></i> Run Judging Now
                        </button>
                        <p style="font-size: 0.75rem; color: var(--muted); margin-top: 0.5rem;">This will evaluate the response with the judge model.</p>
                        ` : ''}
                    </div>
                </div>
            </div>
        `;
    }

    const testDuration = r.latency || 0;
    const judgeDuration = r.scoring_time_ms || 0;
    const totalDuration = testDuration + judgeDuration;

    return `
        <div class="phase-card">
            <div class="phase-header">
                <h3><i class="fas fa-gavel"></i> Quality Judging</h3>
                <span class="phase-status ${r.scoring_method === 'llm_failed' ? 'failed' : 'success'}">
                    <i class="fas fa-${r.scoring_method === 'llm_failed' ? 'times-circle' : 'check-circle'}"></i>
                    ${r.scoring_method === 'llm_failed' ? 'Failed' : 'Completed'}
                </span>
            </div>
            <div class="phase-body">
                <!-- Session Timing Comparison -->
                <h4 style="margin: 0 0 1rem 0; color: var(--primary, #6366f1);">
                    <i class="fas fa-clock"></i> Session Timing
                </h4>
                <div class="timing-comparison" style="display: grid; grid-template-columns: 1fr 1fr; gap: 1rem; margin-bottom: 1.5rem; padding: 1rem; background: rgba(0,0,0,0.2); border-radius: 8px;">
                    <div style="text-align: center; padding: 1rem; background: rgba(99, 102, 241, 0.1); border-radius: 6px; border: 1px solid rgba(99, 102, 241, 0.2);">
                        <div style="font-size: 0.75rem; color: var(--muted); margin-bottom: 0.5rem;"><i class="fas fa-robot"></i> TEST EXECUTION</div>
                        <div style="font-size: 1.5rem; font-weight: 600; color: var(--text);">${testDuration ? (testDuration / 1000).toFixed(2) + 's' : 'N/A'}</div>
                        <div style="font-size: 0.7rem; color: var(--muted); margin-top: 0.25rem;">${r.tokens || 0} tokens @ ${r.tokens_per_sec ? parseFloat(r.tokens_per_sec).toFixed(1) : '?'} tok/s</div>
                    </div>
                    <div style="text-align: center; padding: 1rem; background: rgba(168, 85, 247, 0.1); border-radius: 6px; border: 1px solid rgba(168, 85, 247, 0.2);">
                        <div style="font-size: 0.75rem; color: var(--muted); margin-bottom: 0.5rem;"><i class="fas fa-gavel"></i> JUDGE EVALUATION</div>
                        <div style="font-size: 1.5rem; font-weight: 600; color: var(--text);">${judgeDuration ? (judgeDuration / 1000).toFixed(2) + 's' : 'N/A'}</div>
                        <div style="font-size: 0.7rem; color: var(--muted); margin-top: 0.25rem;">Total: ${(totalDuration / 1000).toFixed(2)}s</div>
                    </div>
                </div>

                <!-- Session Parameters -->
                <h4 style="margin: 1rem 0; color: var(--primary, #6366f1);">
                    <i class="fas fa-cog"></i> Session Parameters
                </h4>
                <div class="metrics-grid" style="margin-bottom: 1.5rem;">
                    <div class="metric-card">
                        <div class="metric-label">Test Model</div>
                        <div class="metric-value" style="font-size: 0.8rem;">${escapeHtml(r.model || 'N/A')}</div>
                    </div>
                    <div class="metric-card">
                        <div class="metric-label">Test Host</div>
                        <div class="metric-value" style="font-size: 0.8rem;">${escapeHtml(r.host || 'N/A')}</div>
                    </div>
                    <div class="metric-card">
                        <div class="metric-label">Token Limit (num_predict)</div>
                        <div class="metric-value">${r.execution_settings?.num_predict || r.truncation?.response_limit || 'N/A'}</div>
                    </div>
                    <div class="metric-card">
                        <div class="metric-label">Tokens Generated</div>
                        <div class="metric-value">${r.tokens || 'N/A'}</div>
                    </div>
                    <div class="metric-card">
                        <div class="metric-label">Judge Model</div>
                        <div class="metric-value" style="font-size: 0.8rem;">${escapeHtml(r.judge_model || 'N/A')}</div>
                    </div>
                    <div class="metric-card">
                        <div class="metric-label">Judge Host</div>
                        <div class="metric-value" style="font-size: 0.8rem;">${escapeHtml(r.judge_host || 'Same as test')}</div>
                    </div>
                    <div class="metric-card">
                        <div class="metric-label">Scoring Method</div>
                        <div class="metric-value" style="font-size: 0.875rem;">${r.scoring_method || 'N/A'}</div>
                    </div>
                    <div class="metric-card">
                        <div class="metric-label">Scoring Type</div>
                        <div class="metric-value" style="font-size: 0.875rem;">${r.scoring_type || 'N/A'}</div>
                    </div>
                </div>

                <!-- Scoring Results -->
                <h4 style="margin: 1.5rem 0 1rem 0; color: var(--primary, #6366f1);">
                    <i class="fas fa-star"></i> Scoring Results
                </h4>
                <div class="metrics-grid" style="margin-bottom: 1rem;">
                    <div class="metric-card">
                        <div class="metric-label">
                            Quality Score
                            <i class="fas fa-info-circle" style="margin-left: 4px; cursor: help; opacity: 0.6;" title="0-10 scale. Evaluated by the judge LLM based on category-specific dimensions (e.g., accuracy, clarity, completeness). Higher is better."></i>
                        </div>
                        <div class="metric-value ${getScoreClass(r.quality_score)}">${r.quality_score !== null ? r.quality_score.toFixed(1) : 'N/A'}<span style="font-size: 0.6rem; color: var(--muted);"> / 10</span></div>
                    </div>
                    <div class="metric-card">
                        <div class="metric-label">
                            Composite Score
                            <i class="fas fa-info-circle" style="margin-left: 4px; cursor: help; opacity: 0.6;" title="0-100 scale. Weighted combination of Quality (×10), Latency (faster=higher), and Speed (tok/s). Weights vary by prompt category."></i>
                        </div>
                        <div class="metric-value">${r.composite_score !== null ? r.composite_score.toFixed(1) : 'N/A'}<span style="font-size: 0.6rem; color: var(--muted);"> / 100</span></div>
                    </div>
                </div>

                <!-- Score Explanation -->
                <div style="padding: 0.75rem 1rem; background: rgba(99, 102, 241, 0.1); border-radius: 6px; border-left: 3px solid var(--primary, #6366f1); margin-bottom: 1.5rem; font-size: 0.75rem; color: var(--muted);">
                    <strong style="color: var(--text);">How scores are calculated:</strong><br>
                    <strong>Quality Score (0-10):</strong> LLM judge evaluates response against category-specific criteria (accuracy, logic, clarity, etc.).<br>
                    <strong>Composite Score (0-100):</strong> = Quality×${r.composite_profile_used?.includes('reasoning') || r.prompt_category === 'reasoning' ? '80%' : r.composite_profile_used?.includes('coding') || r.prompt_category === 'coding' ? '60%' : '40-80%'} + Latency×${r.composite_profile_used?.includes('reasoning') ? '10%' : '10-40%'} + Speed×${r.composite_profile_used?.includes('reasoning') ? '10%' : '10-20%'} (weights depend on <em>${r.prompt_category || 'category'}</em>)
                </div>

                ${r.judge_warmup ? `
                <!-- Judge Warmup Info -->
                <h4 style="margin: 1.5rem 0 1rem 0; color: var(--primary, #6366f1);">
                    <i class="fas fa-fire"></i> Judge Warmup
                </h4>
                <div class="metrics-grid" style="margin-bottom: 1rem;">
                    <div class="metric-card">
                        <div class="metric-label">Warmup Latency</div>
                        <div class="metric-value">${r.judge_warmup.latency_ms ? (r.judge_warmup.latency_ms / 1000).toFixed(2) + 's' : 'N/A'}</div>
                    </div>
                    <div class="metric-card">
                        <div class="metric-label">Already Loaded</div>
                        <div class="metric-value" style="color: ${r.judge_warmup.already_loaded ? '#22c55e' : '#f59e0b'};">
                            ${r.judge_warmup.already_loaded === null ? 'Unknown' : (r.judge_warmup.already_loaded ? 'Yes' : 'No')}
                        </div>
                    </div>
                </div>
                ${r.judge_warmup.prompt ? `
                <details style="margin-bottom: 1rem;">
                    <summary style="cursor: pointer; color: var(--muted); font-size: 0.875rem;"><i class="fas fa-code"></i> Judge Warmup Prompt/Response</summary>
                    <div class="prompt-block" style="margin-top: 0.5rem;">
                        <div class="block-content" style="max-height: 150px;">${escapeHtml(r.judge_warmup.prompt)}</div>
                    </div>
                    ${r.judge_warmup.response ? `
                    <div class="response-block" style="margin-top: 0.5rem;">
                        <div class="block-content" style="max-height: 150px;">${escapeHtml(r.judge_warmup.response)}</div>
                    </div>
                    ` : ''}
                </details>
                ` : ''}
                ` : ''}

                ${r.quality_breakdown ? `
                <!-- Score Breakdown by Dimension -->
                <h4 style="margin: 1.5rem 0 1rem 0; color: var(--primary, #6366f1);">
                    <i class="fas fa-chart-bar"></i> Score Breakdown
                </h4>
                <div class="score-breakdown">
                    ${Object.entries(r.quality_breakdown)
                        .filter(([key]) => key !== 'explanation' && key !== 'overall')
                        .map(([dimension, score]) => `
                            <div class="dimension-score">
                                <div class="dimension-header">
                                    <span class="dimension-name">${dimension.replace(/_/g, ' ')}</span>
                                    <span class="dimension-value ${getScoreClass(score)}">${typeof score === 'number' ? score.toFixed(1) : score}</span>
                                </div>
                                <div class="dimension-bar">
                                    <div class="dimension-fill" style="width: ${(score / 10) * 100}%; background: ${getScoreColor(score)};"></div>
                                </div>
                            </div>
                        `).join('')}
                </div>
                ` : ''}

                ${r.quality_explanation ? `
                <h4 style="margin: 1.5rem 0 1rem 0; color: var(--primary, #6366f1);">
                    <i class="fas fa-lightbulb"></i> Judge Explanation
                </h4>
                <div class="prompt-block" style="width: 100%;">
                    <div class="block-content">${escapeHtml(r.quality_explanation)}</div>
                </div>
                ` : ''}

                ${r.judge_prompt ? `
                <h4 style="margin: 1.5rem 0 1rem 0; color: var(--primary, #6366f1);">
                    <i class="fas fa-paper-plane"></i> Judge Prompt (sent to evaluator)
                </h4>
                <div class="prompt-block" style="width: 100%;">
                    <div class="block-header">
                        <h4><i class="fas fa-code"></i> Full Prompt</h4>
                        <button class="copy-btn" data-target="judge-prompt"><i class="fas fa-copy"></i> Copy</button>
                    </div>
                    <div class="block-content" id="judge-prompt" style="max-height: 400px;">${escapeHtml(r.judge_prompt)}</div>
                </div>
                ` : ''}

                ${r.judge_raw_response ? `
                <h4 style="margin: 1.5rem 0 1rem 0; color: var(--primary, #6366f1);">
                    <i class="fas fa-file-alt"></i> Raw Judge Response
                </h4>
                <div class="response-block" style="width: 100%;">
                    <div class="block-header">
                        <h4><i class="fas fa-robot"></i> Raw Output</h4>
                        <button class="copy-btn" data-target="judge-raw"><i class="fas fa-copy"></i> Copy</button>
                    </div>
                    <div class="block-content" id="judge-raw" style="max-height: 300px;">${escapeHtml(r.judge_raw_response)}</div>
                </div>
                ` : ''}

                ${r.truncation?.judge_truncated ? `
                <div class="truncation-warning">
                    <i class="fas fa-exclamation-triangle"></i>
                    <span>Judge output was truncated (${r.truncation.judge_tokens} tokens).</span>
                </div>
                ` : ''}
            </div>
        </div>
    `;
}

// Render Hardware tab
function renderHardwareTab(r) {
    const hw = r.hardware_snapshot || {};
    const judgeHw = r.judge_hardware_snapshot || {};
    const trunc = r.truncation || {};
    const meta = hw.detection_metadata || {};
    const judgeMeta = judgeHw.detection_metadata || {};

    // Determine backend display with helpful context for test host
    let backendDisplay = hw.backend || 'Not detected';
    let backendNote = '';
    if (hw.backend === 'Unknown' || !hw.backend) {
        backendNote = meta.source ? `(Detection via ${meta.source})` : '(Hardware detection unavailable)';
    }

    // Determine backend display for judge host
    let judgeBackendDisplay = judgeHw.backend || 'Not detected';
    let judgeBackendNote = '';
    if (judgeHw.backend === 'Unknown' || !judgeHw.backend) {
        judgeBackendNote = judgeMeta.source ? `(Detection via ${judgeMeta.source})` : '(Hardware detection unavailable)';
    }

    // Check if judge runs on same host
    const sameHost = !r.judge_host || r.judge_host === r.host;

    return `
        <div class="hardware-grid">
            <!-- Test Execution Host -->
            <div class="hardware-card">
                <h4><i class="fas fa-microchip"></i> Test Host (Model Under Test)</h4>
                <div class="hardware-item">
                    <span class="hardware-label">Host</span>
                    <span class="hardware-value">${escapeHtml(r.host || 'N/A')}</span>
                </div>
                <div class="hardware-item">
                    <span class="hardware-label">Model</span>
                    <span class="hardware-value">${escapeHtml(r.model || 'N/A')}</span>
                </div>
                <div class="hardware-item">
                    <span class="hardware-label">Backend</span>
                    <span class="hardware-value">${backendDisplay} <span style="font-size: 0.7rem; color: var(--muted);">${backendNote}</span></span>
                </div>
                <div class="hardware-item">
                    <span class="hardware-label">VRAM Usage</span>
                    <span class="hardware-value">${hw.vram_usage_mb ? hw.vram_usage_mb + ' MB' : 'N/A'}</span>
                </div>
                <div class="hardware-item">
                    <span class="hardware-label">Quantization</span>
                    <span class="hardware-value">${hw.quantization || 'N/A'}</span>
                </div>
                ${meta.timestamp ? `
                <div class="hardware-item">
                    <span class="hardware-label">Detected At</span>
                    <span class="hardware-value" style="font-size: 0.75rem;">${new Date(meta.timestamp).toLocaleString()}</span>
                </div>
                ` : ''}
            </div>

            <!-- Judge Host -->
            <div class="hardware-card">
                <h4><i class="fas fa-gavel"></i> Judge Host${sameHost ? ' <span style="font-size: 0.7rem; color: var(--muted);">(Same as test)</span>' : ''}</h4>
                <div class="hardware-item">
                    <span class="hardware-label">Host</span>
                    <span class="hardware-value">${escapeHtml(r.judge_host || r.host || 'N/A')}</span>
                </div>
                <div class="hardware-item">
                    <span class="hardware-label">Judge Model</span>
                    <span class="hardware-value">${escapeHtml(r.judge_model || 'N/A')}</span>
                </div>
                <div class="hardware-item">
                    <span class="hardware-label">Backend</span>
                    <span class="hardware-value">${judgeBackendDisplay} <span style="font-size: 0.7rem; color: var(--muted);">${judgeBackendNote}</span></span>
                </div>
                <div class="hardware-item">
                    <span class="hardware-label">VRAM Usage</span>
                    <span class="hardware-value">${judgeHw.vram_usage_mb ? judgeHw.vram_usage_mb + ' MB' : 'N/A'}</span>
                </div>
                <div class="hardware-item">
                    <span class="hardware-label">Quantization</span>
                    <span class="hardware-value">${judgeHw.quantization || 'N/A'}</span>
                </div>
                ${judgeMeta.timestamp ? `
                <div class="hardware-item">
                    <span class="hardware-label">Detected At</span>
                    <span class="hardware-value" style="font-size: 0.75rem;">${new Date(judgeMeta.timestamp).toLocaleString()}</span>
                </div>
                ` : ''}
            </div>

            <!-- Batch Information -->
            <div class="hardware-card">
                <h4><i class="fas fa-layer-group"></i> Batch Information</h4>
                <div class="hardware-item">
                    <span class="hardware-label">Batch ID</span>
                    <span class="hardware-value" style="font-family: monospace; font-size: 0.75rem;">${r.batch_id || 'Standalone'}</span>
                </div>
                <div class="hardware-item">
                    <span class="hardware-label">Timestamp</span>
                    <span class="hardware-value">${r.timestamp ? new Date(r.timestamp).toLocaleString() : 'N/A'}</span>
                </div>
                <div class="hardware-item">
                    <span class="hardware-label">Result ID</span>
                    <span class="hardware-value" style="font-family: monospace; font-size: 0.75rem;">${r._id || 'N/A'}</span>
                </div>
            </div>

            <!-- Truncation Analysis -->
            <div class="hardware-card">
                <h4><i class="fas fa-cut"></i> Truncation Analysis</h4>
                <div class="hardware-item">
                    <span class="hardware-label">Response Truncated</span>
                    <span class="hardware-value" style="color: ${trunc.response_truncated ? '#ef4444' : '#22c55e'};">
                        ${trunc.response_truncated ? 'Yes' : 'No'}
                    </span>
                </div>
                ${trunc.response_truncated ? `
                <div class="hardware-item">
                    <span class="hardware-label">Response Tokens</span>
                    <span class="hardware-value">${trunc.response_tokens || 'N/A'} / ${trunc.response_limit || 'N/A'}</span>
                </div>
                ` : ''}
                <div class="hardware-item">
                    <span class="hardware-label">Judge Output Truncated</span>
                    <span class="hardware-value" style="color: ${trunc.judge_truncated ? '#ef4444' : '#22c55e'};">
                        ${trunc.judge_truncated ? 'Yes' : 'No'}
                    </span>
                </div>
            </div>

            <!-- Composite Scoring Details -->
            ${r.normalized_scores ? `
            <div class="hardware-card">
                <h4><i class="fas fa-calculator"></i> Composite Score Breakdown</h4>
                <div class="hardware-item">
                    <span class="hardware-label">Profile Used</span>
                    <span class="hardware-value">${r.composite_profile_used || 'N/A'}</span>
                </div>
                <div class="hardware-item">
                    <span class="hardware-label">Quality Component <span style="font-size: 0.65rem; color: var(--muted);">(quality×10)</span></span>
                    <span class="hardware-value">${r.normalized_scores.quality?.toFixed(1) || 'N/A'}<span style="font-size: 0.65rem; color: var(--muted);"> / 100</span></span>
                </div>
                <div class="hardware-item">
                    <span class="hardware-label">Latency Component <span style="font-size: 0.65rem; color: var(--muted);">(faster=higher)</span></span>
                    <span class="hardware-value">${r.normalized_scores.latency?.toFixed(1) || 'N/A'}<span style="font-size: 0.65rem; color: var(--muted);"> / 100</span></span>
                </div>
                <div class="hardware-item">
                    <span class="hardware-label">Speed Component <span style="font-size: 0.65rem; color: var(--muted);">(tok/s, cap 100)</span></span>
                    <span class="hardware-value">${r.normalized_scores.speed?.toFixed(1) || 'N/A'}<span style="font-size: 0.65rem; color: var(--muted);"> / 100</span></span>
                </div>
                <div style="margin-top: 0.75rem; padding: 0.5rem; background: rgba(99, 102, 241, 0.1); border-radius: 4px; font-size: 0.7rem; color: var(--muted);">
                    Final score = weighted sum of components (weights vary by prompt category)
                </div>
            </div>
            ` : ''}
        </div>
    `;
}

// Helper function for score class
function getScoreClass(score) {
    if (score === null || score === undefined) return '';
    if (score >= 8) return 'positive';
    if (score >= 6) return 'warning';
    return 'negative';
}

// Helper function for score color
function getScoreColor(score) {
    if (score >= 8) return '#22c55e';
    if (score >= 6) return '#eab308';
    return '#ef4444';
}

// Rejudge a pending result
async function rejudgeResult(resultId) {
    const btn = document.querySelector('.rejudge-btn');
    if (btn) {
        btn.disabled = true;
        btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Judging...';
    }

    try {
        const response = await fetch(`/api/benchmark/results/${resultId}/rejudge`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' }
        });

        if (!response.ok) {
            const err = await response.json();
            throw new Error(err.error || 'Rejudge failed');
        }

        const data = await response.json();

        // Refresh the inspector with updated data
        await openTestInspector(resultId);

        // Show success message
        alert(`Judging complete! Quality Score: ${data.data.quality_score != null ? data.data.quality_score.toFixed(1) : 'N/A'}`);

    } catch (error) {
        console.error('Rejudge failed:', error);
        alert(`Rejudge failed: ${error.message}`);

        if (btn) {
            btn.disabled = false;
            btn.innerHTML = '<i class="fas fa-redo"></i> Run Judging Now';
        }
    }
}

// Expose rejudge function globally
window.rejudgeResult = rejudgeResult;

// Close Test Inspector modal
function closeTestInspector() {
    document.getElementById('testInspectorModal').style.display = 'none';
    currentInspectorResult = null;
}
