// batch-config-models.js — tier-grouped model checklist renderer for the
// benchmark-v2 batch config form. Extracted from batch-config.js (task 0229).
// Pure string builder; event wiring (_wireModelTools / _applyPreset) stays in
// batch-config.js. No module-level mutable state.

import { loadSet, normModel, esc } from './helpers.js';
import {
    SK_MODELS,
    TIER_CONFIG,
    _emptyMsg,
    _hasLocalSameSizeAlias,
    _parseParamSize,
    _tierGroup,
    _sizeClass,
    _formatDiskSize,
    _slug,
} from './batch-config-constants.js';

// ── Model checklist — tier-grouped ──────────────────────────────────────────

export function _buildModelChecklist(host) {
    if (!host) return _emptyMsg('No host selected.');
    const rawModels = Array.isArray(host.models) ? host.models : [];
    if (!rawModels.length) return _emptyMsg('No models on this host.');
    const details = Array.isArray(host.modelDetails) ? host.modelDetails : [];
    const detailByRawName = new Map(details.map(d => [String(d?.name || ''), d]));

    const seen = new Set();
    const models = rawModels.filter((raw) => {
        if (_hasLocalSameSizeAlias(raw, rawModels, detailByRawName)) return false;
        const key = normModel(raw);
        if (!key || seen.has(key)) return false;
        seen.add(key);
        return true;
    });

    const detailMap = new Map(details.map(d => [normModel(d.name), d]));
    const saved = loadSet(SK_MODELS);
    const hostName = host.displayName || host.name || host.hostname || host.url || '';

    // Toolbar: search + presets
    let html = `<div class="mc-toolbar">
      <input type="text" class="mc-search" id="bv2-model-search" placeholder="Filter models…" autocomplete="off">
      <div class="mc-presets">
        <button type="button" class="mc-preset-btn" data-preset="quick" title="3 smallest models for fast smoke tests">⚡ Quick</button>
        <button type="button" class="mc-preset-btn" data-preset="recommended" title="1 per tier for balanced coverage">★ Recommended</button>
        <button type="button" class="mc-preset-btn" data-preset="unbenchmarked" title="Select eligible models without successful benchmark history">Not Benchmarked</button>
        <button type="button" class="mc-preset-btn mc-preset-accent" data-preset="lastbatch" title="Reselect models from most recent batch">🔁 Last Batch</button>
        <button type="button" class="mc-preset-btn" data-preset="filtered" title="Select all currently visible models">✓ Select Filtered</button>
        <button type="button" class="mc-preset-btn" data-preset="all">All</button>
        <button type="button" class="mc-preset-btn" data-preset="none">None</button>
      </div>
    </div>`;

    // Tooltip bar
    html += `<div class="mc-preset-tooltip">
      <span><b>⚡ Quick:</b> 3 smallest by param size</span>
      <span><b>★ Recommended:</b> 1 per tier</span>
      <span><b>Not Benchmarked:</b> first-run candidates</span>
      <span><b>🔁 Last Batch:</b> from previous run</span>
      <span><b>✓ Filtered:</b> visible models only</span>
    </div>`;

    // Sort by parameter size ascending, then name
    const sorted = [...models].sort((a, b) => {
        const da = detailMap.get(normModel(a));
        const db = detailMap.get(normModel(b));
        const sa = _parseParamSize(da?.parameterSize);
        const sb = _parseParamSize(db?.parameterSize);
        if (sa !== sb) return sa - sb;
        return String(a).localeCompare(String(b));
    });

    // Group into tiers
    const groups = { small: [], medium: [], large: [] };
    sorted.forEach(raw => {
        const d = detailMap.get(normModel(raw)) || {};
        const tier = _tierGroup(d.parameterSize);
        groups[tier].push({ raw, d });
    });

    // Render each tier
    for (const [tier, items] of Object.entries(groups)) {
        if (!items.length) continue;
        const tc = TIER_CONFIG[tier];
        html += `<div class="mc-tier-group">
          <div class="mc-tier-header">
            <span class="mc-tier-label" style="color:${tc.color}">▸ ${tc.label}</span>
            <span class="mc-tier-count">— ${items.length} model${items.length !== 1 ? 's' : ''}</span>
            <span class="mc-tier-trait" style="background:${tc.border};color:${tc.color}">${tc.trait}</span>
            <span class="mc-tier-actions">
              <button type="button" class="mc-tier-btn" data-tier="${tier}" data-action="select" style="border-color:${tc.border};color:${tc.color}">Select tier</button>
              <button type="button" class="mc-tier-btn" data-tier="${tier}" data-action="clear">Clear tier</button>
            </span>
          </div>
          <div class="mc-tier-cards">`;

        items.forEach(({ raw, d }) => {
            // The card VALUE must be the exact tag Ollama serves (raw, including
            // any `slekrem/`-style namespace) — that's what we send to the
            // execution host. The DISPLAY uses the normalized short form for
            // readability and stable lookup keys.
            const value = raw;
            const m = normModel(raw);
            const id = `bv2-m-${_slug(value)}`;
            const isEmbedding = /embed|nomic|bert|bge|diagnostic/i.test(m);
            // Saved selections may be in either form (legacy entries stored the
            // normalized name; new entries store the raw value). Match both.
            const inSaved = saved !== null && (saved.has(value) || saved.has(m));
            const checked = !isEmbedding && (saved === null || inSaved) ? 'checked' : '';
            const disabled = isEmbedding ? 'disabled' : '';
            const sizeClass = _sizeClass(d.parameterSize);
            const diskSize = _formatDiskSize(d.size);

            html += `<label class="mc-card${checked ? ' selected' : ''}${isEmbedding ? ' mc-embedding' : ''}" data-model="${esc(value)}" data-model-norm="${esc(m)}" data-tier="${tier}" style="background:${tc.bg};border-color:${tc.border}">
              <input type="checkbox" class="bv2-model-cb" id="${esc(id)}"
                value="${esc(value)}" data-host="${esc(host.url || '')}"
                data-execution-kind="ollama"
                data-host-name="${esc(hostName)}" ${checked} ${disabled}>
              <div class="mc-card-body">
                <span class="mc-card-name" title="${esc(value)}">${esc(m)}${isEmbedding ? ' <span class="ax-readiness ax-warn">EMBEDDING</span>' : ''}</span>
                <div class="mc-card-meta">
                  ${d.parameterSize ? `<span class="mc-badge ${sizeClass}" style="color:${tc.color}">${esc(d.parameterSize)}</span>` : ''}
                  ${d.quantization ? `<span class="mc-badge">${esc(d.quantization)}</span>` : ''}
                  ${diskSize ? `<span class="mc-badge mc-badge-dim">${diskSize}</span>` : ''}
                </div>
              </div>
            </label>`;
        });

        html += '</div></div>';
    }

    // Summary
    const totalModels = models.length;
    const checkedCount = models.filter((raw) => {
        const normalized = normModel(raw);
        if (/embed|nomic|bert|bge|diagnostic/i.test(normalized)) return false;
        return saved === null || saved.has(raw) || saved.has(normalized);
    }).length;
    html += `<div class="mc-summary">${checkedCount} of ${totalModels} models selected</div>`;

    return html;
}

function priceLabel(target) {
    const pricing = target?.pricing;
    if (!pricing || pricing.kind === 'free') return 'free';
    if (pricing.kind === 'manual_per_call') {
        return `manual ~US$${(Number(pricing.callNanodollars || 0) / 1e9).toFixed(6)}/call`;
    }
    const input = Number(pricing.inputNanodollarsPerMillion || 0) / 1e9;
    const output = Number(pricing.outputNanodollarsPerMillion || 0) / 1e9;
    return `manual ~US$${input.toFixed(4)}/${output.toFixed(4)} per 1M in/out`;
}

export function _buildHarnessChecklist(targets = [], catalogEnabled = false) {
    const candidates = (Array.isArray(targets) ? targets : [])
        .filter((target) => target?.mode === 'isolated_model' && target?.capabilities?.candidate);
    if (!candidates.length) {
        const message = catalogEnabled
            ? 'The harness broker is enabled, but no isolated cloud candidate is currently attested.'
            : 'Cloud Benchmark is disabled in this environment.';
        return `<div class="mc-tier-group"><div class="mc-tier-header"><span class="mc-tier-label">Cloud harnesses</span></div><div class="mc-preset-tooltip">${message}</div></div>`;
    }
    const groups = new Map();
    for (const target of candidates) {
        const label = target.harness?.name || 'Harness';
        const group = groups.get(label) || [];
        group.push(target);
        groups.set(label, group);
    }
    return [...groups.entries()].map(([harness, entries]) => `
      <div class="mc-tier-group" data-harness="${esc(harness)}">
        <div class="mc-tier-header">
          <span class="mc-tier-label" style="color:var(--r-active)">☁ ${esc(harness)} Cloud</span>
          <span class="mc-tier-count">— ${entries.length} target${entries.length === 1 ? '' : 's'}</span>
        </div>
        <div class="mc-tier-cards">
          ${entries.map((target) => `
            <label class="mc-card${target.available === false ? ' is-disabled' : ''}" data-model="${esc(target.model)}" data-tier="cloud">
              <input type="checkbox" class="bv2-model-cb" value="${esc(target.id)}"
                data-target-id="${esc(target.id)}" data-execution-kind="harness" ${target.available === false ? 'disabled' : ''}>
              <div class="mc-card-body">
                <span class="mc-card-name">${esc(target.label || target.model)}</span>
                <div class="mc-card-meta">
                  <span class="mc-badge">${esc(target.provider)}</span>
                  <span class="mc-badge">${esc(target.tier === 'paid_cloud' ? 'PAID' : 'FREE')}</span>
                  ${target.available === false ? '<span class="mc-badge">UNAVAILABLE</span>' : ''}
                  <span class="mc-badge">${esc(target.harness?.version || '')}</span>
                  <span class="mc-badge mc-badge-dim">${esc(priceLabel(target))}</span>
                </div>
              </div>
            </label>`).join('')}
        </div>
      </div>`).join('');
}
