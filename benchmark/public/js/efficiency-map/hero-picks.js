// public/js/efficiency-map/hero-picks.js
import { scoreColor } from '../components/score-color.js';

const MEDALS = ['\u{1F947}', '\u{1F948}', '\u{1F949}'];
const MEDAL_LABELS = ['Most Efficient', 'Runner-up', 'Third'];
const BORDER_COLORS = ['#ffd700', '#c0c0c0', '#cd7f32'];

function shortHost(url) {
    try {
        const u = new URL(url);
        const last = u.hostname.split('.').pop();
        return `.${last}`;
    } catch { return url; }
}

function pickCard(entry, idx) {
    const qColor = scoreColor(entry.avgQuality);
    const eColor = scoreColor(entry.efficiencyScore / 10);
    const host = shortHost(entry.host);
    const pareto = entry.paretoOptimal ? '<span class="eff-pareto-badge" title="Pareto-optimal">★</span>' : '';

    return `<div class="eff-pick" style="border-left: 3px solid ${BORDER_COLORS[idx]}">
        <div class="eff-pick-rank">#${idx + 1}</div>
        <div class="eff-pick-medal">${MEDALS[idx]}</div>
        <div class="eff-pick-label">${MEDAL_LABELS[idx]}</div>
        <div class="eff-pick-model">${entry.model} ${pareto}</div>
        <div class="eff-pick-host">${host}</div>
        <div class="eff-pick-stats">
            <div class="eff-pick-stat">
                <span class="eff-pick-stat-label">Quality</span>
                <span class="eff-pick-stat-val" style="color:${qColor}">${entry.avgQuality.toFixed(1)}</span>
            </div>
            <div class="eff-pick-stat">
                <span class="eff-pick-stat-label">tok/s</span>
                <span class="eff-pick-stat-val">${Math.round(entry.avgTokPerSec)}</span>
            </div>
            <div class="eff-pick-stat">
                <span class="eff-pick-stat-label">Efficiency</span>
                <span class="eff-pick-stat-val" style="color:${eColor}">${entry.efficiencyScore.toFixed(1)}</span>
            </div>
        </div>
        <div class="eff-pick-tests">${entry.testCount} tests</div>
    </div>`;
}

export function renderHeroPicks(container, entries) {
    const top = entries.slice(0, 3);
    if (top.length === 0) {
        container.innerHTML = '<p style="color:var(--r-text-muted);text-align:center;padding:2rem">No models with enough data yet.</p>';
        return;
    }
    container.innerHTML = `<div class="eff-picks">${top.map((e, i) => pickCard(e, i)).join('')}</div>`;
}
