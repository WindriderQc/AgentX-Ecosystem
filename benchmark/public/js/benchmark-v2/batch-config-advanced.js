// batch-config-advanced.js — Advanced Settings panel (judge behavior, pipeline
// timeouts, fairness/sampling, prompt hints) for the benchmark-v2 batch config
// form. Extracted from batch-config.js (task 0229). Persists to localStorage
// under SK_ADVANCED. No module-level mutable state.

import { save, loadObj, esc } from './helpers.js';
import {
    SK_ADVANCED,
    ADV_JUDGE_DEFAULTS,
    ADV_PIPELINE_DEFAULTS,
    ADV_FAIRNESS_DEFAULTS,
    _fmtMs,
} from './batch-config-constants.js';

export function _loadAdvancedSettings() {
    const stored = loadObj(SK_ADVANCED) || {};
    if (stored.think !== undefined && typeof stored.think !== 'boolean') {
        stored.think = ADV_JUDGE_DEFAULTS.think;
    }
    return { ...ADV_JUDGE_DEFAULTS, ...ADV_PIPELINE_DEFAULTS, ...ADV_FAIRNESS_DEFAULTS, ...stored };
}

export function _buildAdvancedSettings() {
    const s = _loadAdvancedSettings();
    const judgeTemp = s.temperature;
    const judgeTokens = s.num_predict;
    const judgeRetries = s.max_retries;
    const judgeTimeoutSec = Math.round(s.timeout / 1000);
    const isDefault = JSON.stringify(s) === JSON.stringify({ ...ADV_JUDGE_DEFAULTS, ...ADV_PIPELINE_DEFAULTS, ...ADV_FAIRNESS_DEFAULTS });
    const summaryExtra = isDefault ? 'defaults' : `temp ${judgeTemp}, ${judgeTokens} tokens, ${judgeRetries} retries`;
    const contractSummary = s.answer_contract_mode === 'off' ? 'contract off' : 'contract auto';
    const summary = `Judge: ${summaryExtra} | Exec: ${s.response_max_tokens} tok max, ${contractSummary} | Timeouts: ${_fmtMs(s.per_test_timeout_ms)}/test, ${_fmtMs(s.warmup_timeout_cold)} warmup`;

    return `
    <details class="bf-advanced" id="bv2-advanced-details">
      <summary class="bf-advanced-summary">
        Advanced Settings
        <span class="bf-advanced-badge" id="bv2-advanced-badge">${esc(summary)}</span>
        <span class="bf-cat-caret">&#9660;</span>
      </summary>
      <div class="bf-advanced-body">

        <!-- Judge Behavior -->
        <div class="bf-adv-section">
          <div class="bf-adv-section-header">
            Judge Behavior
            <button type="button" class="bf-adv-reset" data-adv-reset="judge">Reset defaults</button>
          </div>
          <div class="bf-adv-grid">

            <div class="bf-adv-field">
              <label class="bf-adv-label" for="bv2-adv-temperature">Temperature</label>
              <input type="number" id="bv2-adv-temperature" class="bf-adv-input"
                min="0" max="1" step="0.05" value="${s.temperature}"
                data-adv-key="temperature" data-adv-group="judge">
              <span class="bf-adv-range">0 – 1.0</span>
              <span class="bf-adv-help">Controls judge randomness. Lower = more consistent scores. 0.1 recommended for evaluation.</span>
            </div>

            <div class="bf-adv-field">
              <label class="bf-adv-label" for="bv2-adv-num_predict">Max Response Tokens</label>
              <input type="number" id="bv2-adv-num_predict" class="bf-adv-input"
                min="100" max="4096" step="100" value="${s.num_predict}"
                data-adv-key="num_predict" data-adv-group="judge">
              <span class="bf-adv-range">100 – 4096</span>
              <span class="bf-adv-help">Maximum tokens the judge can use for its evaluation response. Increase if judge outputs are being truncated.</span>
            </div>

            <div class="bf-adv-field">
              <label class="bf-adv-label" for="bv2-adv-num_ctx">Context Window</label>
              <input type="number" id="bv2-adv-num_ctx" class="bf-adv-input"
                min="2048" max="32768" step="1024" value="${s.num_ctx}"
                data-adv-key="num_ctx" data-adv-group="judge">
              <span class="bf-adv-range">2048 – 32768</span>
              <span class="bf-adv-help">Context window size for the judge model. Must fit the prompt + model response + judge instructions.</span>
            </div>

            <div class="bf-adv-field">
              <label class="bf-adv-label" for="bv2-adv-max_retries">Max Retries</label>
              <input type="number" id="bv2-adv-max_retries" class="bf-adv-input"
                min="0" max="5" step="1" value="${s.max_retries}"
                data-adv-key="max_retries" data-adv-group="judge">
              <span class="bf-adv-range">0 – 5</span>
              <span class="bf-adv-help">How many times to retry a failed judge call (timeout, malformed JSON). Higher = more resilient but slower.</span>
            </div>

            <div class="bf-adv-field">
              <label class="bf-adv-label" for="bv2-adv-timeout">Judge Timeout (ms)</label>
              <input type="number" id="bv2-adv-timeout" class="bf-adv-input"
                min="5000" max="120000" step="5000" value="${s.timeout}"
                data-adv-key="timeout" data-adv-group="judge">
              <span class="bf-adv-range">5s – 120s (${judgeTimeoutSec}s current)</span>
              <span class="bf-adv-help">Maximum time (ms) to wait for a judge response. Increase for slower hosts or larger models.</span>
            </div>

            <div class="bf-adv-field">
              <label class="bf-adv-label" for="bv2-adv-voting_count">Voting Count</label>
              <select id="bv2-adv-voting_count" class="bf-adv-select"
                data-adv-key="voting_count" data-adv-group="judge">
                <option value="1" ${s.voting_count === 1 ? 'selected' : ''}>1 — Single call (fast, default)</option>
                <option value="3" ${s.voting_count === 3 ? 'selected' : ''}>3 — Majority vote (3× calls, more accurate)</option>
                <option value="5" ${s.voting_count === 5 ? 'selected' : ''}>5 — Supermajority (5× calls, highest accuracy)</option>
              </select>
              <span class="bf-adv-help">Number of independent judge calls per question in decomposed scoring. 3 = majority voting (more accurate but 3× slower).</span>
            </div>

            <div class="bf-adv-field bf-adv-field--checkbox">
              <label class="bf-checkbox-row">
                <input type="checkbox" id="bv2-adv-think" class="bf-adv-check"
                  ${s.think ? 'checked' : ''}
                  data-adv-key="think" data-adv-group="judge">
                <span>Think Mode <span class="bf-adv-tag">advanced</span></span>
              </label>
              <span class="bf-adv-help">Allow reasoning models (DeepSeek-R1, Qwen-think) to use chain-of-thought when judging. Increases accuracy on complex evaluations but uses significantly more tokens and time.</span>
            </div>

          </div>
        </div>

        <!-- Pipeline Timeouts -->
        <div class="bf-adv-section">
          <div class="bf-adv-section-header">
            Pipeline Timeouts
            <button type="button" class="bf-adv-reset" data-adv-reset="pipeline">Reset defaults</button>
          </div>
          <div class="bf-adv-grid">

            <div class="bf-adv-field">
              <label class="bf-adv-label" for="bv2-adv-response_max_tokens">Execution Max Response Tokens</label>
              <input type="number" id="bv2-adv-response_max_tokens" class="bf-adv-input"
                min="100" max="50000" step="100" value="${s.response_max_tokens}"
                data-adv-key="response_max_tokens" data-adv-group="pipeline">
              <span class="bf-adv-range">100 – 50000</span>
              <span class="bf-adv-help">Hard runtime cap for the model under test. Keep this above the visible answer contract so truncation means a real failure, not a hidden harness limit.</span>
            </div>

            <div class="bf-adv-field">
              <label class="bf-adv-label" for="bv2-adv-answer_contract_mode">Answer Contract</label>
              <select id="bv2-adv-answer_contract_mode" class="bf-adv-select"
                data-adv-key="answer_contract_mode" data-adv-type="string" data-adv-group="pipeline">
                <option value="auto" ${s.answer_contract_mode !== 'off' ? 'selected' : ''}>Auto - expose expected_tokens</option>
                <option value="off" ${s.answer_contract_mode === 'off' ? 'selected' : ''}>Off - no automatic contract</option>
              </select>
              <span class="bf-adv-help">Auto appends a visible target/max response budget when prompt metadata has <code>expected_tokens</code>. This keeps asked vs expected vs judged aligned.</span>
            </div>

            <div class="bf-adv-field">
              <label class="bf-adv-label" for="bv2-adv-per_test_timeout_ms">Per-Test Timeout (ms)</label>
              <input type="number" id="bv2-adv-per_test_timeout_ms" class="bf-adv-input"
                min="30000" max="1200000" step="30000" value="${s.per_test_timeout_ms}"
                data-adv-key="per_test_timeout_ms" data-adv-group="pipeline">
              <span class="bf-adv-range">30s – 20min (${_fmtMs(s.per_test_timeout_ms)} current)</span>
              <span class="bf-adv-help">Maximum time (ms) for a single model response. 10 minutes default. Increase for large reasoning models.</span>
            </div>

            <div class="bf-adv-field">
              <label class="bf-adv-label" for="bv2-adv-warmup_timeout_cold">Warmup — Cold Start (ms)</label>
              <input type="number" id="bv2-adv-warmup_timeout_cold" class="bf-adv-input"
                min="30000" max="600000" step="30000" value="${s.warmup_timeout_cold}"
                data-adv-key="warmup_timeout_cold" data-adv-group="pipeline">
              <span class="bf-adv-range">30s – 10min (${_fmtMs(s.warmup_timeout_cold)} current)</span>
              <span class="bf-adv-help">Maximum time (ms) to wait for a model to load into GPU memory from cold start.</span>
            </div>

            <div class="bf-adv-field">
              <label class="bf-adv-label" for="bv2-adv-warmup_timeout_loaded">Warmup — Already Loaded (ms)</label>
              <input type="number" id="bv2-adv-warmup_timeout_loaded" class="bf-adv-input"
                min="10000" max="180000" step="10000" value="${s.warmup_timeout_loaded}"
                data-adv-key="warmup_timeout_loaded" data-adv-group="pipeline">
              <span class="bf-adv-range">10s – 3min (${_fmtMs(s.warmup_timeout_loaded)} current)</span>
              <span class="bf-adv-help">Maximum time (ms) to verify a model is responsive when already loaded.</span>
            </div>

            <div class="bf-adv-field">
              <label class="bf-adv-label" for="bv2-adv-judge_drain_timeout_ms">Judge Drain Timeout (ms)</label>
              <input type="number" id="bv2-adv-judge_drain_timeout_ms" class="bf-adv-input"
                min="300000" max="3600000" step="300000" value="${s.judge_drain_timeout_ms}"
                data-adv-key="judge_drain_timeout_ms" data-adv-group="pipeline">
              <span class="bf-adv-range">5min – 60min (${_fmtMs(s.judge_drain_timeout_ms)} current)</span>
              <span class="bf-adv-help">Maximum time (ms) to wait for all judge evaluations to complete after execution finishes. 30 minutes default.</span>
            </div>

            <div class="bf-adv-field">
              <label class="bf-adv-label" for="bv2-adv-judge_stall_timeout_ms">Judge Stall Timeout (ms)</label>
              <input type="number" id="bv2-adv-judge_stall_timeout_ms" class="bf-adv-input"
                min="30000" max="600000" step="30000" value="${s.judge_stall_timeout_ms}"
                data-adv-key="judge_stall_timeout_ms" data-adv-group="pipeline">
              <span class="bf-adv-range">30s – 10min (${_fmtMs(s.judge_stall_timeout_ms)} current)</span>
              <span class="bf-adv-help">If no judge progress for this long (ms), consider the queue stalled and finalize. 2 minutes default.</span>
            </div>

          </div>
        </div>

        <!-- Fairness & Sampling — pin generation params across hosts/models -->
        <div class="bf-adv-section">
          <div class="bf-adv-section-header">
            Fairness &amp; Sampling
            <button type="button" class="bf-adv-reset" data-adv-reset="fairness">Reset defaults</button>
          </div>
          <div class="bf-adv-grid">

            <div class="bf-adv-field">
              <label class="bf-adv-label" for="bv2-adv-force_num_ctx">Force num_ctx (override per-host profile)</label>
              <input type="number" id="bv2-adv-force_num_ctx" class="bf-adv-input"
                min="0" max="131072" step="512"
                value="${s.force_num_ctx ?? ''}"
                placeholder="blank = honor per-host profile"
                data-adv-key="force_num_ctx" data-adv-group="fairness">
              <span class="bf-adv-range">512 – 131072 (blank = legacy)</span>
              <span class="bf-adv-help">Pins every host to the same context for fair host-vs-host comparison. Without this, a 24GB host runs at 32K while a 12GB host runs at 8K and their latency numbers are incomparable.</span>
            </div>

            <div class="bf-adv-field">
              <label class="bf-adv-label" for="bv2-adv-exec_seed">Seed (deterministic sampling)</label>
              <input type="number" id="bv2-adv-exec_seed" class="bf-adv-input"
                step="1" value="${s.exec_seed ?? ''}"
                placeholder="blank = non-deterministic"
                data-adv-key="exec_seed" data-adv-group="fairness">
              <span class="bf-adv-help">Pins RNG so repeat runs of the same (model, host, prompt) reproduce. Some quants ignore seed; if variance stays high with seed pinned, suspect the model.</span>
            </div>

            <div class="bf-adv-field">
              <label class="bf-adv-label" for="bv2-adv-exec_temperature">Temperature</label>
              <input type="number" id="bv2-adv-exec_temperature" class="bf-adv-input"
                min="0" max="2" step="0.1" value="${s.exec_temperature}"
                data-adv-key="exec_temperature" data-adv-group="fairness">
              <span class="bf-adv-range">0 – 2</span>
              <span class="bf-adv-help">Without this pinned, each Modelfile contributes its own (often 0.7+) and scores include sampling variance.</span>
            </div>

            <div class="bf-adv-field">
              <label class="bf-adv-label" for="bv2-adv-exec_top_p">top_p</label>
              <input type="number" id="bv2-adv-exec_top_p" class="bf-adv-input"
                min="0" max="1" step="0.05" value="${s.exec_top_p}"
                data-adv-key="exec_top_p" data-adv-group="fairness">
              <span class="bf-adv-range">0 – 1</span>
            </div>

            <div class="bf-adv-field">
              <label class="bf-adv-label" for="bv2-adv-exec_top_k">top_k</label>
              <input type="number" id="bv2-adv-exec_top_k" class="bf-adv-input"
                min="1" max="1000" step="1" value="${s.exec_top_k}"
                data-adv-key="exec_top_k" data-adv-group="fairness">
              <span class="bf-adv-range">1 – 1000</span>
            </div>

            <div class="bf-adv-field">
              <label class="bf-adv-label" for="bv2-adv-exec_repeat_penalty">repeat_penalty</label>
              <input type="number" id="bv2-adv-exec_repeat_penalty" class="bf-adv-input"
                min="0.5" max="2" step="0.05" value="${s.exec_repeat_penalty}"
                data-adv-key="exec_repeat_penalty" data-adv-group="fairness">
              <span class="bf-adv-range">0.5 – 2</span>
            </div>

            <div class="bf-adv-field">
              <label class="bf-adv-label" for="bv2-adv-exec_repeats">Repeats per (model, host, prompt)</label>
              <input type="number" id="bv2-adv-exec_repeats" class="bf-adv-input"
                min="1" max="5" step="1" value="${s.exec_repeats}"
                data-adv-key="exec_repeats" data-adv-group="fairness">
              <span class="bf-adv-range">1 – 5 (multiplies total tests)</span>
              <span class="bf-adv-help">Run each test N times. With seed pinned, low variance across repeats = stable model+host. High variance with seed pinned = the model ignores the seed (some quants do).</span>
            </div>

          </div>
        </div>

        <!-- Prompt Hints (appended to every model prompt under test) -->
        <div class="bf-adv-section">
          <div class="bf-adv-section-header">
            Prompt Hints
            <button type="button" class="bf-adv-reset" data-adv-reset="pipeline">Reset defaults</button>
          </div>
          <div class="bf-adv-grid">

            <div class="bf-adv-field bf-adv-field--checkbox">
              <label class="bf-checkbox-row">
                <input type="checkbox" id="bv2-adv-include_length_hint" class="bf-adv-check"
                  ${s.include_length_hint ? 'checked' : ''}
                  data-adv-key="include_length_hint" data-adv-group="pipeline">
                <span>Include Length Hint</span>
              </label>
              <span class="bf-adv-help">Append a length-limit hint to every model prompt (off by default). Uses the template below with <code>{max}</code> = Execution Max Response Tokens. Warning: changes token counts and can bias cross-batch comparisons.</span>
            </div>

            <div class="bf-adv-field bf-adv-field--wide">
              <label class="bf-adv-label" for="bv2-adv-length_hint_template">Length Hint Template</label>
              <textarea id="bv2-adv-length_hint_template" class="bf-adv-input" rows="2"
                data-adv-key="length_hint_template" data-adv-type="string"
                data-adv-group="pipeline">${(s.length_hint_template || '').replace(/</g, '&lt;')}</textarea>
              <span class="bf-adv-help">Placeholders: <code>{max}</code> (num_predict), <code>{target}</code> (prompt.expected_tokens), <code>{min}</code>, <code>{multiplier}</code>. Only applied when the checkbox above is on.</span>
            </div>

            <div class="bf-adv-field bf-adv-field--wide">
              <label class="bf-adv-label" for="bv2-adv-custom_hint">Custom Hint (always applied)</label>
              <textarea id="bv2-adv-custom_hint" class="bf-adv-input" rows="2"
                data-adv-key="custom_hint" data-adv-type="string"
                data-adv-group="pipeline"
                placeholder="e.g. Answer in English only. No markdown.">${(s.custom_hint || '').replace(/</g, '&lt;')}</textarea>
              <span class="bf-adv-help">Free-form text appended to <strong>every</strong> model prompt (blank = off). Recorded on each result as <code>execution_settings.hint_text</code>.</span>
            </div>

          </div>
        </div>

      </div>
    </details>`;
}

export function _wireAdvancedSettings(container) {
    // Persist on change — number inputs and select
    const persist = (el) => {
        const key = el.dataset.advKey;
        if (!key) return;
        const current = _loadAdvancedSettings();
        if (el.type === 'checkbox') {
            current[key] = el.checked;
        } else if (el.tagName === 'SELECT' && el.dataset.advType !== 'string') {
            current[key] = parseInt(el.value, 10);
        } else if (el.tagName === 'TEXTAREA' || el.dataset.advType === 'string') {
            current[key] = el.value;
        } else {
            const v = parseFloat(el.value);
            if (!Number.isNaN(v)) current[key] = v;
        }
        save(SK_ADVANCED, JSON.stringify(current));
        _updateAdvancedSummary(container, current);
    };
    container.addEventListener('change', e => {
        if (e.target.dataset.advKey) persist(e.target);
    });
    container.addEventListener('input', e => {
        // Textarea/string inputs don't fire change reliably until blur
        if (e.target.dataset.advKey && (e.target.tagName === 'TEXTAREA' || e.target.dataset.advType === 'string')) {
            persist(e.target);
        }
    });

    // Reset buttons
    container.addEventListener('click', e => {
        const btn = e.target.closest('[data-adv-reset]');
        if (!btn) return;
        const group = btn.dataset.advReset;
        const current = _loadAdvancedSettings();
        if (group === 'judge') {
            Object.assign(current, ADV_JUDGE_DEFAULTS);
        } else if (group === 'pipeline') {
            Object.assign(current, ADV_PIPELINE_DEFAULTS);
        } else if (group === 'fairness') {
            Object.assign(current, ADV_FAIRNESS_DEFAULTS);
        }
        save(SK_ADVANCED, JSON.stringify(current));
        // Repopulate inputs
        container.querySelectorAll('[data-adv-key]').forEach(el => {
            const k = el.dataset.advKey;
            if (el.type === 'checkbox') {
                el.checked = !!current[k];
            } else if (el.tagName === 'SELECT') {
                el.value = String(current[k]);
            } else {
                el.value = current[k];
            }
        });
        _updateAdvancedSummary(container, current);
    });
}

export function _updateAdvancedSummary(container, s) {
    const badge = container.querySelector('#bv2-advanced-badge');
    if (!badge) return;
    const isDefault = JSON.stringify(s) === JSON.stringify({ ...ADV_JUDGE_DEFAULTS, ...ADV_PIPELINE_DEFAULTS, ...ADV_FAIRNESS_DEFAULTS });
    const summaryExtra = isDefault ? 'defaults' : `temp ${s.temperature}, ${s.num_predict} tokens, ${s.max_retries} retries`;
    const contractSummary = s.answer_contract_mode === 'off' ? 'contract off' : 'contract auto';
    badge.textContent = `Judge: ${summaryExtra} | Exec: ${s.response_max_tokens} tok max, ${contractSummary} | Timeouts: ${_fmtMs(s.per_test_timeout_ms)}/test, ${_fmtMs(s.warmup_timeout_cold)} warmup`;
}

export function _readAdvancedSettings(container) {
    const s = { ...ADV_JUDGE_DEFAULTS, ...ADV_PIPELINE_DEFAULTS, ...ADV_FAIRNESS_DEFAULTS };
    container.querySelectorAll('[data-adv-key]').forEach(el => {
        const k = el.dataset.advKey;
        if (el.type === 'checkbox') {
            s[k] = el.checked;
        } else if (el.tagName === 'SELECT' && el.dataset.advType !== 'string') {
            s[k] = parseInt(el.value, 10);
        } else if (el.tagName === 'TEXTAREA' || el.dataset.advType === 'string') {
            s[k] = el.value;
        } else {
            const v = parseFloat(el.value);
            if (!Number.isNaN(v)) s[k] = v;
        }
    });
    return s;
}
