// score-color.js — Maps numeric score (0–10) to CSS color string
const THRESHOLDS = [
  [9, '#22c55e'], [8, '#4ade80'], [7, '#a3e635'],
  [6, '#facc15'], [5, '#fb923c'], [4, '#f87171'], [0, '#ef4444']
];

export function scoreColor(score) {
  for (const [min, color] of THRESHOLDS) {
    if (score >= min) return color;
  }
  return '#ef4444';
}
