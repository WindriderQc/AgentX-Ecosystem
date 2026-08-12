// judge-roster.js — Host-first judge selection modeled after execution host cards.
// Exports: buildJudgeRoster(), wireJudgeRoster(), getSelectedJudge()

import { save, loadObj, normModel, esc, fmtNum } from './helpers.js';

const SK_JUDGE = 'bv2_judgeConfig';

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Build host-first judge selection UI.
 * User picks a judge host first; a courthouse default is auto-selected when present.
 */
export function buildJudgeRoster(judgeRoster, config, onlineHosts) {
    const panels = _normalizeHostPanels(judgeRoster);
    if (!panels.length) {
        return _buildFallbackDropdowns(onlineHosts, config);
    }

    const saved = loadObj(SK_JUDGE) || {};
    const selection = _resolveInitialSelection(panels, saved, config);
    const missingSavedHost = !!(saved.host && !panels.some((p) => p.hostUrl === saved.host) && saved.host !== selection.host);
    const warningBanner = missingSavedHost
        ? `<div class="jrc-warning" role="alert">
            <span class="jrc-warning-icon">&#9888;</span>
            <span>Previous judge host <strong>${esc(saved.host)}</strong> is unavailable. Pick a judge host below — do not assume the prior selection carried over.</span>
          </div>`
        : '';

    return `<div class="jrc-header">
        <span class="jrc-title">Judge Host</span>
        <a href="/courthouse" class="jrc-courthouse-link">Courthouse &rarr;</a>
      </div>
      ${warningBanner}
      <div class="jrc-help">Pick a judge host first. If Courthouse has a default judge for that host, it is selected automatically. If not, the host stays selected and you pick one of that host's available judges below.</div>
      <div class="jrc-ax-note" title="Any pick is silently upgraded to the ax/-tuned variant if one is deployed on the selected host. Models tagged &quot;ax-tuned&quot; have been profiled for that host's VRAM envelope.">
        <span class="jrc-ax-note-icon">&#x2728;</span>
        <span>Picks tagged <strong>ax-tuned</strong> run the host-profiled variant automatically.</span>
      </div>
      <div class="jhc-grid">
        ${panels.map((panel) => _buildHostCard(panel, selection)).join('')}
      </div>
      <div class="jhc-empty-state"${selection.host ? ' style="display:none;"' : ''}>Select a judge host to continue.</div>
      ${panels.map((panel) => _buildHostPanel(panel, selection)).join('')}`;
}

/**
 * Wire click-to-select on judge hosts and judge model overrides.
 */
export function wireJudgeRoster(container) {
    const hostCards = container.querySelectorAll('.jhc-card');
    if (!hostCards.length) {
        const modelSelect = container.querySelector('#bv2-judge-model');
        const hostSelect = container.querySelector('#bv2-judge-host');
        [modelSelect, hostSelect].filter(Boolean).forEach((el) => {
            el.addEventListener('change', () => {
                _persistJudge(container);
                container.dispatchEvent(new CustomEvent('config-changed', { bubbles: true }));
            });
        });
        return;
    }

    container.addEventListener('click', (e) => {
        const judgePill = e.target.closest('.jhc-judge-pill');
        if (judgePill) {
            _activateHost(container, judgePill.dataset.host || '');
            _selectJudgePill(container, judgePill);
            _persistJudge(container);
            container.dispatchEvent(new CustomEvent('config-changed', { bubbles: true }));
            return;
        }

        const hostCard = e.target.closest('.jhc-card');
        if (!hostCard) return;

        _activateHost(container, hostCard.dataset.host || '');
        _persistJudge(container);
        container.dispatchEvent(new CustomEvent('config-changed', { bubbles: true }));
    });
}

/**
 * Read the currently selected judge from the UI.
 * Returns { model, host } — multiJudge is read separately from batch-config.
 */
export function getSelectedJudge(container) {
    const activePanel = container.querySelector('.jhc-host-panel.is-active');
    const activeHost = container.querySelector('.jhc-card.hs-selected')?.dataset.host || '';
    const selectedPill = activePanel?.querySelector('.jhc-judge-pill.jhc-selected');

    if (selectedPill) {
        return {
            model: selectedPill.dataset.model || '',
            host: selectedPill.dataset.host || activeHost || '',
        };
    }

    if (activeHost) {
        return { model: '', host: activeHost };
    }

    return {
        model: container.querySelector('#bv2-judge-model')?.value || '',
        host: container.querySelector('#bv2-judge-host')?.value || '',
    };
}

// ── Private ──────────────────────────────────────────────────────────────────

function _normalizeHostPanels(judgeRoster) {
    const hostPanels = Array.isArray(judgeRoster?.hostPanels) ? judgeRoster.hostPanels : [];
    return hostPanels
        .map((panel) => {
            const defaultJudgeModel = stripAxPrefix(normalizeModelName(panel.defaultJudgeModel || ''));

            // Collect ax/ variants available on this host, so base pills can be
            // tagged "ax-tuned". Standalone ax/ pills are then hidden — the
            // inference layer auto-upgrades base picks to the ax/ variant.
            const axBaseSet = new Set();
            (panel.judges || []).forEach((j) => {
                const raw = normalizeModelName(j.modelName || j.model || '');
                if (raw.startsWith('ax/')) axBaseSet.add(raw.slice(3));
            });

            const judges = (panel.judges || [])
                .map((judge) => ({
                    model: normalizeModelName(judge.modelName || judge.model || ''),
                    evalCount: Number(judge.evalCount || 0),
                    successRate: judge.successRate == null ? null : Number(judge.successRate),
                    avgScore: judge.avgScore == null ? null : Number(judge.avgScore),
                }))
                .filter((judge) => judge.model && !judge.model.startsWith('ax/'))
                .map((judge) => ({ ...judge, axTuned: axBaseSet.has(judge.model) }))
                .sort((left, right) => {
                    const leftDefault = left.model === defaultJudgeModel;
                    const rightDefault = right.model === defaultJudgeModel;
                    if (leftDefault !== rightDefault) return leftDefault ? -1 : 1;
                    if (left.axTuned !== right.axTuned) return left.axTuned ? -1 : 1;
                    if (left.evalCount !== right.evalCount) return right.evalCount - left.evalCount;
                    return (right.successRate || 0) - (left.successRate || 0);
                });

            return {
                hostUrl: panel.hostUrl || '',
                hostName: panel.hostName || panel.hostUrl || 'Unknown host',
                defaultJudgeModel,
                judges,
            };
        })
        .filter((panel) => panel.hostUrl);
}

function stripAxPrefix(name) {
    return String(name || '').replace(/^ax\//, '');
}

function _resolveInitialSelection(panels, saved = {}, config = {}) {
    const candidates = [
        { host: saved.host || '', model: stripAxPrefix(saved.model || '') },
        { host: config.judge_host || '', model: stripAxPrefix(config.judge_model || '') },
    ];

    for (const candidate of candidates) {
        if (!candidate.host) continue;
        const panel = panels.find((entry) => entry.hostUrl === candidate.host);
        if (!panel) continue;

        const model = normalizeModelName(candidate.model || '');
        if (model && panel.judges.some((judge) => judge.model === model)) {
            return { host: panel.hostUrl, model };
        }

        const defaultJudge = _getDefaultJudge(panel);
        return {
            host: panel.hostUrl,
            model: defaultJudge?.model || '',
        };
    }

    return { host: '', model: '' };
}

function _getDefaultJudge(panel) {
    if (!panel.defaultJudgeModel) return null;
    return panel.judges.find((judge) => judge.model === panel.defaultJudgeModel) || null;
}

function _buildHostCard(panel, selection) {
    const isSelected = panel.hostUrl === selection.host;
    const defaultJudge = _getDefaultJudge(panel);
    const primaryJudge = defaultJudge || panel.judges[0] || null;
    const defaultBadge = defaultJudge
        ? `<span class="hs-pill jhc-pill-default">Default: ${esc(defaultJudge.model)}</span>`
        : panel.defaultJudgeModel
            ? `<span class="hs-pill jhc-pill-warn">Default unavailable: ${esc(panel.defaultJudgeModel)}</span>`
            : '<span class="hs-pill jhc-pill-empty">No courthouse default</span>';
    const statusLabel = isSelected
        ? (selection.model ? `Selected: ${selection.model}` : 'Selected host')
        : (defaultJudge ? 'Auto-picks default judge' : 'Manual judge pick required');

    return `<button type="button" class="jhc-card hs-card${isSelected ? ' hs-selected' : ''}"
        data-host="${esc(panel.hostUrl)}"
        data-host-name="${esc(panel.hostName)}"
        data-default-model="${esc(panel.defaultJudgeModel)}">
        <span class="hs-checkbox">${isSelected ? '&check;' : ''}</span>
        <div class="hs-header">
          <span class="hs-dot ${defaultJudge ? 'jhc-dot-defaulted' : 'jhc-dot-unset'}"></span>
          <span class="hs-name">${esc(panel.hostName)}</span>
        </div>
        <div class="hs-ip">${esc(_shortHost(panel.hostUrl))}</div>
        <div class="hs-pills">
          <span class="hs-pill">${fmtNum(panel.judges.length)} judge${panel.judges.length === 1 ? '' : 's'}</span>
          ${defaultBadge}
        </div>
                <div class="jhc-card-status">${esc(statusLabel)}</div>
        <div class="hs-perf">
                    ${_buildMetricCell(defaultJudge ? 'Yes' : 'No', 'default')}
          ${_buildMetricCell(primaryJudge ? fmtNum(primaryJudge.evalCount || 0) : '&mdash;', 'evals')}
          ${_buildMetricCell(primaryJudge?.successRate != null ? `${primaryJudge.successRate}%` : '&mdash;', 'agreement')}
        </div>
      </button>`;
}

function _buildMetricCell(value, label) {
    return `<div class="hs-perf-cell jhc-perf-cell">
        <div class="hs-perf-val">${value}</div>
        <div class="hs-perf-label">${esc(label)}</div>
      </div>`;
}

function _buildHostPanel(panel, selection) {
    const isActive = panel.hostUrl === selection.host;
    const selectedJudge = panel.judges.find((judge) => judge.model === selection.model) || null;
    return `<div class="jhc-host-panel${isActive ? ' is-active' : ''}"
        data-host="${esc(panel.hostUrl)}"
        data-host-name="${esc(panel.hostName)}"
        data-default-model="${esc(panel.defaultJudgeModel)}">
        <div class="jhc-panel-copy">${_buildPanelCopy(panel)}</div>
        <div class="jhc-panel-selection">${isActive ? _buildPanelSelection(panel, selectedJudge) : ''}</div>
        ${panel.judges.length
            ? `<div class="jhc-judge-list">${panel.judges.map((judge) => _buildJudgePill(panel, judge, isActive ? selection.model : '')).join('')}</div>`
            : '<div class="jhc-empty">No judge models are currently detected on this host.</div>'}
      </div>`;
}

function _buildPanelCopy(panel) {
    const defaultJudge = _getDefaultJudge(panel);
    if (defaultJudge) {
        return `Courthouse default on this host: <strong>${esc(defaultJudge.model)}</strong>. Selecting the host auto-picks it, and you can still override it below.`;
    }
    if (panel.defaultJudgeModel) {
        return `Courthouse default is set to <strong>${esc(panel.defaultJudgeModel)}</strong>, but that model is not available on this host right now. Pick another judge below or update Courthouse.`;
    }
    return 'No default judge is set in Courthouse for this host yet. Select the host, then choose one of its available judges below.';
}

function _buildPanelSelection(panel, selectedJudge) {
    if (!selectedJudge) {
        return `<div class="jhc-empty">No judge selected for ${esc(panel.hostName)} yet.</div>`;
    }

    const isDefault = selectedJudge.model === panel.defaultJudgeModel;
    return `<div class="jrc-selected-card">
        <div class="jrc-sc-top">
          <span class="jrc-sc-name">${esc(selectedJudge.model)}</span>
          ${selectedJudge.axTuned ? '<span class="jrc-ax-badge" title="Runs the host-profiled ax/ variant">ax-tuned</span>' : ''}
          ${isDefault ? '<span class="jrc-default-badge">COURTHOUSE DEFAULT</span>' : '<span class="jhc-manual-badge">MANUAL OVERRIDE</span>'}
        </div>
        <div class="jrc-sc-meta">
          <span>on ${esc(panel.hostName)}</span>
          <span>&middot;</span>
          <span>${fmtNum(selectedJudge.evalCount || 0)} evals</span>
          ${selectedJudge.successRate != null ? `<span>&middot;</span><span>${selectedJudge.successRate}% agreement</span>` : ''}
          ${selectedJudge.avgScore != null ? `<span>&middot;</span><span>avg ${selectedJudge.avgScore}/10</span>` : ''}
        </div>
      </div>`;
}

function _buildJudgePill(panel, judge, selectedModel) {
    const isSelected = judge.model === selectedModel;
    const isDefault = judge.model === panel.defaultJudgeModel;
    const stats = [`${fmtNum(judge.evalCount || 0)} evals`];
    if (judge.successRate != null) stats.push(`${judge.successRate}% agreement`);
    if (judge.avgScore != null) stats.push(`avg ${judge.avgScore}/10`);
    const titleText = judge.axTuned
        ? `${stats.join(' · ')} — runs as ax/${judge.model} on this host`
        : stats.join(' · ');

    return `<button type="button" class="jhc-judge-pill${isSelected ? ' jhc-selected' : ''}${judge.axTuned ? ' jhc-ax-tuned' : ''}"
        data-host="${esc(panel.hostUrl)}"
        data-model="${esc(judge.model)}"
        data-eval-count="${esc(judge.evalCount ?? 0)}"
        data-success-rate="${esc(judge.successRate ?? '')}"
        data-avg-score="${esc(judge.avgScore ?? '')}"
        data-ax-tuned="${judge.axTuned ? '1' : '0'}"
        data-host-name="${esc(panel.hostName)}"
        title="${esc(titleText)}">
        <span class="jhc-judge-name">${esc(judge.model)}</span>
        ${judge.axTuned ? '<span class="jrc-ax-badge" aria-label="ax-tuned variant available">ax-tuned</span>' : ''}
        ${isDefault ? '<span class="jrc-default-badge">DEFAULT</span>' : ''}
        <span class="jhc-judge-meta">${esc(stats.join(' · '))}</span>
      </button>`;
}

function _activateHost(container, hostUrl) {
    container.querySelectorAll('.jhc-card').forEach((card) => {
        const isActive = card.dataset.host === hostUrl;
        card.classList.toggle('hs-selected', isActive);
        const checkbox = card.querySelector('.hs-checkbox');
        if (checkbox) checkbox.innerHTML = isActive ? '&check;' : '';
    });

    container.querySelectorAll('.jhc-host-panel').forEach((panel) => {
        panel.classList.toggle('is-active', panel.dataset.host === hostUrl);
    });

    const emptyState = container.querySelector('.jhc-empty-state');
    if (emptyState) emptyState.style.display = hostUrl ? 'none' : '';

    _ensureActiveJudgeSelection(container);
    _refreshPanels(container);
}

function _ensureActiveJudgeSelection(container) {
    const activePanel = container.querySelector('.jhc-host-panel.is-active');
    if (!activePanel) return;
    if (activePanel.querySelector('.jhc-judge-pill.jhc-selected')) return;

    const defaultModel = activePanel.dataset.defaultModel || '';
    if (!defaultModel) return;

    const defaultPill = Array.from(activePanel.querySelectorAll('.jhc-judge-pill'))
        .find((pill) => pill.dataset.model === defaultModel);
    if (defaultPill) defaultPill.classList.add('jhc-selected');
}

function _selectJudgePill(container, pill) {
    const panel = pill.closest('.jhc-host-panel');
    if (!panel) return;

    panel.querySelectorAll('.jhc-judge-pill').forEach((entry) => {
        entry.classList.toggle('jhc-selected', entry === pill);
    });

    _refreshPanels(container);
}

function _refreshPanels(container) {
    container.querySelectorAll('.jhc-host-panel').forEach((panel) => {
        const copyEl = panel.querySelector('.jhc-panel-copy');
        const selectionEl = panel.querySelector('.jhc-panel-selection');
        const panelData = _panelFromElement(panel);
        if (copyEl) copyEl.innerHTML = _buildPanelCopy(panelData);

        if (selectionEl) {
            if (!panel.classList.contains('is-active')) {
                selectionEl.innerHTML = '';
                return;
            }
            const selectedPill = panel.querySelector('.jhc-judge-pill.jhc-selected');
            selectionEl.innerHTML = _buildPanelSelection(panelData, selectedPill ? _judgeFromElement(selectedPill) : null);
        }
    });
}

function _panelFromElement(panel) {
    return {
        hostUrl: panel.dataset.host || '',
        hostName: panel.dataset.hostName || panel.dataset.host || '',
        defaultJudgeModel: panel.dataset.defaultModel || '',
        judges: Array.from(panel.querySelectorAll('.jhc-judge-pill')).map(_judgeFromElement),
    };
}

function _judgeFromElement(el) {
    return {
        model: el.dataset.model || '',
        evalCount: Number(el.dataset.evalCount || 0),
        successRate: el.dataset.successRate === '' ? null : Number(el.dataset.successRate),
        avgScore: el.dataset.avgScore === '' ? null : Number(el.dataset.avgScore),
        axTuned: el.dataset.axTuned === '1',
    };
}

function _persistJudge(container) {
    save(SK_JUDGE, JSON.stringify(getSelectedJudge(container)));
}

function _shortHost(hostUrl) {
    return String(hostUrl || '').replace(/^https?:\/\//, '').replace(/:\d+$/, '');
}

function normalizeModelName(name) {
    return String(name || '').trim().replace(/:latest$/i, '');
}

function _buildFallbackDropdowns(onlineHosts, config) {
    const saved = loadObj(SK_JUDGE);
    const pickModel = saved.model || config.judge_model || '';
    const pickHost = saved.host || config.judge_host || '';

    const allModels = new Set();
    (onlineHosts || []).forEach((host) => {
        (host.models || []).forEach((model) => allModels.add(normModel(model)));
    });

    const modelOpts = allModels.size
        ? Array.from(allModels).sort().map((model) =>
            `<option value="${esc(model)}"${model === pickModel ? ' selected' : ''}>${esc(model)}</option>`
        ).join('')
        : '<option value="">\u2014 No models \u2014</option>';

    const hostOpts = (onlineHosts || []).length
        ? onlineHosts.map((host) => {
            const url = host.url || '';
            const name = host.name || host.hostname || url;
            return `<option value="${esc(url)}"${url === pickHost ? ' selected' : ''}>${esc(name)}</option>`;
        }).join('')
        : '<option value="">\u2014 No hosts \u2014</option>';

    return `<div class="bf-two-col">
        <div class="jrc-help" style="grid-column:1 / -1; margin-bottom:0.2rem;">Judge host cards are unavailable here, so this falls back to manual judge model and host dropdowns.</div>
        <div class="bf-field">
          <label class="bf-label">Judge Model</label>
          <select id="bv2-judge-model" class="bf-select">${modelOpts}</select>
        </div>
        <div class="bf-field">
          <label class="bf-label">Judge Host</label>
          <select id="bv2-judge-host" class="bf-select">${hostOpts}</select>
        </div>
      </div>`;
}
