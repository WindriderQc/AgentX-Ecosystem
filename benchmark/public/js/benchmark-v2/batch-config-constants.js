// batch-config-constants.js — shared constants + pure helpers for the
// benchmark-v2 batch configuration form. Extracted from batch-config.js
// (task 0229) so the advanced-settings, multi-judge, and model-checklist
// modules can share storage keys, tier config, and size/quant helpers without
// duplicating literals. No DOM/state dependencies.

import { esc } from './helpers.js';

// ── Storage keys ────────────────────────────────────────────────────────────

export const SK_DEPTH    = 'bv2_depthMatrix';
export const SK_JUDGE    = 'bv2_judgeConfig';
export const SK_MODELS   = 'bv2_selectedModels';
export const SK_HOST     = 'bv2_execHost';
export const SK_THINK    = 'bv2_think';
export const SK_ADVANCED = 'bv2_advancedSettings';

// ── Tier config ─────────────────────────────────────────────────────────────

export const TIER_CONFIG = {
    small:  { label: 'SMALL ≤4B',   trait: 'fast, low VRAM',       color: '#66bb6a', bg: '#0d1a0d', border: '#1a3a1a' },
    medium: { label: 'MEDIUM 4–10B', trait: 'balanced',             color: '#ffb74d', bg: '#1a1500', border: '#2a2000' },
    large:  { label: 'LARGE >10B',       trait: 'powerful, high VRAM',  color: '#ef5350', bg: '#1a0a0a', border: '#2a0a0a' },
};

// ── Advanced Settings Defaults ────────────────────────────────────────────────

export const ADV_JUDGE_DEFAULTS = {
    temperature: 0.1,
    num_predict: 800,
    num_ctx: 8192,
    max_retries: 2,
    timeout: 30000,
    voting_count: 1,
    think: false
};

export const ADV_PIPELINE_DEFAULTS = {
    response_max_tokens: 8192,
    per_test_timeout_ms: 600000,
    warmup_timeout_cold: 60000,
    warmup_timeout_loaded: 30000,
    judge_drain_timeout_ms: 1800000,
    judge_stall_timeout_ms: 120000,
    answer_contract_mode: 'auto',
    include_length_hint: false,
    length_hint_template: 'Keep your response under {max} tokens.',
    custom_hint: ''
};

// Fairness & sampling controls. Without these pinned, host-vs-host comparison
// is unfair: each host runs at its own profiled num_ctx (different KV cache
// pressure → different decode speed) and each Modelfile contributes its own
// sampling defaults (different temperature/top_p → score variance is partly
// RNG, not skill). force_num_ctx=null honors the per-host profile (legacy);
// set to a number to make every host run at the same context.
export const ADV_FAIRNESS_DEFAULTS = {
    force_num_ctx: null,
    exec_temperature: 0.2,
    exec_top_p: 0.9,
    exec_top_k: 40,
    exec_repeat_penalty: 1.1,
    exec_seed: 42,
    exec_repeats: 1
};

// ── Multi-Judge defaults ──────────────────────────────────────────────────────

export const MJ_DEFAULT = Object.freeze({
    rule: 'off',
    judges: [],         // [{ model, host }]
    tiebreaker: null,   // { model, host } | null
    autoMinLevel: 4,
    confidenceThreshold: 0.8
});

export const MJ_RULE_LABELS = {
    off:            { label: 'Off — single judge (recommended)', describe: 'No multi-judge. Default for normal benchmark runs until consensus judging is hardened.' },
    l4l5:           { label: 'Level 4–5 only',                    describe: 'Run multi-judge only on the hardest prompts (level ≥ autoMinLevel).' },
    low_confidence: { label: 'Low confidence / review only', describe: 'Escalate when the primary judge\'s confidence is below threshold or the row is flagged for review.' },
    always:         { label: 'Always (every result)',                  describe: 'Multi-judge every result. ~2–3× judge wall-time. Use only for calibration runs.' },
    custom:         { label: 'Custom — pick judges/triggers',     describe: 'You control which judges, tiebreaker, and triggers fire.' }
};

// ── Formatting / size helpers ─────────────────────────────────────────────────

export function _fmtMs(ms) {
    if (ms >= 60000) return `${Math.round(ms / 60000)}min`;
    return `${Math.round(ms / 1000)}s`;
}

export function _slug(s) { return String(s || '').replace(/[^a-zA-Z0-9]/g, '-'); }

export function _emptyMsg(msg) {
    return `
      <div class="r-empty bf-empty-state">
        <div class="bf-empty-title">Waiting for setup</div>
        <div class="bf-empty-copy">${esc(msg)}</div>
      </div>`;
}

export function _quantKey(value) {
    const match = String(value || '').match(/\b(?:q\d+(?:_[a-z0-9]+)*|f16)\b/i);
    return match ? match[0].toLowerCase().replace(/[^a-z0-9]/g, '') : '';
}

export function _hasLocalSameSizeAlias(raw, rawModels, detailByRawName) {
    const name = String(raw || '');
    if (!/^hf\.co\//i.test(name)) return false;
    const detail = detailByRawName.get(name);
    const size = Number(detail?.size) || 0;
    if (!size) return false;
    const quant = _quantKey(name) || _quantKey(detail?.quantization);

    return rawModels.some(other => {
        const otherName = String(other || '');
        if (!otherName || otherName === name) return false;
        if (/^(ax\/|hf\.co\/)/i.test(otherName)) return false;
        const otherDetail = detailByRawName.get(otherName);
        const otherSize = Number(otherDetail?.size) || 0;
        if (!otherSize || Math.abs(otherSize - size) > 1024 * 1024) return false;
        const otherQuant = _quantKey(otherName) || _quantKey(otherDetail?.quantization);
        return !quant || !otherQuant || quant === otherQuant;
    });
}

export function _parseParamSize(s) {
    if (!s) return 0;
    const m = String(s).match(/([\d.]+)\s*([bBmM])\b/);
    if (!m) return 0;
    const n = parseFloat(m[1]);
    if (!Number.isFinite(n)) return 0;
    return m[2].toLowerCase() === 'm' ? n / 1000 : n;
}

export function _tierGroup(paramSize) {
    const n = _parseParamSize(paramSize);
    if (n <= 0) return 'medium'; // unknown → medium
    if (n <= 4) return 'small';
    if (n <= 10) return 'medium';
    return 'large';
}

export function _sizeClass(paramSize) {
    const n = _parseParamSize(paramSize);
    if (n <= 0) return '';
    if (n <= 4) return 'mc-size-s';
    if (n <= 10) return 'mc-size-m';
    if (n <= 20) return 'mc-size-l';
    return 'mc-size-xl';
}

export function _formatDiskSize(bytes) {
    if (!bytes) return '';
    const gb = bytes / (1024 * 1024 * 1024);
    return gb >= 1 ? `${gb.toFixed(1)} GB` : `${(bytes / (1024 * 1024)).toFixed(0)} MB`;
}
