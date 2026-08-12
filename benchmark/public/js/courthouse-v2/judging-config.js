// judging-config.js — Judging Configuration section for courthouse-v2
// Renders a 2-column grid of 6 config items.

/**
 * Build a single config item HTML.
 * @param {string} icon
 * @param {string} label
 * @param {string} value
 * @param {string} note  - dim explanation text
 */
function cfgItem(icon, label, value, note = '') {
    return `
        <div class="cfg-item">
            <span class="cfg-icon">${icon}</span>
            <span class="cfg-label">${label}</span>
            <span class="cfg-val">${value}</span>
            ${note ? `<span class="cfg-dim">${note}</span>` : ''}
        </div>`;
}

/**
 * Derive multi-judge display string from config.
 * @param {object} config
 */
function multiJudgeLabel(config) {
    if (config.multi_judge_enabled === false) return 'Off';
    const raw = config.multi_judge_rule
        ?? config.multi_judge
        ?? config.judge_config?.multi_judge
        ?? null;
    if (!raw) return 'Off (default)';

    if (typeof raw === 'object') {
        if (raw.enabled === false) return 'Off';
        const rule = raw.rule || 'custom';
        const judges = Array.isArray(raw.judges) ? raw.judges.length : 0;
        const judgeTag = judges > 0 ? ` · ${judges} judges` : '';
        const tieTag = raw.tiebreaker ? ' + tiebreaker' : '';
        switch (rule) {
            case 'l4l5':           return `L4–L5${judgeTag}${tieTag}`;
            case 'low_confidence': return `Low-confidence${judgeTag}${tieTag}`;
            case 'always':         return `Always${judgeTag}${tieTag}`;
            case 'custom':         return `Custom${judgeTag}${tieTag}`;
            default:               return `${rule}${judgeTag}${tieTag}`;
        }
    }

    const ruleStr = String(raw).toLowerCase();
    switch (ruleStr) {
        case 'off':
        case 'none':            return 'Off';
        case 'l4l5':            return 'L4–L5';
        case 'all':
        case 'always':          return 'Always';
        case 'low_confidence':  return 'Low-confidence';
        default:                return ruleStr;
    }
}

/**
 * Derive tiebreaker display string from config.
 * @param {object} config
 */
function tiebreakerLabel(config) {
    const tb = config.tiebreaker ?? config.tiebreaker_strategy ?? null;
    if (!tb) return 'Weighted majority';
    if (typeof tb === 'string') return tb;
    return tb.strategy ?? tb.method ?? 'Weighted majority';
}

/**
 * Derive anomaly z-score threshold display string.
 * @param {object} config
 */
function anomalyLabel(config) {
    const z = config.anomaly_z_threshold
        ?? config.anomaly_detection?.z_threshold
        ?? config.z_score_threshold
        ?? null;
    if (z == null) return 'z > 2.5';
    return `z > ${Number(z).toFixed(1)}`;
}

/**
 * Derive ground truth entry count display string.
 * @param {object} config
 */
function groundTruthLabel(config) {
    const count = config.ground_truth_count
        ?? config.ground_truth_entries
        ?? config.ground_truth?.count
        ?? null;
    if (count == null) return '—';
    return Number(count).toLocaleString() + ' entries';
}

/**
 * Render the Judging Configuration section into container.
 *
 * config shape (from fetchConfig()):
 *   scoring_method, confidence_threshold,
 *   multi_judge_enabled / multi_judge_rule / multi_judge,
 *   tiebreaker / tiebreaker_strategy,
 *   anomaly_z_threshold / anomaly_detection.z_threshold,
 *   ground_truth_count / ground_truth_entries
 *
 * @param {HTMLElement} container
 * @param {object} config - response from fetchConfig()
 */
export function renderJudgingConfig(container, config) {
    const cfg = config?.data ?? config ?? {};

    const scoringMethod = cfg.scoring_method || 'Decomposed Binary';
    const confThreshold = cfg.confidence_threshold != null
        ? Number(cfg.confidence_threshold).toFixed(2)
        : '0.80';

    const thinkMode = cfg.think === true ? 'Enabled' : cfg.think === false ? 'Disabled' : 'Disabled (default)';

    const items = [
        cfgItem('⚖️', 'Scoring Method',      scoringMethod,           'how responses are evaluated'),
        cfgItem('🎯', 'Confidence Threshold', confThreshold,           'min score confidence accepted'),
        cfgItem('👥', 'Multi-Judge',          multiJudgeLabel(cfg),    'when extra judges are invoked'),
        cfgItem('🔀', 'Tiebreaker',           tiebreakerLabel(cfg),    'used when judges diverge'),
        cfgItem('📊', 'Anomaly Detection',    anomalyLabel(cfg),       'flags statistical outliers'),
        cfgItem('📌', 'Ground Truth',         groundTruthLabel(cfg),   'calibration reference entries'),
        cfgItem('🧠', 'Thinking Mode',        thinkMode,               'think:false prevents token waste on reasoning models'),
    ].join('');

    container.innerHTML = `
        <div class="r-sec-head">
            <span class="r-sec-icon">⚙️</span>
            <span class="r-sec-title r-t-orange">Judging Configuration</span>
        </div>
        <div class="config-grid">
            ${items}
        </div>`;
}
