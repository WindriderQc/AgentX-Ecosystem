// public/js/model-profiler/components/badges.js
/**
 * Readiness Badge Renderer
 *
 * Shared across all pages — profiler, leaderboard, benchmark, courthouse, results.
 * Usage: renderBadge(stage, hostCount, totalHosts) → HTML string
 */

const BADGE_CONFIG = {
  available:   { label: '○ Available',   bg: '#2a2a4a', color: '#8892b0' },
  profiled:    { label: '✓ Profiled',    bg: '#1a3a5c', color: '#4ecdc4' },
  benchmarked: { label: '★ Benchmarked', bg: '#1a3a2a', color: '#2ecc71' },
  stale:       { label: '⚠ Stale',       bg: '#3a1a1a', color: '#e74c3c' }
};

export function renderBadge(stage, hostCount = null, totalHosts = null) {
  const config = BADGE_CONFIG[stage] || BADGE_CONFIG.available;
  const hostSuffix = (hostCount !== null && totalHosts !== null)
    ? ` ${hostCount}/${totalHosts}`
    : '';

  return `<span class="ax-badge" style="
    background: ${config.bg};
    color: ${config.color};
    padding: 2px 6px;
    border-radius: 3px;
    font-size: 10px;
    font-weight: 600;
    white-space: nowrap;
  ">${config.label}${hostSuffix}</span>`;
}

export function renderStaleBadge() {
  return renderBadge('stale');
}

export function renderHostDot(stage) {
  const color = BADGE_CONFIG[stage]?.color || '#4a4a6a';
  return `<span style="
    display: inline-block;
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: ${color};
  "></span>`;
}

export { BADGE_CONFIG };
