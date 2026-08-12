// mini-bars.js — Renders 7 inline category mini-bars
import { scoreColor } from './score-color.js';

const CATS = ['coding','reasoning','math','knowledge','instruction','creative','translation'];
const ABBR = ['COD','RSN','MTH','KNW','INS','CRE','MLT'];

export function miniBars(categoryScores, { height = 4, width = 30 } = {}) {
  return CATS.map((cat, i) => {
    const score = categoryScores[cat] ?? 0;
    const pct = (score / 10) * 100;
    const color = scoreColor(score);
    return `<div class="r-mini-bar" title="${ABBR[i]}: ${score.toFixed(1)}">
      <div class="r-mini-fill" style="width:${pct}%;background:${color};height:${height}px;"></div>
    </div>`;
  }).join('');
}
