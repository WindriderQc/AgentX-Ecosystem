// public/js/efficiency-map/scatter-plot.js
import { scoreColor } from '../components/score-color.js';

const PAD = { top: 30, right: 30, bottom: 50, left: 55 };
const HEIGHT = 400;

function niceMax(val) {
    const mag = Math.pow(10, Math.floor(Math.log10(val)));
    return Math.ceil(val / mag) * mag;
}

function gridValues(max, steps) {
    const step = max / steps;
    const vals = [];
    for (let i = 0; i <= steps; i++) vals.push(Math.round(step * i));
    return vals;
}

export function renderScatterPlot(container, entries, { onPointClick } = {}) {
    if (entries.length === 0) {
        container.innerHTML = '<p style="color:var(--r-text-muted);text-align:center;padding:2rem">No data to plot.</p>';
        return;
    }

    const width = Math.max(600, container.clientWidth || 700);
    const plotW = width - PAD.left - PAD.right;
    const plotH = HEIGHT - PAD.top - PAD.bottom;

    const maxSpeed = niceMax(Math.max(...entries.map(e => e.avgTokPerSec)) * 1.1);
    const maxQ = 10;

    const xScale = v => PAD.left + (v / maxSpeed) * plotW;
    const yScale = v => PAD.top + plotH - (v / maxQ) * plotH;

    // Grid
    const xGridVals = gridValues(maxSpeed, 5);
    const yGridVals = [0, 2, 4, 6, 8, 10];

    let gridLines = '';
    for (const v of xGridVals) {
        const x = xScale(v);
        gridLines += `<line x1="${x}" y1="${PAD.top}" x2="${x}" y2="${PAD.top + plotH}" stroke="#1a1a2e" stroke-width="1"/>`;
        gridLines += `<text x="${x}" y="${PAD.top + plotH + 20}" fill="#888" font-size="11" text-anchor="middle">${v}</text>`;
    }
    for (const v of yGridVals) {
        const y = yScale(v);
        gridLines += `<line x1="${PAD.left}" y1="${y}" x2="${PAD.left + plotW}" y2="${y}" stroke="#1a1a2e" stroke-width="1"/>`;
        gridLines += `<text x="${PAD.left - 10}" y="${y + 4}" fill="#888" font-size="11" text-anchor="end">${v}</text>`;
    }

    // Axis labels
    const axisLabels = `
        <text x="${PAD.left + plotW / 2}" y="${HEIGHT - 5}" fill="#aaa" font-size="12" text-anchor="middle">tok/s</text>
        <text x="14" y="${PAD.top + plotH / 2}" fill="#aaa" font-size="12" text-anchor="middle" transform="rotate(-90, 14, ${PAD.top + plotH / 2})">Quality (0-10)</text>
    `;

    // Pareto frontier line (step-line)
    const frontier = entries.filter(e => e.paretoOptimal).sort((a, b) => a.avgTokPerSec - b.avgTokPerSec);
    let frontierPath = '';
    if (frontier.length > 1) {
        const pts = frontier.map(e => ({ x: xScale(e.avgTokPerSec), y: yScale(e.avgQuality) }));
        let d = `M${pts[0].x},${pts[0].y}`;
        for (let i = 1; i < pts.length; i++) {
            d += ` L${pts[i].x},${pts[i - 1].y} L${pts[i].x},${pts[i].y}`;
        }
        frontierPath = `<path d="${d}" fill="none" stroke="var(--r-active)" stroke-width="2" stroke-dasharray="6,4" opacity="0.6"/>`;
    }

    // Points
    let points = '';
    // Dominated first (behind)
    for (const e of entries.filter(e => !e.paretoOptimal)) {
        const cx = xScale(e.avgTokPerSec);
        const cy = yScale(e.avgQuality);
        const key = `${e.model}@@${e.host}`;
        points += `<circle cx="${cx}" cy="${cy}" r="5" fill="none" stroke="#555" stroke-width="1.5" class="eff-dot" data-key="${key}"/>`;
    }
    // Pareto on top
    for (const e of entries.filter(e => e.paretoOptimal)) {
        const cx = xScale(e.avgTokPerSec);
        const cy = yScale(e.avgQuality);
        const key = `${e.model}@@${e.host}`;
        points += `<circle cx="${cx}" cy="${cy}" r="8" fill="var(--r-active)" opacity="0.85" class="eff-dot eff-dot-pareto" data-key="${key}"/>`;
    }

    // Tooltip element
    const tooltipId = 'eff-scatter-tooltip';

    container.innerHTML = `
        <div class="eff-scatter-wrap">
            <svg width="${width}" height="${HEIGHT}" class="eff-scatter-svg">
                ${gridLines}
                ${axisLabels}
                ${frontierPath}
                ${points}
            </svg>
            <div id="${tooltipId}" class="eff-tooltip hidden"></div>
        </div>
        <div class="eff-scatter-legend">
            <span><span class="eff-legend-dot eff-legend-pareto"></span> Pareto-optimal</span>
            <span><span class="eff-legend-dot eff-legend-dominated"></span> Dominated</span>
            <span><span class="eff-legend-line"></span> Frontier</span>
        </div>
    `;

    // Interactions
    const tooltip = container.querySelector(`#${tooltipId}`);
    const entryMap = new Map(entries.map(e => [`${e.model}@@${e.host}`, e]));

    container.querySelectorAll('.eff-dot').forEach(dot => {
        dot.addEventListener('mouseenter', ev => {
            const e = entryMap.get(dot.dataset.key);
            if (!e) return;
            const eColor = scoreColor(e.efficiencyScore / 10);
            tooltip.innerHTML = `
                <div class="eff-tip-model">${e.model}</div>
                <div class="eff-tip-host">${e.host}</div>
                <div>Quality: <b style="color:${scoreColor(e.avgQuality)}">${e.avgQuality.toFixed(1)}</b></div>
                <div>tok/s: <b>${e.avgTokPerSec.toFixed(1)}</b></div>
                <div>Efficiency: <b style="color:${eColor}">${e.efficiencyScore.toFixed(1)}</b></div>
                <div class="eff-tip-tests">${e.testCount} tests</div>
            `;
            tooltip.classList.remove('hidden');
            const rect = container.querySelector('.eff-scatter-wrap').getBoundingClientRect();
            tooltip.style.left = `${ev.clientX - rect.left + 12}px`;
            tooltip.style.top = `${ev.clientY - rect.top - 10}px`;
        });

        dot.addEventListener('mouseleave', () => {
            tooltip.classList.add('hidden');
        });

        dot.addEventListener('click', () => {
            if (onPointClick) onPointClick(dot.dataset.key);
        });

        dot.style.cursor = 'pointer';
    });
}
