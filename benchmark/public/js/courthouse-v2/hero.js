// hero.js — "The Judge's Chambers" hero section for courthouse-v2
// Renders headline, 5 stat cards, and action buttons row.

/**
 * Build a single stat card element string.
 * @param {string} label
 * @param {string|number} value
 * @param {string} valClass  - extra class on .r-stat-val (e.g. 'v-review')
 */
function statCard(label, value, valClass = '') {
    return `<div class="r-stat-card ch-stat-card">
        <div class="r-stat-val ${valClass}">${value}</div>
        <div class="r-stat-label">${label}</div>
    </div>`;
}

/**
 * Build a single action button string.
 * @param {string} label
 * @param {string} sectionId - target element id for smooth scroll
 * @param {boolean} primary   - amber primary or gray secondary
 */
function actionBtn(label, sectionId, primary = false) {
    const cls = primary ? 'ha-btn primary' : 'ha-btn secondary';
    return `<button class="${cls}" data-section="${sectionId}">${label}</button>`;
}

/**
 * Derive courthouse stat counts from dashboard data.
 *
 * Dashboard data shape (from /api/benchmark/dashboard):
 *   data.overview.total_tests
 *   data.model_stats[] — per model aggregated stats
 *
 * Fields on BenchmarkResult relevant here:
 *   needs_review  — result needs human attention
 *   human_score   — set when a human has reviewed
 *   human_score + original quality_score differ → override
 *   ground truth entries are tracked separately (JudgeGroundTruth)
 *
 * Because the dashboard doesn't expose review/override/gt counts directly,
 * we derive from model_stats where available and fall back to totals.
 */
function deriveCounts(dashboard) {
    const d = dashboard?.data || {};
    const overview = d.overview || {};
    const totalResults = overview.total_tests ?? null;
    const needReview = overview.needs_review_count ?? null;
    const approved = overview.human_reviewed_count ?? null;
    const overrides = overview.override_count ?? null;
    const groundTruth = overview.ground_truth_count ?? null;

    return { totalResults, needReview, approved, overrides, groundTruth };
}

/**
 * Render the courthouse hero into container.
 *
 * @param {HTMLElement} container - the #hero element
 * @param {object} dashboard      - full response from fetchDashboard()
 */
export function renderHero(container, dashboard) {
    const { totalResults, needReview, approved, overrides, groundTruth } =
        deriveCounts(dashboard);

    container.innerHTML = `
        <div class="r-hero r-hero-amber">
            <div class="r-hero-top">
                <div>
                    <div class="r-hero-headline ch-hero-headline">The Judge's Chambers</div>
                    <div class="r-hero-sub">Review scores, calibrate judges, explore the test bank. Every result earns its place.</div>
                </div>
                <div class="r-hero-stats">
                    ${statCard('Results', formatCount(totalResults), 'v-total')}
                    ${statCard('Need Review', formatCount(needReview), 'v-review')}
                    ${statCard('Approved', formatCount(approved), 'v-approved')}
                    ${statCard('Overrides', formatCount(overrides), 'v-override')}
                    ${statCard('Ground Truth', formatCount(groundTruth), 'v-calib')}
                </div>
            </div>
            <div class="hero-actions">
                ${actionBtn(`Review Queue (${needReview})`, 'review-queue', true)}
                ${actionBtn('Full Ledger', 'results-ledger')}
                ${actionBtn('Judge Roster', 'judge-roster')}
                ${actionBtn('Test Library', 'test-library')}
                ${actionBtn('Discrimination', 'discrimination')}
                ${actionBtn('Export CSV', 'results-ledger')}
                <a href="/leaderboard" class="ha-btn secondary" style="text-decoration:none;">View Leaderboard &rarr;</a>
                <a href="/results-explorer" class="ha-btn secondary" style="text-decoration:none;">Results Explorer &rarr;</a>
            </div>
        </div>`;

    // Wire smooth-scroll on action buttons
    container.querySelectorAll('[data-section]').forEach(btn => {
        btn.addEventListener('click', () => {
            const sectionId = btn.dataset.section;
            const el = document.getElementById(sectionId);
            if (el) {
                el.scrollIntoView({ behavior: 'smooth' });
            }
        });
    });
}

function formatCount(value) {
    return value == null ? '—' : Number(value).toLocaleString();
}
