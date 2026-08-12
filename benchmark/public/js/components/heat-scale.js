// heat-scale.js — Heatmap cell rendering for category map
const HEAT_COLORS = {
  h10: { bg: 'rgba(34,197,94,0.25)', color: '#22c55e' },
  h9:  { bg: 'rgba(34,197,94,0.25)', color: '#22c55e' },
  h8:  { bg: 'rgba(34,197,94,0.16)', color: '#4ade80' },
  h7:  { bg: 'rgba(132,204,22,0.13)', color: '#a3e635' },
  h6:  { bg: 'rgba(234,179,8,0.13)',  color: '#facc15' },
  h5:  { bg: 'rgba(249,115,22,0.14)', color: '#fb923c' },
  h4:  { bg: 'rgba(239,68,68,0.14)',  color: '#f87171' },
  h3:  { bg: 'rgba(239,68,68,0.2)',   color: '#ef4444' },
};

export function heatCell(score, { best = false, avg = false } = {}) {
  const cls = `h${Math.min(10, Math.max(3, Math.round(score)))}`;
  const extra = [best ? 'best' : '', avg ? 'hm-avg' : ''].filter(Boolean).join(' ');
  return `<div class="hm ${cls} ${extra}">${score.toFixed(1)}</div>`;
}

export function heatStyle(score) {
  const cls = `h${Math.min(10, Math.max(3, Math.round(score)))}`;
  return HEAT_COLORS[cls] || HEAT_COLORS.h3;
}
