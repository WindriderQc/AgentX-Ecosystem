// scoring-system.js — Combined "How Scoring Works" + Shared Weight Convention +
// "Customize Weights" trigger. Replaces the old nav-bar Scoring Profile button
// and the standalone Shared Weight pill row at the bottom of the podium.

import { openScoringProfilePanel } from '../benchmark/scoring-profile.js';

const WEIGHT_COLORS = {
  high:   { bg: '#1a2a1a', text: '#66bb6a' },
  medium: { bg: '#1a1a10', text: '#f6bb42' },
  low:    { bg: '#1a1510', text: '#888' }
};

function weightTier(w) {
  if (w >= 0.18) return WEIGHT_COLORS.high;
  if (w >= 0.12) return WEIGHT_COLORS.medium;
  return WEIGHT_COLORS.low;
}

function weightsPills(weights) {
  if (!weights || typeof weights !== 'object') return '';
  const sorted = Object.entries(weights).sort((a, b) => b[1] - a[1]);
  return sorted.map(([cat, w]) => {
    const tier = weightTier(w);
    return `<span class="pod-weight-pill" style="background:${tier.bg};color:${tier.text}">${cat} ${Math.round(w * 100)}%</span>`;
  }).join('');
}

const HOW_SCORING_BODY = `
  <p><strong>Quality Ranking + Performance Stats — combined.</strong> Each model is scored across 7 evaluation categories (Coding, Reasoning, Math, Knowledge, Instruction, Creative, Translation) and benchmarked for throughput / latency on its host.</p>
  <p class="cb-explainer-formula"><strong>UGRank formula:</strong> weighted_quality &minus; category_coverage_penalty &minus; hard_level_penalty + consistency_bonus (divided by 10 for 0–10 scale).</p>
  <ul>
    <li><strong>Weighted Quality:</strong> Average quality (0–10) across categories, weighted by category importance.</li>
    <li><strong>Category Coverage Penalty:</strong> Models lose points for untested categories — prevents narrow specialists ranking #1.</li>
    <li><strong>Hard-Level Penalty:</strong> Models lose points when category evidence has not reached the configured full-scope difficulty threshold.</li>
    <li><strong>Consistency Bonus:</strong> Even performance across categories earns bonus points.</li>
    <li><strong>Performance Coeff:</strong> Normalised tok/s × success rate (1.0 = elite throughput).</li>
  </ul>`;

/**
 * Render the unified Scoring System section.
 * @param {HTMLElement} container - an .r-section element
 * @param {object} opts - { categoryWeights }
 */
export function renderScoringSystem(container, opts = {}) {
  if (!container) return;
  const pills = weightsPills(opts.categoryWeights);

  container.innerHTML = `
    <div class="r-sec-head">
      <span class="r-sec-icon">⚖️</span>
      <span class="r-sec-title r-t-cyan">Scoring System</span>
      <span class="r-sec-toggle">▼</span>
    </div>
    <div class="r-sec-body">
      <details class="cb-explainer">
        <summary>How Scoring Works <span class="cb-explainer-caret">&#9660;</span></summary>
        <div class="cb-explainer-body">${HOW_SCORING_BODY}</div>
      </details>

      ${pills ? `
      <div class="pod-shared-weights ss-shared-weights">
        <div class="pod-shared-weights-head">
          <div class="pod-section-label">Shared Weight Convention</div>
          <div class="pod-shared-weights-note">Every model uses the same scoring mix.</div>
        </div>
        <div class="ss-pill-row">${pills}</div>
        <div class="ss-actions">
          <button class="r-nav-btn" id="scoring-profile-btn" title="Configure scoring weights and formula parameters">
            <i class="fas fa-sliders-h"></i> Customize Weights…
          </button>
        </div>
      </div>` : `
      <div class="ss-actions">
        <button class="r-nav-btn" id="scoring-profile-btn" title="Configure scoring weights and formula parameters">
          <i class="fas fa-sliders-h"></i> Customize Weights…
        </button>
      </div>`}
    </div>`;

  const btn = container.querySelector('#scoring-profile-btn');
  if (btn) btn.addEventListener('click', openScoringProfilePanel);
}
