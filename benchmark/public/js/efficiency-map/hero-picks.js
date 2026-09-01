// public/js/efficiency-map/hero-picks.js
import { scoreColor } from '../components/score-color.js';
import { NO_THROUGHPUT_MESSAGE, rankableEfficiencyEntries } from './evidence.js';

const OBSERVATION_BORDER = '#64748b';

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
    const throughputTestCount = Number.isFinite(entry.throughputTestCount)
        ? entry.throughputTestCount
        : entry.testCount;
    const pareto = entry.paretoOptimal ? '<span class="eff-pareto-badge" title="Pareto-optimal">★</span>' : '';
    const label = idx === 0 ? 'Top measured observation' : `Measured observation #${idx + 1}`;

    return `<div class="eff-pick" style="border-left: 3px solid ${OBSERVATION_BORDER}">
        <div class="eff-pick-rank">#${idx + 1}</div>
        <div class="eff-pick-label">${label}</div>
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
        <div class="eff-pick-tests">${throughputTestCount} speed samples · ${entry.testCount} quality tests</div>
    </div>`;
}

export function renderHeroPicks(container, entries) {
    const top = rankableEfficiencyEntries(entries).slice(0, 3);
    if (top.length === 0) {
        container.innerHTML = `<p class="eff-empty-state">${NO_THROUGHPUT_MESSAGE}</p>`;
        return;
    }
    container.innerHTML = `<div class="eff-picks">${top.map((e, i) => pickCard(e, i)).join('')}</div>`;
}
