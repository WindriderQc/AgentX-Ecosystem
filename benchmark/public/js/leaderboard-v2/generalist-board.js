// generalist-board.js — Lean quality ranking table for the leaderboard section
import { getReadinessMap, getBadgeHtml } from '../model-profiler/components/readiness-cache.js';

function _shortHost(url) {
    return String(url || '').replace(/^https?:\/\//, '').replace(/:11434$/, '');
}

const MEDAL = ['🥇', '🥈', '🥉'];
const RANK_CLASS = ['r1', 'r2', 'r3'];
const CATEGORY_META = {
  coding: { icon: '💻', label: 'Coding' },
  reasoning: { icon: '🧠', label: 'Reasoning' },
  math: { icon: '🔢', label: 'Math' },
  knowledge: { icon: '📚', label: 'Knowledge' },
  instruction: { icon: '📋', label: 'Instruction' },
  creative: { icon: '🎨', label: 'Creative' },
  translation: { icon: '🌐', label: 'Translation' }
};
const CATEGORY_ORDER = Object.keys(CATEGORY_META);

function scoreClass(score) {
  if (score > 8) return 'h';
  if (score > 6) return 'm';
  return 'l';
}

function renderRank(index) {
  if (index < 3) {
    return `<td class="gr ${RANK_CLASS[index]}">${MEDAL[index]}</td>`;
  }
  return `<td class="gr rn">#${index + 1}</td>`;
}

function renderScore(score) {
  const cls = scoreClass(score);
  return `<td class="gs ${cls}">${score.toFixed(2)}</td>`;
}

function renderConfidence(confidence) {
  const val = confidence ?? 0;
  const cls = val <= 0.8 ? 'good' : val <= 1.4 ? 'watch' : 'bad';
  return `<span class="g-evidence-val ${cls}">±${val.toFixed(2)}</span>`;
}

function renderConfidenceBadge(entry) {
  const count = entry.testCount || 0;
  const calibrated = entry.judgeCalibrated || false;

  if (count === 0) {
    return '<span title="Insufficient data" style="color:var(--r-text-dim)">—</span>';
  }
  if (calibrated && count >= 10) {
    return '<span title="Calibrated judge, 10+ results" style="color:var(--r-good)">✓</span>';
  }
  return '<span title="Uncalibrated judge or few results" style="color:var(--r-anomaly)">⚠</span>';
}

function renderTrend(trend) {
  if (!trend) return '<td class="gtrend"></td>';
  const { direction, delta } = trend;
  if (direction === 'new') {
    return `<td class="gtrend"><span class="gd new">NEW</span></td>`;
  }
  if (direction === 'up') {
    const d = delta != null ? `+${Number(delta).toFixed(1)}` : '';
    return `<td class="gtrend"><span class="gd up">▲ ${d}</span></td>`;
  }
  if (direction === 'dn' || direction === 'down') {
    const d = delta != null ? `-${Math.abs(Number(delta)).toFixed(1)}` : '';
    return `<td class="gtrend"><span class="gd dn">▼ ${d}</span></td>`;
  }
  return '<td class="gtrend"></td>';
}

function entryKey(entry) {
  return `${entry.model || ''}::${entry.host || ''}`;
}

function categoryScore(entry, category) {
  const raw = entry.categoryScores?.[category];
  return raw !== null && raw !== undefined && Number.isFinite(Number(raw))
    ? Number(raw)
    : null;
}

function buildChampionMap(rankings) {
  const champions = new Map();

  for (const category of CATEGORY_ORDER) {
    let winner = null;
    let winnerScore = -Infinity;

    for (const entry of rankings) {
      const score = categoryScore(entry, category);
      if (score === null) continue;
      if (score > winnerScore) {
        winner = entry;
        winnerScore = score;
      }
    }

    if (!winner) continue;

    const key = entryKey(winner);
    const current = champions.get(key) || [];
    current.push({
      ...CATEGORY_META[category],
      score: winnerScore
    });
    champions.set(key, current);
  }

  return champions;
}

function renderChampionBadges(entry, championMap) {
  const champions = championMap.get(entryKey(entry)) || [];
  if (champions.length === 0) return '';

  return `<div class="g-best-strip">
    ${champions.map(({ icon, label, score }) => `
      <span class="g-best-badge" title="Best in ${label} (${score.toFixed(1)} / 10)">
        <span class="g-best-icon">${icon}</span>
        <span class="g-best-label">${label}</span>
      </span>`).join('')}
  </div>`;
}

function categoryExtremes(entry) {
  const scores = CATEGORY_ORDER
    .map(category => ({
      category,
      meta: CATEGORY_META[category],
      score: categoryScore(entry, category)
    }))
    .filter(item => item.score !== null);

  if (scores.length === 0) {
    return { best: null, watch: null };
  }

  const sorted = scores.sort((a, b) => b.score - a.score);
  return {
    best: sorted[0],
    watch: sorted[sorted.length - 1]
  };
}

function renderCategoryPill(item, tone, prefix) {
  if (!item) return '<span class="g-rank-muted">—</span>';
  return `<span class="g-rank-pill ${tone}" title="${item.meta.label}: ${item.score.toFixed(1)} / 10">
    <span class="g-rank-icon">${item.meta.icon}</span>
    <span>${prefix}${item.meta.label}</span>
    <strong>${item.score.toFixed(1)}</strong>
  </span>`;
}

function renderEvidence(entry) {
  const tests = entry.testCount ?? 0;
  return `<td class="g-evidence">
    <span class="g-evidence-val">${tests} tests</span>
    ${renderConfidence(entry.confidence)}
  </td>`;
}

function renderRow(entry, index, championMap, readinessMap) {
  const modelName = entry.model ?? '—';
  const readinessBadge = readinessMap ? getBadgeHtml(modelName, readinessMap) : '';
  const { best, watch } = categoryExtremes(entry);
  const watchTone = watch && watch.score < 6 ? 'bad' : 'watch';
  return `<tr>
    ${renderRank(index)}
    <td>
      <div class="gm">${modelName}${readinessBadge}
        <a href="/courthouse?model=${encodeURIComponent(modelName)}" class="gen-courthouse-link" title="Review in Courthouse"><i class="fas fa-gavel"></i></a>
        <a href="/efficiency-map" class="gen-courthouse-link" title="Efficiency Map"><i class="fas fa-chart-line"></i></a>
      </div>
      ${renderChampionBadges(entry, championMap)}
      <div class="gh">${entry.hostName || _shortHost(entry.host) || '—'}</div>
    </td>
    ${renderScore(entry.score ?? 0)}
    <td>${renderCategoryPill(best, 'best', '')}</td>
    <td>${renderCategoryPill(watch, watchTone, '')}</td>
    ${renderEvidence(entry)}
    <td class="gcal">${renderConfidenceBadge(entry)}</td>
    <td>${entry.reviewCount ?? 0}</td>
    ${renderTrend(entry.trend)}
  </tr>`;
}

const SCORING_EXPLAINER = `<details class="gen-scoring-explainer">
  <summary class="gen-explainer-toggle">How Scoring Works <span class="gen-explainer-caret">&#9660;</span></summary>
  <div class="gen-explainer-body">
    <p class="gen-explainer-title">How the Quality Ranking Works</p>
    <p>Each model's generalist score reflects quality across 7 evaluation categories, adjusted for category breadth, hard-level coverage, and consistency.</p>
    <p>Category weights are shared across every model, so the leaderboard stays apples-to-apples.</p>
    <p class="gen-explainer-formula"><strong>Formula:</strong> weighted_quality &minus; coverage_penalty + consistency_bonus</p>
    <ul class="gen-explainer-list">
      <li><strong>Weighted Quality:</strong> Average quality score (0&ndash;10) across categories, weighted by category importance (e.g., coding 20%, reasoning 20%, math 10%&hellip;).</li>
      <li><strong>Coverage Penalties:</strong> Models lose points for untested categories and for missing hard-level evidence. This prevents easy-only sweeps from ranking as full-scope leaders.</li>
      <li><strong>Consistency Bonus:</strong> Models that perform evenly across categories earn bonus points. Erratic performance (high in one, low in another) gets no bonus.</li>
    </ul>
    <p>The final score is divided by 10 to display on a 0&ndash;10 scale.</p>
  </div>
</details>`;

function buildTable(rankings, readinessMap) {
  if (!rankings || rankings.length === 0) {
    return `<div class="r-empty">No rankings yet — launch a benchmark to populate the leaderboard.</div>`;
  }

  const championMap = buildChampionMap(rankings);
  const rows = rankings.map((entry, i) => renderRow(entry, i, championMap, readinessMap)).join('');

  return `${SCORING_EXPLAINER}<div class="gen-table-wrap"><table class="gen-table quality-ranking-table">
    <thead>
      <tr>
        <th>Rank</th>
        <th>Model / Host</th>
        <th title="Generalist score (0-10). Weighted quality minus coverage penalty plus consistency bonus.">Score</th>
        <th title="Highest-scoring category for this model. Full category detail lives in Model Stats.">Best Lane</th>
        <th title="Lowest-scoring category for this model. Use this as the quick weakness marker.">Watch Lane</th>
        <th title="Completed evaluations and confidence margin. Smaller confidence margins are better.">Evidence</th>
        <th title="Judge calibration status. Checkmark = calibrated judge with 10+ results. Warning = uncalibrated judge or insufficient data.">Cal</th>
        <th title="Number of results that have been human-reviewed in the courthouse.">Reviewed</th>
        <th title="Score change compared to the previous batch. Up = improving, Down = declining, NEW = first appearance.">Trend</th>
      </tr>
    </thead>
    <tbody>${rows}</tbody>
  </table></div>`;
}

export async function renderGeneralistBoard(container, rankings) {
  const readinessMap = await getReadinessMap().catch(() => ({}));

  const sectionHead = `<div class="r-sec-head">
    <span class="r-sec-icon">🏁</span>
    <span class="r-sec-title r-t-cyan">Quality Ranking</span>
    <span class="r-sec-toggle">▼</span>
  </div>`;

  const tableWrapper = `<div class="r-sec-body">${buildTable(rankings, readinessMap)}</div>`;

  container.innerHTML = sectionHead + tableWrapper;
}
