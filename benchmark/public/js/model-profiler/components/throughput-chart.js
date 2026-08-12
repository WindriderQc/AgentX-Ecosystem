// public/js/model-profiler/components/throughput-chart.js
/**
 * Throughput Chart Component
 *
 * CSS-only bar chart showing tok/s at various context sizes per host.
 * No external chart library required.
 *
 * Usage: renderThroughputChart(data, degradationThreshold) → HTML string
 *
 * @param {Object} data - { hostId: [{ numCtx, tokPerSec }] }
 * @param {number} degradationThreshold - % drop from baseline before bars fade (default 50)
 */

const HOST_COLORS = {
  host-delta: '#4ecdc4',
  host-beta: '#e94560',
  host-gamma:  '#f39c12'
};

const CHART_HEIGHT = 120; // px — bar max height

function hostColor(hostId) {
  return HOST_COLORS[hostId.toLowerCase()] || '#8892b0';
}

function formatCtx(numCtx) {
  if (numCtx >= 1024) return `${Math.round(numCtx / 1024)}K`;
  return String(numCtx);
}

/**
 * Determine if a bar has degraded past the threshold.
 * Baseline = first (lowest numCtx) entry for that host.
 *
 * @param {number} baseline - tok/s at lowest context
 * @param {number} current  - tok/s at this context
 * @param {number} threshold - degradation % limit
 */
function isDegraded(baseline, current, threshold) {
  if (!baseline || baseline <= 0) return false;
  const drop = ((baseline - current) / baseline) * 100;
  return drop >= threshold;
}

/**
 * Render the legend row.
 */
function renderLegend(hostIds) {
  const items = hostIds.map(id => {
    const color = hostColor(id);
    return `<span class="tp-legend-item" style="display:inline-flex;align-items:center;gap:5px;margin-right:14px;">
      <span style="display:inline-block;width:10px;height:10px;border-radius:2px;background:${color};"></span>
      <span style="color:#ccd6f6;font-size:11px;">${id}</span>
    </span>`;
  }).join('');

  return `<div class="tp-legend" style="margin-bottom:12px;">${items}</div>`;
}

/**
 * Render a single bar group (one context-size column).
 */
function renderBarGroup(ctxSize, hostsData, maxTokPerSec, degradationThreshold) {
  const label = formatCtx(ctxSize);

  const bars = hostsData.map(({ hostId, tokPerSec, baseline }) => {
    const color = hostColor(hostId);
    const heightPct = maxTokPerSec > 0 ? (tokPerSec / maxTokPerSec) : 0;
    const barH = Math.round(heightPct * CHART_HEIGHT);
    const degraded = isDegraded(baseline, tokPerSec, degradationThreshold);
    const opacity = degraded ? 0.3 : 1;
    const title = `${hostId}: ${tokPerSec} tok/s @ ${formatCtx(ctxSize)}${degraded ? ' (degraded)' : ''}`;

    return `<div class="tp-bar" title="${title}" style="
      display:inline-block;
      width:14px;
      height:${barH}px;
      background:${color};
      opacity:${opacity};
      border-radius:2px 2px 0 0;
      margin:0 1px;
      vertical-align:bottom;
      transition:opacity 0.2s;
    "></div>`;
  }).join('');

  return `<div class="tp-bar-group" style="
    display:inline-flex;
    flex-direction:column;
    align-items:center;
    margin:0 6px;
    vertical-align:bottom;
  ">
    <div class="tp-bars" style="
      display:flex;
      align-items:flex-end;
      height:${CHART_HEIGHT}px;
    ">${bars}</div>
    <div class="tp-ctx-label" style="
      color:#8892b0;
      font-size:10px;
      margin-top:4px;
      white-space:nowrap;
    ">${label}</div>
  </div>`;
}

/**
 * Main export.
 *
 * @param {Object} data - { hostId: [{ numCtx, tokPerSec }] }
 * @param {number} degradationThreshold - % drop before bar fades (default 50)
 * @returns {string} HTML string
 */
export function renderThroughputChart(data, degradationThreshold = 50) {
  const hostIds = Object.keys(data);

  if (!hostIds.length) {
    return `<div class="tp-chart tp-chart--empty" style="color:#8892b0;font-size:12px;padding:12px 0;">
      No throughput data available.
    </div>`;
  }

  // Collect all unique context sizes, sorted ascending
  const ctxSizeSet = new Set();
  for (const points of Object.values(data)) {
    for (const { numCtx } of points) ctxSizeSet.add(numCtx);
  }
  const ctxSizes = Array.from(ctxSizeSet).sort((a, b) => a - b);

  // Find max tok/s across all hosts for scaling
  let maxTokPerSec = 0;
  for (const points of Object.values(data)) {
    for (const { tokPerSec } of points) {
      if (tokPerSec > maxTokPerSec) maxTokPerSec = tokPerSec;
    }
  }

  // Build per-host lookup: hostId → Map<numCtx, tokPerSec>
  const hostMaps = {};
  const hostBaselines = {}; // hostId → baseline tokPerSec (at lowest ctx)
  for (const hostId of hostIds) {
    const sorted = [...data[hostId]].sort((a, b) => a.numCtx - b.numCtx);
    hostMaps[hostId] = new Map(sorted.map(p => [p.numCtx, p.tokPerSec]));
    hostBaselines[hostId] = sorted.length > 0 ? sorted[0].tokPerSec : 0;
  }

  // Render bar groups for each context size
  const groups = ctxSizes.map(ctxSize => {
    const hostsData = hostIds
      .filter(id => hostMaps[id].has(ctxSize))
      .map(id => ({
        hostId: id,
        tokPerSec: hostMaps[id].get(ctxSize),
        baseline: hostBaselines[id]
      }));

    if (!hostsData.length) return '';
    return renderBarGroup(ctxSize, hostsData, maxTokPerSec, degradationThreshold);
  }).join('');

  // Y-axis label
  const yAxisLabel = `<div class="tp-y-label" style="
    position:absolute;
    left:-36px;
    top:50%;
    transform:translateY(-50%) rotate(-90deg);
    color:#8892b0;
    font-size:10px;
    white-space:nowrap;
  ">tok/s</div>`;

  const maxLabel = `<div style="
    position:absolute;
    right:0;
    top:0;
    color:#8892b0;
    font-size:10px;
  ">${maxTokPerSec}</div>`;

  const zeroLabel = `<div style="
    position:absolute;
    right:0;
    bottom:0;
    color:#8892b0;
    font-size:10px;
  ">0</div>`;

  return `<div class="tp-chart" style="font-family:inherit;">
    ${renderLegend(hostIds)}
    <div class="tp-chart-area" style="position:relative;padding-left:44px;">
      ${yAxisLabel}
      <div class="tp-chart-inner" style="position:relative;">
        ${maxLabel}
        ${zeroLabel}
        <div class="tp-groups" style="
          display:flex;
          align-items:flex-end;
          padding:0 24px 0 0;
          border-left:1px solid #2a2a4a;
          border-bottom:1px solid #2a2a4a;
          min-height:${CHART_HEIGHT + 24}px;
          overflow-x:auto;
        ">${groups}</div>
      </div>
    </div>
  </div>`;
}
