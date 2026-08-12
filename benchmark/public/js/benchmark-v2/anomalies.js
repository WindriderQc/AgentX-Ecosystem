// anomalies.js — Anomalies panel for benchmark-v2 (section 2.9)
// Flags results with anomaly_flag set or outlier scores (z-score based).
// Exported API: renderAnomalies(container, batch), updateAnomalies(container, batch)

// ── Helpers ───────────────────────────────────────────────────────────────────

function esc(str) {
    if (str == null) return '';
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

/**
 * Truncate a string to maxLen characters, appending ellipsis if needed.
 */
function truncate(str, maxLen = 72) {
    const s = String(str || '');
    return s.length > maxLen ? s.slice(0, maxLen) + '…' : s;
}

/**
 * Compute the mean of an array of numbers.
 */
function mean(arr) {
    if (!arr.length) return 0;
    return arr.reduce((a, b) => a + b, 0) / arr.length;
}

/**
 * Compute standard deviation.
 */
function stddev(arr, avg) {
    if (arr.length < 2) return 0;
    const variance = arr.reduce((sum, v) => sum + (v - avg) ** 2, 0) / arr.length;
    return Math.sqrt(variance);
}

/**
 * Extract anomalous results from batch data.
 * A result is anomalous if:
 *   1. It has anomaly_flag set (truthy), OR
 *   2. It is excluded from the leaderboard, OR
 *   3. Its score is a z-score outlier (|z| > 2.0) compared to the batch's
 *      scored results — only if there are ≥ 5 scored results to compute from.
 *
 * `needs_review` is intentionally not treated as an anomaly here. It is a
 * judge-confidence workflow signal and can be common on difficult suites.
 *
 * Returns an array of result objects annotated with `.anomaly_reason`.
 */
function detectAnomalies(batch) {
    const results = batch.results || [];
    const scored = results.filter(r => r.quality_score != null);

    // Build z-score baseline
    let scoreArr = scored.map(r => Number(r.quality_score));
    const avg = mean(scoreArr);
    const sd  = stddev(scoreArr, avg);

    const Z_THRESHOLD = 2.0;
    const useZScore = scored.length >= 5 && sd > 0;

    const anomalies = [];
    const seen = new Set();

    for (const r of results) {
        if (!r._id && !r.id && (!r.model || !r.prompt_id)) continue;
        const id = r._id || r.id || (r.model + ':' + (r.prompt_id || r.prompt));
        if (seen.has(id)) continue;

        let reason = null;

        if (r.anomaly_flag) {
            reason = r.anomaly_reason || r.anomaly_label || 'flagged';
        } else if (r.excluded_from_leaderboard) {
            reason = r.review_reason ? `excluded: ${r.review_reason}` : 'excluded from leaderboard';
        } else if (useZScore && r.quality_score != null) {
            const z = (Number(r.quality_score) - avg) / sd;
            if (z < -Z_THRESHOLD) {
                reason = `low outlier (z=${z.toFixed(1)})`;
            } else if (z > Z_THRESHOLD) {
                reason = `high outlier (z=${z.toFixed(1)})`;
            }
        }

        if (reason) {
            seen.add(id);
            anomalies.push({ ...r, _anomaly_reason: reason });
        }
    }

    return anomalies;
}

/**
 * Return CSS class for score colouring within anomaly items.
 * Below 4 → red (.low), everything else → orange (.flag).
 */
function scoreClass(score) {
    if (score == null) return 'flag';
    return Number(score) < 4 ? 'low' : 'flag';
}

// ── Builders ─────────────────────────────────────────────────────────────────

function buildAnomalyItem(r) {
    const id          = r._id || r.id || '';
    const model       = r.model || '—';
    const promptText  = r.prompt_name || r.prompt_preview || r.prompt || r.prompt_id || '(unknown prompt)';
    const reason      = r._anomaly_reason || '—';
    const score       = r.quality_score != null ? Number(r.quality_score).toFixed(1) : '—';
    const sCls        = r.quality_score != null ? scoreClass(r.quality_score) : 'flag';
    const reviewHref  = id ? `/courthouse?result=${esc(id)}` : '/courthouse';

    return `
    <div class="an-item">
      <span class="an-warn">&#9888;</span>
      <span class="an-model">${esc(model)}</span>
      <span class="an-prompt" title="${esc(promptText)}">${esc(truncate(promptText))}</span>
      <span class="an-reason">${esc(reason)}</span>
      <span class="an-score ${esc(sCls)}">${esc(score)}</span>
      <a class="an-review" href="${reviewHref}" target="_blank">Review &#8594;</a>
    </div>`;
}

function buildAnomaliesHTML(anomalies) {
    if (!anomalies.length) return '';

    return anomalies.map(buildAnomalyItem).join('');
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Initial render of the anomalies panel.
 * Hides the container if there are no anomalies.
 *
 * @param {HTMLElement} container — the #anomalies div
 * @param {object}      batch     — batch data from fetchBatchProgress()
 */
export function renderAnomalies(container, batch) {
    const anomalies = detectAnomalies(batch);

    if (!anomalies.length) {
        container.style.display = 'none';
        return;
    }

    container.style.display = '';

    const countEl     = container.querySelector('#an-count');
    const listEl      = container.querySelector('#an-list');
    const linkEl      = container.querySelector('#an-courthouse-link');

    if (countEl) countEl.textContent = String(anomalies.length);
    if (listEl)  listEl.innerHTML    = buildAnomaliesHTML(anomalies);
    if (linkEl)  linkEl.href         = '/courthouse';
}

/**
 * Update the anomalies panel in place.
 * Same logic as renderAnomalies — re-detects and rewrites the list.
 *
 * @param {HTMLElement} container
 * @param {object}      batch
 */
export function updateAnomalies(container, batch) {
    renderAnomalies(container, batch);
}
