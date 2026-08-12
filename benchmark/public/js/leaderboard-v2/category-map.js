// category-map.js — Category heatmap table for Leaderboard v2
import { heatCell } from '../components/heat-scale.js';

function _shortHost(url) {
    return String(url || '').replace(/^https?:\/\//, '').replace(/:11434$/, '');
}

const CAT_ABBR = {
  coding:      'COD',
  reasoning:   'RSN',
  math:        'MTH',
  knowledge:   'KNW',
  instruction: 'INS',
  creative:    'CRE',
  translation: 'MLT',
};
const CATS = Object.keys(CAT_ABBR);
const ABBRS = Object.values(CAT_ABBR);

export function renderCategoryMap(container, rankings) {
  if (!rankings || rankings.length === 0) {
    container.innerHTML = `
      <div class="r-sec-head">
        <span class="r-sec-icon">🔥</span>
        <span class="r-sec-title r-t-orange">Category Map</span>
      </div>
      <p class="r-empty">No ranking data available.</p>`;
    return;
  }

  // Determine best score per category column
  const bestPerCat = {};
  for (const cat of CATS) {
    let best = -Infinity;
    for (const row of rankings) {
      const score = row.categoryScores?.[cat];
      if (score != null && score > best) best = score;
    }
    bestPerCat[cat] = best > -Infinity ? best : null;
  }

  // Build header row
  const headerCells = ABBRS.map(a => `<th>${a}</th>`).join('');
  const avgTh = `<th style="border-left:1px solid rgba(255,255,255,0.08)">Avg</th>`;

  // Build data rows
  const rows = rankings.map(entry => {
    const model = entry.model || entry.modelName || '—';
    const host  = entry.hostName || _shortHost(entry.host) || '';

    const catCells = CATS.map(cat => {
      const score = entry.categoryScores?.[cat];
      if (score == null) {
        return `<td><div class="hm h3" style="opacity:0.3">—</div></td>`;
      }
      const isBest = bestPerCat[cat] != null && score >= bestPerCat[cat];
      return `<td>${heatCell(score, { best: isBest })}</td>`;
    }).join('');

    // Compute avg across available categories
    const available = CATS.map(c => entry.categoryScores?.[c]).filter(v => v != null);
    const avg = available.length
      ? available.reduce((s, v) => s + v, 0) / available.length
      : null;

    const avgCell = avg != null
      ? `<td style="border-left:1px solid rgba(255,255,255,0.08)">${heatCell(avg, { avg: true })}</td>`
      : `<td style="border-left:1px solid rgba(255,255,255,0.08)"><div class="hm h3" style="opacity:0.3">—</div></td>`;

    return `<tr>
      <td>${model}<span class="hg-host">${host}</span></td>
      ${catCells}
      ${avgCell}
    </tr>`;
  }).join('');

  container.innerHTML = `
    <div class="r-sec-head">
      <span class="r-sec-icon">🔥</span>
      <span class="r-sec-title r-t-orange">Category Map</span>
    </div>
    <table class="heatgrid">
      <thead>
        <tr>
          <th></th>
          ${headerCells}
          ${avgTh}
        </tr>
      </thead>
      <tbody>
        ${rows}
      </tbody>
    </table>`;
}
