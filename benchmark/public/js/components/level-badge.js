// level-badge.js — Renders L1–L5 difficulty badges with proper colors
const LEVELS = {
  1: { bg: 'var(--r-l1-bg)', color: 'var(--r-l1-text)', label: 'L1' },
  2: { bg: 'var(--r-l2-bg)', color: 'var(--r-l2-text)', label: 'L2' },
  3: { bg: 'var(--r-l3-bg)', color: 'var(--r-l3-text)', label: 'L3' },
  4: { bg: 'var(--r-l4-bg)', color: 'var(--r-l4-text)', label: 'L4' },
  5: { bg: 'var(--r-l5-bg)', color: 'var(--r-l5-text)', label: 'L5' },
};

export function levelBadge(level) {
  const l = LEVELS[level] || LEVELS[1];
  return `<span class="r-level-badge" style="background:${l.bg};color:${l.color};">${l.label}</span>`;
}
