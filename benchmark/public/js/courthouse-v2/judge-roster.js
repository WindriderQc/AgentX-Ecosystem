// judge-roster.js — Judge Roster section for courthouse-v2
// Renders a 3-column card grid of judge models with calibration stats.

/**
 * Build calibration bar row HTML.
 * @param {string} label
 * @param {number} pct        - 0–1 fill fraction
 * @param {string} fillColor  - CSS color string
 * @param {string} displayVal - text shown on right
 */
function calibRow(label, pct, fillColor, displayVal) {
    const fillPct = Math.max(0, Math.min(1, pct || 0)) * 100;
    return `
        <div class="jc-calib-row">
            <div class="jc-calib-label">${label}</div>
            <div class="jc-calib-bar">
                <div class="jc-calib-fill" style="width:${fillPct}%;background:${fillColor};"></div>
            </div>
            <div class="jc-calib-val">${displayVal}</div>
        </div>`;
}

/**
 * Build a single judge card element string.
 * @param {object} judge - entry from fetchJudgeLeaderboard() response
 * @param {boolean} isDefault
 */
function judgeCard(judge, isDefault) {
    const name = judge.judge_model || judge.model || 'Unknown';
    const evalCount = (judge.count ?? judge.eval_count ?? judge.total_evaluations ?? 0).toLocaleString();
    const successRate = judge.success_rate != null
        ? judge.success_rate.toFixed(1) + '%'
        : '—';
    const avgScore = judge.avg_score_given != null
        ? judge.avg_score_given.toFixed(1)
        : '—';

    // Operational stats
    const successFrac = (judge.success_rate ?? 0) / 100;
    const avgLatency = judge.avg_latency ?? 0;
    const latencyPct = Math.min(1, avgLatency / 30000);
    const avgExplLen = judge.avg_explanation_len ?? 0;
    const explPct = Math.min(1, avgExplLen / 2000);

    const defaultBadge = isDefault
        ? `<span class="judge-default">DEFAULT</span>`
        : '';
    const cardClass = isDefault ? 'judge-card is-default' : 'judge-card';

    const successColor = successFrac >= 0.90 ? 'var(--r-good)' : 'var(--r-anomaly)';

    // Calibration data (from JudgeAccuracyMatrix, merged by index.js)
    const cal = judge.calibration;
    let calSection = '';
    if (cal) {
        const passColor = cal.pass_rate >= 80 ? 'var(--r-good)' : cal.pass_rate >= 50 ? 'var(--r-anomaly)' : 'var(--r-error)';
        const devColor = cal.avg_deviation <= 1.0 ? 'var(--r-good)' : cal.avg_deviation <= 1.5 ? 'var(--r-anomaly)' : 'var(--r-error)';
        const calDate = cal.calibrated_at ? new Date(cal.calibrated_at).toLocaleDateString() : '—';
        calSection = `
            <div class="jc-calib-section" style="margin-top:8px;padding-top:8px;border-top:1px solid var(--r-border)">
                <div style="font-size:10px;color:var(--r-text-dim);letter-spacing:0.5px;margin-bottom:6px">CALIBRATION</div>
                ${calibRow('pass rate', cal.pass_rate / 100, passColor, cal.pass_rate + '%')}
                ${calibRow('avg deviation', Math.min(1, cal.avg_deviation / 3), devColor, cal.avg_deviation.toFixed(2))}
                <div style="font-size:10px;color:var(--r-text-dim);margin-top:4px">vs reference · ${calDate} · ${cal.ground_truth_count || 0} entries</div>
            </div>`;
    } else {
        calSection = `
            <div class="jc-calib-section" style="margin-top:8px;padding-top:8px;border-top:1px solid var(--r-border)">
                <div style="font-size:10px;color:var(--r-text-dim);letter-spacing:0.5px;margin-bottom:4px">CALIBRATION</div>
                <div style="font-size:11px;color:var(--r-text-dim)">Not calibrated</div>
            </div>`;
    }

    return `
        <div class="${cardClass}">
            <div class="jc-head">
                <div class="jc-name">${name}</div>
                ${defaultBadge}
            </div>
            <div class="jc-stats">
                <span><span class="jcs-val">${evalCount}</span> evals</span>
                <span><span class="jcs-val">${successRate}</span> success</span>
                <span><span class="jcs-val">${avgScore}</span> avg score</span>
            </div>
            <div class="jc-calib">
                ${calibRow('success rate', successFrac, successColor, (successFrac * 100).toFixed(0) + '%')}
                ${calibRow('avg latency', latencyPct, 'var(--r-judge)', avgLatency > 0 ? (avgLatency / 1000).toFixed(1) + 's' : '—')}
                ${calibRow('expl length', explPct, 'var(--r-judge)', avgExplLen > 0 ? avgExplLen.toLocaleString() + ' ch' : '—')}
            </div>
            ${calSection}
        </div>`;
}

/**
 * Render the Judge Roster section into container.
 *
 * judgeData shape (from fetchJudgeLeaderboard()):
 *   { judges: [...], primary_judge: string }
 *   or an array of judge entries directly.
 *
 * Each judge entry (from getJudgeLeaderboard aggregation):
 *   judge_model, judge_host, count, avg_latency, success_rate,
 *   avg_score_given, avg_explanation_len, score_distribution, is_default
 *
 * @param {HTMLElement} container
 * @param {object|Array} judgeData - response from fetchJudgeLeaderboard()
 */
export function renderJudgeRoster(container, judgeData) {
    // Normalise response shape
    let judges = [];
    let primaryJudge = null;

    if (Array.isArray(judgeData)) {
        judges = judgeData;
    } else if (judgeData && typeof judgeData === 'object') {
        judges = judgeData.judges ?? judgeData.data ?? [];
        primaryJudge = judgeData.primary_judge ?? null;
    }

    if (!judges.length) {
        container.innerHTML = `
            <div class="r-sec-head">
                <span class="r-sec-icon">👨‍⚖️</span>
                <span class="r-sec-title r-t-purple">Judge Roster</span>
            </div>
            <div class="r-empty">No judge data available.</div>`;
        return;
    }

    const cards = judges.map(j => {
        const isDefault = j.is_default === true
            || (primaryJudge && (j.judge_model === primaryJudge || j.model === primaryJudge));
        return judgeCard(j, isDefault);
    }).join('');

    container.innerHTML = `
        <div class="r-sec-head">
            <span class="r-sec-icon">👨‍⚖️</span>
            <span class="r-sec-title r-t-purple">Judge Roster</span>
        </div>
        <div class="judge-grid">
            ${cards}
        </div>`;
}
