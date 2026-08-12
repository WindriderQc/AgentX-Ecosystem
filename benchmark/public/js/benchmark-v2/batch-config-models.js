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

    // Collapse ax/ variants into their base model. The ax/-prefixed form is a
    // deployment artifact produced by the profiler from the base model; they
    // refer to the same logical model. The benchmark executor resolves the
    // ax/ variant at run time via resolveAdaptedModel(), so the card value
    // stays bare. Prevents duplicate rows and the "Not Profiled" label on the
    // ax/ copy of an already-adapted model.
    const AX_PREFIX = 'ax/';
    const seenBase = new Set();
    const models = [];
    // First pass: bare names take precedence so the displayed form stays bare.
    for (const raw of rawModels) {
        if (raw.startsWith(AX_PREFIX)) continue;
        if (_hasLocalSameSizeAlias(raw, rawModels, detailByRawName)) continue;
        const key = normModel(raw);
        if (seenBase.has(key)) continue;
        seenBase.add(key);
        models.push(raw);
    }
    // Second pass: include ax/ variants only when the bare form is absent.
    for (const raw of rawModels) {
        if (!raw.startsWith(AX_PREFIX)) continue;
        const base = raw.slice(AX_PREFIX.length);
        const key = normModel(base);
        if (seenBase.has(key)) continue;
        seenBase.add(key);
        models.push(base);
    }

    const detailMap = new Map(details.map(d => [normModel(d.name), d]));
    // Also index ax/-prefixed details under the base key so metadata (size,
    // quantization) falls back to the ax/ variant when only it has details.
    details.forEach(d => {
        const name = String(d?.name || '');
        if (name.startsWith(AX_PREFIX)) {
            const baseKey = normModel(name.slice(AX_PREFIX.length));
            if (!detailMap.has(baseKey)) detailMap.set(baseKey, d);
        }
    });
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
    const checkedCount = saved === null ? totalModels : saved.size;
    html += `<div class="mc-summary">${checkedCount} of ${totalModels} models selected</div>`;

    return html;
}
