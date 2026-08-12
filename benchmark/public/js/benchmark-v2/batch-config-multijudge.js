// batch-config-multijudge.js — Multi-Judge config card (load / save / build /
// wire / read) for the benchmark-v2 batch config form. Extracted from
// batch-config.js (task 0229). Persists to localStorage under SK_JUDGE
// (multiJudge sub-object). No module-level mutable state.

import { save, loadObj, esc } from './helpers.js';
import { SK_JUDGE, MJ_DEFAULT, MJ_RULE_LABELS } from './batch-config-constants.js';

export function _loadMultiJudgeConfig() {
    const j = loadObj(SK_JUDGE);
    const raw = j?.multiJudge;
    // Legacy: a bare string rule from older versions.
    if (typeof raw === 'string') {
        const rule = raw === 'none' ? 'off' : raw;
        return { ...MJ_DEFAULT, rule };
    }
    if (raw && typeof raw === 'object') {
        return {
            ...MJ_DEFAULT,
            ...raw,
            judges: Array.isArray(raw.judges) ? raw.judges : [],
            tiebreaker: raw.tiebreaker || null
        };
    }
    return { ...MJ_DEFAULT };
}

export function _saveMultiJudgeConfig(cfg) {
    const j = loadObj(SK_JUDGE) || {};
    j.multiJudge = cfg;
    save(SK_JUDGE, JSON.stringify(j));
}

export function _flattenJudgeRoster(judgeRoster) {
    const panels = Array.isArray(judgeRoster?.hostPanels) ? judgeRoster.hostPanels : [];
    const seen = new Set();
    const out = [];
    panels.forEach((panel) => {
        const host = panel.hostUrl;
        if (!host) return;
        (panel.judges || []).forEach((judge) => {
            const model = judge.modelName || judge.model || '';
            if (!model) return;
            const key = `${host}|${model}`;
            if (seen.has(key)) return;
            seen.add(key);
            out.push({
                model,
                host,
                hostName: panel.hostName || host,
                evalCount: Number(judge.evalCount || 0),
                isDefault: model === panel.defaultJudgeModel
            });
        });
    });
    return out;
}

export function _buildMultiJudgeCard(judgeRoster) {
    const cfg = _loadMultiJudgeConfig();
    const all = _flattenJudgeRoster(judgeRoster);
    const ruleOpts = Object.entries(MJ_RULE_LABELS)
        .map(([val, meta]) => `<option value="${val}"${cfg.rule === val ? ' selected' : ''}>${esc(meta.label)}</option>`)
        .join('');

    const isOn = cfg.rule !== 'off';
    const selectedKeys = new Set((cfg.judges || []).map(j => `${j.host}|${j.model}`));
    const tieKey = cfg.tiebreaker ? `${cfg.tiebreaker.host}|${cfg.tiebreaker.model}` : '';

    const judgeRows = all.length === 0
        ? `<div class="bf-mj-empty">No judges discovered. Open <a href="/courthouse">Courthouse</a> to configure judges.</div>`
        : all.map((j) => {
            const key = `${j.host}|${j.model}`;
            const checked = selectedKeys.has(key) ? 'checked' : '';
            const star = j.isDefault ? ' <span class="bf-mj-default" title="Host default">★</span>' : '';
            const evals = j.evalCount > 0 ? ` <span class="bf-mj-evals">${j.evalCount} evals</span>` : '';
            return `<label class="bf-mj-row">
                <input type="checkbox" class="bf-mj-judge" data-mj-model="${esc(j.model)}" data-mj-host="${esc(j.host)}" ${checked}>
                <span class="bf-mj-row-name">${esc(j.model)}${star}</span>
                <span class="bf-mj-row-host">${esc(j.hostName)}${evals}</span>
            </label>`;
        }).join('');

    const tiebreakerOpts = `<option value="">— none —</option>` + all.map((j) => {
        const key = `${j.host}|${j.model}`;
        const sel = key === tieKey ? ' selected' : '';
        return `<option value="${esc(key)}"${sel}>${esc(j.model)} @ ${esc(j.hostName)}</option>`;
    }).join('');

    const summaryText = isOn
        ? `${MJ_RULE_LABELS[cfg.rule]?.label || cfg.rule} — ${(cfg.judges || []).length} judges${cfg.tiebreaker ? ' + tiebreaker' : ''}`
        : 'Off';

    return `
    <details class="bf-mj-card" id="bv2-mj-details" ${isOn ? 'open' : ''}>
      <summary class="bf-mj-summary">
        <span class="bf-opt-label" style="margin:0;">Multi-Judge</span>
        <span class="bf-mj-badge ${isOn ? 'is-on' : 'is-off'}">${esc(summaryText)}</span>
        <span class="bf-cat-caret">▼</span>
      </summary>
      <div class="bf-mj-body">
        <p class="bf-mj-help">
          <strong>What it does.</strong> When triggered, scores a result with multiple judges in parallel and
          takes the median. If they disagree by more than ${'2.0'} points, an optional tiebreaker breaks the deadlock.
          <br><strong>Cost.</strong> Each escalation runs 1–2 extra judge calls per result — expect roughly
          2× judge wall-time on triggered rows, more if the tiebreaker fires. Multi-judge is opt-in; keep it off for normal ranking runs.
        </p>

        <div class="bf-mj-field">
          <label class="bf-mj-label" for="bv2-mj-rule">Trigger</label>
          <select id="bv2-mj-rule" class="bf-select">${ruleOpts}</select>
          <div class="bf-mj-help-line" id="bv2-mj-rule-help">${esc(MJ_RULE_LABELS[cfg.rule]?.describe || '')}</div>
        </div>

        <div class="bf-mj-grid" id="bv2-mj-grid" style="${isOn ? '' : 'display:none;'}">
          <div class="bf-mj-field">
            <label class="bf-mj-label">Primary judges (≥ 2 required)</label>
            <div class="bf-mj-judges-list">${judgeRows}</div>
            <div class="bf-mj-help-line">All checked judges score every triggered result. Median wins.</div>
          </div>

          <div class="bf-mj-field">
            <label class="bf-mj-label" for="bv2-mj-tiebreaker">Tiebreaker</label>
            <select id="bv2-mj-tiebreaker" class="bf-select">${tiebreakerOpts}</select>
            <div class="bf-mj-help-line">Called only when primary judges disagree by &gt; 2.0 points.</div>
          </div>

          <div class="bf-mj-field">
            <label class="bf-mj-label" for="bv2-mj-min-level">Min level for &ldquo;high level&rdquo; trigger</label>
            <input type="number" id="bv2-mj-min-level" class="bf-adv-input" min="1" max="5" step="1" value="${cfg.autoMinLevel}">
            <div class="bf-mj-help-line">Used by &ldquo;Level 4–5&rdquo; and &ldquo;Always&rdquo; rules. Set to 1 to apply to all levels.</div>
          </div>

          <div class="bf-mj-field">
            <label class="bf-mj-label" for="bv2-mj-conf">Confidence threshold</label>
            <input type="number" id="bv2-mj-conf" class="bf-adv-input" min="0" max="1" step="0.05" value="${cfg.confidenceThreshold}">
            <div class="bf-mj-help-line">Used by &ldquo;Low confidence&rdquo; rule. Escalates when primary confidence &lt; this value.</div>
          </div>
        </div>
      </div>
    </details>`;
}

export function _wireMultiJudgeCard(container) {
    const root = container.querySelector('#bv2-mj-details');
    if (!root) return;

    const ruleSel = root.querySelector('#bv2-mj-rule');
    const ruleHelp = root.querySelector('#bv2-mj-rule-help');
    const grid = root.querySelector('#bv2-mj-grid');
    const tieSel = root.querySelector('#bv2-mj-tiebreaker');
    const minLevel = root.querySelector('#bv2-mj-min-level');
    const confInput = root.querySelector('#bv2-mj-conf');
    const judgeBoxes = () => Array.from(root.querySelectorAll('.bf-mj-judge'));

    function persist() {
        const cfg = _loadMultiJudgeConfig();
        cfg.rule = ruleSel.value || 'off';
        cfg.judges = judgeBoxes()
            .filter(cb => cb.checked)
            .map(cb => ({ model: cb.dataset.mjModel, host: cb.dataset.mjHost }));
        const tieVal = tieSel.value || '';
        if (tieVal) {
            const [host, model] = tieVal.split('|');
            cfg.tiebreaker = { model, host };
        } else {
            cfg.tiebreaker = null;
        }
        cfg.autoMinLevel = Math.max(1, Math.min(5, Number(minLevel.value) || 4));
        cfg.confidenceThreshold = Math.max(0, Math.min(1, Number(confInput.value) || 0.8));
        _saveMultiJudgeConfig(cfg);

        const isOn = cfg.rule !== 'off';
        if (grid) grid.style.display = isOn ? '' : 'none';
        if (ruleHelp) ruleHelp.textContent = MJ_RULE_LABELS[cfg.rule]?.describe || '';
    }

    ruleSel?.addEventListener('change', persist);
    tieSel?.addEventListener('change', persist);
    minLevel?.addEventListener('change', persist);
    confInput?.addEventListener('change', persist);
    judgeBoxes().forEach(cb => cb.addEventListener('change', persist));
}

export function _readMultiJudgeFromUI(container) {
    const root = container.querySelector('#bv2-mj-details');
    if (!root) return _loadMultiJudgeConfig();
    const ruleSel = root.querySelector('#bv2-mj-rule');
    const tieSel = root.querySelector('#bv2-mj-tiebreaker');
    const minLevel = root.querySelector('#bv2-mj-min-level');
    const confInput = root.querySelector('#bv2-mj-conf');
    const rule = ruleSel?.value || 'off';
    if (rule === 'off') return { rule: 'off' };

    const judges = Array.from(root.querySelectorAll('.bf-mj-judge'))
        .filter(cb => cb.checked)
        .map(cb => ({ model: cb.dataset.mjModel, host: cb.dataset.mjHost }));

    let tiebreaker = null;
    const tieVal = tieSel?.value || '';
    if (tieVal) {
        const [host, model] = tieVal.split('|');
        tiebreaker = { model, host };
    }

    // Custom mode → send full object (judges + flags). Other modes → send rule
    // string and let the backend resolver expand it from host defaults, but
    // include the user's threshold tweaks as overrides.
    if (rule === 'custom') {
        return {
            enabled: judges.length >= 2,
            rule: 'custom',
            judges,
            tiebreaker,
            autoMinLevel: Math.max(1, Math.min(5, Number(minLevel?.value) || 4)),
            confidenceThreshold: Math.max(0, Math.min(1, Number(confInput?.value) || 0.8)),
            escalateOnHighLevel: true,
            escalateOnLowConfidence: true,
            escalateOnReview: true,
            escalateOnJudgeFailure: true
        };
    }
    return {
        rule,
        judges,
        tiebreaker,
        autoMinLevel: Math.max(1, Math.min(5, Number(minLevel?.value) || 4)),
        confidenceThreshold: Math.max(0, Math.min(1, Number(confInput?.value) || 0.8))
    };
}
