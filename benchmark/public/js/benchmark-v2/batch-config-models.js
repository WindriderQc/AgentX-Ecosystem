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

function sourceKey(value) {
    return _slug(String(value || 'harness').toLowerCase());
}

function formatContextWindow(value) {
    const tokens = Number(value || 0);
    if (!Number.isFinite(tokens) || tokens <= 0) return '';
    if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(tokens % 1_000_000 === 0 ? 0 : 1)}M ctx`;
    if (tokens >= 1_000) return `${Math.round(tokens / 1_000)}K ctx`;
    return `${tokens} ctx`;
}

function formatCatalogTime(value) {
    if (!value) return '';
    const parsed = new Date(value);
    if (Number.isNaN(parsed.getTime())) return '';
    return parsed.toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });
}

function targetFilterText(target) {
    return [
        target?.label,
        target?.model,
        target?.provider,
        target?.harness?.name,
        target?.harness?.version,
        target?.tier,
        target?.mode,
        target?.pricing?.source,
        target?.pricing?.effectiveAt,
        target?.capabilities?.candidate ? 'candidate' : '',
        target?.capabilities?.judge ? 'judge' : '',
        target?.available === false ? 'unavailable' : 'ready',
        target?.tier === 'paid_cloud' ? 'paid' : 'free',
    ].filter(Boolean).join(' ').toLowerCase();
}

export function _buildModelPickerToolbar(host, targets = [], catalog = {}) {
    const candidates = (Array.isArray(targets) ? targets : [])
        .filter((target) => target?.mode === 'isolated_model' && target?.capabilities?.candidate);
    const harnesses = [...new Set(candidates.map((target) => target?.harness?.name || 'Harness'))];
    const hasPaid = candidates.some((target) => target?.tier === 'paid_cloud' && target?.available !== false);
    const observed = formatCatalogTime(catalog?.observedAt);
    const expires = formatCatalogTime(catalog?.expiresAt);
    const catalogCopy = observed
        ? `Catalog attested ${observed}${expires ? ` · valid until ${expires}` : ''}`
        : candidates.length ? 'Attested catalog · freshness revalidated before every cell' : '';

    return `<div class="mc-picker-head">
      <div class="mc-toolbar">
        <label class="mc-search-wrap" for="bv2-model-search">
          <span class="mc-search-icon" aria-hidden="true">⌕</span>
          <input type="search" class="mc-search" id="bv2-model-search"
            placeholder="Search model, provider, harness or capability…" autocomplete="off">
        </label>
        <div class="mc-source-tabs" role="group" aria-label="Model source">
          <button type="button" class="mc-source-btn is-active" data-source-filter="all" aria-pressed="true">All</button>
          ${host ? '<button type="button" class="mc-source-btn" data-source-filter="local" aria-pressed="false">Local</button>' : ''}
          ${harnesses.map((harness) => `<button type="button" class="mc-source-btn" data-source-filter="${esc(sourceKey(harness))}" aria-pressed="false">${esc(harness)}</button>`).join('')}
        </div>
      </div>
      <div class="mc-picker-actions">
        <div class="mc-presets" role="group" aria-label="Selection recipes">
          ${host ? '<button type="button" class="mc-preset-btn" data-preset="quick" title="Three smallest ready local models">⚡ Quick local</button>' : ''}
          ${host && candidates.length ? '<button type="button" class="mc-preset-btn" data-preset="balanced" title="One ready local contender plus one free cloud contender">★ Balanced</button>' : ''}
          ${host ? '<button type="button" class="mc-preset-btn" data-preset="recommended" title="One ready local model per size tier">Tier mix</button>' : ''}
          ${host ? '<button type="button" class="mc-preset-btn" data-preset="unbenchmarked" title="Ready local models without successful benchmark history">New evidence</button>' : ''}
          ${candidates.length ? '<button type="button" class="mc-preset-btn" data-preset="free-cloud" title="Every ready free cloud contender">☁ Free cloud</button>' : ''}
          <button type="button" class="mc-preset-btn mc-preset-accent" data-preset="lastbatch" title="Restore the last safe non-paid selection">↻ Last batch</button>
          <button type="button" class="mc-preset-btn" data-preset="filtered" title="Select visible ready non-paid models">Select visible</button>
          <button type="button" class="mc-preset-btn" data-preset="none">Clear</button>
        </div>
        <div class="mc-filter-chips" role="group" aria-label="Model filters">
          <button type="button" class="mc-filter-chip" data-picker-filter="ready" aria-pressed="false">Ready</button>
          <button type="button" class="mc-filter-chip" data-picker-filter="free" aria-pressed="false">Free</button>
          <button type="button" class="mc-filter-chip" data-picker-filter="paid" aria-pressed="false">Paid</button>
          <button type="button" class="mc-filter-chip" data-picker-filter="judge" aria-pressed="false">Judge-capable</button>
        </div>
        ${hasPaid ? `<label class="mc-paid-optin" for="bv2-allow-paid">
          <input type="checkbox" id="bv2-allow-paid">
          <span><strong>Allow paid models</strong><small>Manual selection only · SpendGrant still required</small></span>
        </label>` : ''}
      </div>
      ${catalogCopy ? `<div class="mc-catalog-proof" role="status">✓ ${esc(catalogCopy)}</div>` : ''}
    </div>`;
}

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

    let html = '';

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

            html += `<label class="mc-card${checked ? ' selected' : ''}${isEmbedding ? ' mc-embedding' : ''}"
              data-model="${esc(value)}" data-model-norm="${esc(m)}" data-size-tier="${tier}"
              data-source="local" data-provider="ollama" data-ready="${isEmbedding ? 'false' : 'true'}"
              data-paid="false" data-judge="false"
              data-filter-text="${esc(`${value} ${m} ollama local ready candidate ${d.parameterSize || ''} ${d.quantization || ''}`.toLowerCase())}"
              style="background:${tc.bg};border-color:${tc.border}">
              <input type="checkbox" class="bv2-model-cb" id="${esc(id)}"
                value="${esc(value)}" data-host="${esc(host.url || '')}"
                data-execution-kind="ollama"
                data-paid="false"
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

    return html;
}

export function priceLabel(target) {
    const pricing = target?.pricing;
    if (!pricing || pricing.kind === 'free') return 'free';
    if (pricing.kind === 'manual_per_call') {
        return `manual ~US$${(Number(pricing.callNanodollars || 0) / 1e9).toFixed(6)}/call`;
    }
    const input = Number(pricing.inputNanodollarsPerMillion || 0) / 1e9;
    const output = Number(pricing.outputNanodollarsPerMillion || 0) / 1e9;
    return `manual ~US$${input.toFixed(4)}/${output.toFixed(4)} per 1M in/out`;
}

function priceEvidenceLabel(target) {
    const pricing = target?.pricing;
    if (!pricing || pricing.kind === 'free') return '';
    const effective = formatCatalogTime(pricing.effectiveAt);
    return [pricing.source ? `Source: ${pricing.source}` : '', effective ? `effective ${effective}` : '']
        .filter(Boolean)
        .join(' · ');
}

function pricingDataAttrs(target) {
    const pricing = target?.pricing || {};
    return `data-price-kind="${esc(pricing.kind || 'free')}"`
        + ` data-call-nanodollars="${Number(pricing.callNanodollars || 0)}"`
        + ` data-input-nanodollars="${Number(pricing.inputNanodollarsPerMillion || 0)}"`
        + ` data-output-nanodollars="${Number(pricing.outputNanodollarsPerMillion || 0)}"`;
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
      <div class="mc-tier-group" data-harness="${esc(harness)}" data-source-group="${esc(sourceKey(harness))}">
        <div class="mc-tier-header">
          <span class="mc-tier-label" style="color:var(--r-active)">☁ ${esc(harness)} Cloud</span>
          <span class="mc-tier-count">— ${entries.length} target${entries.length === 1 ? '' : 's'}</span>
        </div>
        <div class="mc-tier-cards">
          ${entries.map((target) => {
            const paid = target.tier === 'paid_cloud';
            const ready = target.available !== false;
            const source = sourceKey(target.harness?.name || 'Harness');
            const context = formatContextWindow(target.contextWindow);
            const unavailableCopy = ready ? '' : 'Unavailable in the current attested catalog. Refresh the catalog or verify the harness profile.';
            return `
            <label class="mc-card mc-cloud-card${ready ? '' : ' is-disabled'}${paid && ready ? ' mc-paid-locked' : ''}"
              data-model="${esc(target.model)}" data-source="${esc(source)}" data-provider="${esc(target.provider)}"
              data-ready="${ready}" data-paid="${paid}" data-judge="${target.capabilities?.judge === true}"
              data-filter-text="${esc(targetFilterText(target))}">
              <input type="checkbox" class="bv2-model-cb" value="${esc(target.id)}"
                data-target-id="${esc(target.id)}" data-execution-kind="harness"
                data-paid="${paid}" data-paid-lock="${paid && ready}" ${pricingDataAttrs(target)}
                ${!ready || paid ? 'disabled' : ''}>
              <div class="mc-card-body">
                <span class="mc-card-name">${esc(target.label || target.model)}</span>
                <span class="mc-card-subtitle">${esc(target.model)}</span>
                <div class="mc-card-meta">
                  <span class="mc-badge">${esc(target.provider)}</span>
                  <span class="mc-badge ${paid ? 'mc-badge-paid' : 'mc-badge-free'}">${paid ? 'PAID' : 'FREE'}</span>
                  <span class="mc-badge">ISOLATED</span>
                  ${target.capabilities?.judge ? '<span class="mc-badge mc-badge-judge">JUDGE</span>' : ''}
                  ${context ? `<span class="mc-badge">${esc(context)}</span>` : ''}
                  ${target.available === false ? '<span class="mc-badge">UNAVAILABLE</span>' : ''}
                  <span class="mc-badge">${esc(target.harness?.version || '')}</span>
                </div>
                <span class="mc-card-price">${esc(priceLabel(target))}</span>
                ${priceEvidenceLabel(target) ? `<span class="mc-card-price-source">${esc(priceEvidenceLabel(target))}</span>` : ''}
                ${paid && ready ? '<span class="mc-card-note" data-paid-note>Enable paid models, then select manually.</span>' : ''}
                ${unavailableCopy ? `<span class="mc-card-note mc-card-note-error">${esc(unavailableCopy)}</span>` : ''}
              </div>
            </label>`;
          }).join('')}
        </div>
      </div>`).join('');
}

export function _buildCloudJudgePicker(targets = [], catalogEnabled = false) {
    const judges = (Array.isArray(targets) ? targets : [])
        .filter((target) => target?.mode === 'isolated_model' && target?.capabilities?.judge);
    const availableJudges = judges.filter((target) => target.available !== false);
    if (!availableJudges.length) {
        const copy = catalogEnabled
            ? 'No attested isolated cloud judge is available. Continue with a ready local judge.'
            : 'Cloud judges are disabled in this environment.';
        return `<div class="mc-judge-picker-empty">${esc(copy)}</div>`;
    }

    return `<fieldset class="mc-judge-picker">
      <legend>Cloud judge <span>optional · isolated targets only</span></legend>
      <p class="mc-judge-help">A cloud judge overrides the local selection above. Paid judges require the same explicit paid-model unlock and one-batch SpendGrant.</p>
      <div class="mc-judge-choice" role="radiogroup" aria-label="Cloud judge target">
        <label class="mc-card mc-judge-card selected" data-source="local" data-paid="false">
          <input type="radio" name="bv2-cloud-judge" value="" checked>
          <span class="mc-card-body"><span class="mc-card-name">Use local judge</span><span class="mc-card-subtitle">Selected from the ready host above</span></span>
        </label>
        ${availableJudges.map((target) => {
          const paid = target.tier === 'paid_cloud';
          const context = formatContextWindow(target.contextWindow);
          return `<label class="mc-card mc-cloud-card mc-judge-card${paid ? ' mc-paid-locked' : ''}"
            data-source="${esc(sourceKey(target.harness?.name || 'Harness'))}" data-paid="${paid}">
            <input type="radio" name="bv2-cloud-judge" value="${esc(target.id)}"
              data-target-id="${esc(target.id)}" data-model="${esc(target.model)}" data-label="${esc(target.label || target.model)}"
              data-provider="${esc(target.provider)}" data-harness="${esc(target.harness?.name || 'Harness')}"
              data-paid="${paid}" data-paid-lock="${paid}" ${pricingDataAttrs(target)} ${paid ? 'disabled' : ''}>
            <span class="mc-card-body">
              <span class="mc-card-name">${esc(target.label || target.model)}</span>
              <span class="mc-card-subtitle">${esc(target.model)}</span>
              <span class="mc-card-meta">
                <span class="mc-badge">${esc(target.harness?.name || 'Harness')}</span>
                <span class="mc-badge">${esc(target.provider)}</span>
                <span class="mc-badge ${paid ? 'mc-badge-paid' : 'mc-badge-free'}">${paid ? 'PAID' : 'FREE'}</span>
                <span class="mc-badge">ISOLATED</span>
                ${context ? `<span class="mc-badge">${esc(context)}</span>` : ''}
                <span class="mc-badge mc-badge-judge">JUDGE</span>
              </span>
              <span class="mc-card-price">${esc(priceLabel(target))}</span>
              ${priceEvidenceLabel(target) ? `<span class="mc-card-price-source">${esc(priceEvidenceLabel(target))}</span>` : ''}
            </span>
          </label>`;
        }).join('')}
      </div>
    </fieldset>`;
}

export function _buildSelectionBasket() {
    return `<div id="bv2-selection-basket" class="mc-selection-basket" role="status" aria-live="polite">
      <span class="mc-basket-kicker">Selection</span>
      <strong data-basket-count>0 contenders</strong>
      <span data-basket-detail>Choose ready local or cloud models.</span>
      <span class="mc-basket-safety">Paid targets are manual-only. Worst-case calls, tokens and cost appear in Review &amp; run.</span>
    </div>`;
}
