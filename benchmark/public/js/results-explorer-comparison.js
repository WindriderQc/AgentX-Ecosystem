// Compare the selected response records already loaded on this page.
// No extra request, ranking, or inferred score is needed.
function openComparisonModal() {
    const records = allResults.filter(result => selectedResults.has(result._id));
    if (records.length < 2 || records.length > 4) return;
    const dialog = document.getElementById('comparisonModal');
    document.getElementById('comparisonContent').innerHTML = renderResponseComparison(records);
    dialog.onclick = event => { if (event.target === dialog) closeComparisonModal(); };
    dialog.showModal();
}

function closeComparisonModal() {
    document.getElementById('comparisonModal').close();
}

function comparisonText(value, fallback = 'Not recorded') {
    return typeof value === 'string' && value.trim() ? value : fallback;
}

function comparisonNumber(value, suffix = '', digits = 0) {
    return Number.isFinite(value) && value >= 0
        ? `${value.toLocaleString('en-US', { maximumFractionDigits: digits })}${suffix}`
        : 'Not recorded';
}

function comparisonScore(value, scale = 10) {
    return Number.isFinite(value) && value >= 0 && value <= scale
        ? `${renderScore(value, scale === 100 ? '0-100' : '0-10')} / ${scale}`
        : 'Not recorded';
}

function comparisonScoring(result) {
    if (result.human_review_status === 'overridden') return 'Human override';
    const states = { pending: 'Judging pending', llm_failed: 'Judging failed', skipped: 'Scoring skipped', disabled: 'Scoring disabled' };
    if (result.evidence_mode === 'unscored' && states[result.scoring_method]) return states[result.scoring_method];
    const labels = {
        judge_scored: 'Judge scored',
        deterministic_only: 'Rule-based checks',
        hybrid: 'Rules and judge',
        unscored: 'Score source not recorded'
    };
    return labels[result.evidence_mode] || 'Score source not recorded';
}

function renderResponseComparison(records) {
    const sharedPrompt = comparisonText(records[0]?.prompt, '');
    const samePrompt = !!sharedPrompt && records.every(result => result.prompt === sharedPrompt);
    const models = new Set(records.map(result => result.model)).size;
    const scored = records.filter(result => Number.isFinite(result.quality_score)
        && result.quality_score >= 0 && result.quality_score <= 10).length;
    const notices = [];
    if (new Set(records.map(result => result.execution_target?.mode || 'direct_model')).size > 1) {
        notices.push('These responses use different execution modes. An agent can use tools and multiple model turns.');
    }
    if (!samePrompt) notices.push('Different or missing prompts: read each prompt alongside its answer before comparing scores.');
    if (new Set(records.map(result => comparisonText(result.batch_id, ''))).size > 1) {
        notices.push('Different runs are selected. Settings and hardware may differ.');
    }
    const scoreSources = new Set(records.filter(result => Number.isFinite(result.quality_score)).map(comparisonScoring));
    if (scoreSources.size > 1) notices.push('The recorded scores use different kinds of scoring. Check the source shown with each score.');

    return `<p class="comparison-scope">${records.length} selected responses · ${models} ${models === 1 ? 'model' : 'models'} · ${scored} with a recorded quality score.
        This view describes only these selected responses.</p>
        ${notices.length ? `<ul class="comparison-notices">${notices.map(notice => `<li>${notice}</li>`).join('')}</ul>` : ''}
        ${samePrompt ? `<section class="comparison-shared-prompt"><h3>Shared prompt</h3><pre>${escapeHtml(sharedPrompt)}</pre></section>` : ''}
        <div class="comparison-grid">${records.map(result => renderComparisonCard(result, { samePrompt })).join('')}</div>`;
}

function renderComparisonCard(result, { samePrompt = false } = {}) {
    const answer = comparisonText(result.response, '');
    const reasoning = comparisonText(result.thinking, '');
    const settings = result.execution_settings || {};
    const target = result.execution_target;
    const usage = result.provider_usage || result.execution_receipt?.usage || {};
    const nativeAgent = target?.mode === 'native_agent';
    const mode = nativeAgent ? 'Agent with tools' : 'Model only';
    const status = result.success === true ? 'Completed' : result.success === false ? 'Failed' : 'Status not recorded';
    const modelName = value => comparisonText(value, '').replace(/:latest$/, '');
    const hostName = value => comparisonText(value, '').replace(/\/+$/, '');
    const selfJudged = !!result.judge_model && !!result.judge_host
        && modelName(result.model) === modelName(result.judge_model)
        && hostName(result.host) === hostName(result.judge_host)
        && ['judge_scored', 'hybrid'].includes(result.evidence_mode);
    const details = [
        ['Execution', mode],
        ...(target?.harness ? [['Harness', `${target.harness.name} ${target.harness.version}`], ['Model', comparisonText(result.model)]] : []),
        ['Category', comparisonText(result.prompt_category)],
        ['Level', comparisonNumber(result.prompt_level)],
        ['Host', comparisonText(_profilerHostMap[result.host] || result.host)],
        ['Run', comparisonText(result.batch_id)],
        ['Backend', comparisonText(result.hardware_snapshot?.backend)],
        ['Quantization', comparisonText(result.hardware_snapshot?.quantization)],
        ['Context tokens', comparisonNumber(settings.num_ctx)],
        ['Response token limit', comparisonNumber(settings.num_predict)],
        ['Temperature', comparisonNumber(settings.temperature, '', 3)],
        ['Seed', comparisonNumber(settings.seed)],
        ['Scoring method', comparisonText(result.scoring_method)],
        ['Judge model', comparisonText(result.judge_model)],
        ...(result.human_review_status ? [['Human review', comparisonText(result.human_review_status)]] : [])
    ];

    return `<article class="comparison-card">
        <header><h3>${escapeHtml(comparisonText(target?.label || result.model))}</h3><span class="comparison-status">${status} · ${mode}</span></header>
        ${!samePrompt ? `<section class="comparison-prompt"><h4>Prompt</h4><pre>${escapeHtml(comparisonText(result.prompt, 'Prompt not recorded.'))}</pre></section>` : ''}
        <section class="comparison-answer"><h4>Answer</h4>
            ${answer ? `<pre>${escapeHtml(answer)}</pre>` : `<p class="comparison-missing">No answer text recorded.${reasoning ? ' Captured reasoning is available below.' : ''}</p>`}
            ${result.success === false && result.error ? `<p class="comparison-failure">${escapeHtml(String(result.error))}</p>` : ''}
        </section>
        <dl class="comparison-metrics">
            <div><dt>Quality</dt><dd>${comparisonScore(result.quality_score)}</dd><dd class="comparison-score-source">${comparisonScoring(result)}</dd></div>
            <div><dt>Response time</dt><dd>${comparisonNumber(result.latency, ' ms')}</dd></div>
            <div><dt>Tokens / second</dt><dd>${comparisonNumber(result.tokens_per_sec, '', 1)}</dd></div>
            ${target ? `<div><dt>Total input / output tokens</dt><dd>${comparisonNumber(usage.inputTokens)} / ${comparisonNumber(usage.outputTokens)}</dd></div>` : ''}
            ${nativeAgent ? `<div><dt>Model turns / tool calls</dt><dd>${comparisonNumber(usage.turns)} / ${comparisonNumber(usage.toolCalls)}</dd></div>` : ''}
        </dl>
        ${selfJudged ? '<p class="comparison-notice">This model also judged its own answer.</p>' : ''}
        ${result.excluded_from_leaderboard ? `<p class="comparison-notice">${nativeAgent ? 'Agent results are excluded from model-only rankings.' : 'Excluded from rankings.'}</p>` : ''}
        ${reasoning ? `<details class="comparison-reasoning"><summary>Captured reasoning</summary><pre>${escapeHtml(reasoning)}</pre></details>` : ''}
        <details class="comparison-details"><summary>Scoring and run details</summary>
            ${result.quality_explanation ? `<h4>Recorded scoring explanation</h4><p>${escapeHtml(String(result.quality_explanation))}</p>` : ''}
            ${result.review_reason ? `<p>${escapeHtml(String(result.review_reason))}</p>` : ''}
            <dl class="comparison-metadata">
                <div><dt>Composite score</dt><dd>${comparisonScore(result.composite_score, 100)}</dd></div>
                ${Number.isFinite(result.judge_quality_score) ? `<div><dt>Original judge score</dt><dd>${comparisonScore(result.judge_quality_score)}</dd></div>` : ''}
                ${details.map(([label, value]) => `<div><dt>${label}</dt><dd>${escapeHtml(value)}</dd></div>`).join('')}
                <div><dt>Recorded at</dt><dd>${formatRecordedAt(result)}</dd></div>
                <div><dt>Evidence age</dt><dd>${renderEvidenceAge(result)}</dd></div>
            </dl>
        </details>
    </article>`;
}
