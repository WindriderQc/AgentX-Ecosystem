// public/js/efficiency-map/ranked-table.js
import { scoreColor } from '../components/score-color.js';
import { NO_THROUGHPUT_MESSAGE, rankableEfficiencyEntries } from './evidence.js';

const COLUMNS = [
    { key: 'rank',            label: '#',         sortable: false },
    { key: 'model',           label: 'Model',     sortable: true  },
    { key: 'host',            label: 'Host',      sortable: true  },
    { key: 'avgQuality',      label: 'Quality',   sortable: true  },
    { key: 'avgTokPerSec',    label: 'tok/s',     sortable: true  },
    { key: 'avgTtft',         label: 'TTFT',      sortable: true  },
    { key: 'efficiencyScore', label: 'Efficiency', sortable: true },
    { key: 'paretoOptimal',   label: 'Frontier',  sortable: true  },
    { key: 'throughputTestCount', label: 'Speed samples', sortable: true },
    { key: 'testCount',       label: 'Tests',     sortable: true  },
];

function shortHost(url) {
    try {
        const u = new URL(url);
        const last = u.hostname.split('.').pop();
        return `.${last}`;
    } catch { return url; }
}

function formatCell(col, entry) {
    switch (col.key) {
        case 'rank':
            return '';
        case 'model':
            return `<a href="/leaderboard" title="View on leaderboard" style="color:inherit;text-decoration:none;border-bottom:1px dotted var(--r-text-muted);">${entry.model}</a>`;
        case 'host':
            return shortHost(entry.host);
        case 'avgQuality':
            return `<span style="color:${scoreColor(entry.avgQuality)}">${entry.avgQuality.toFixed(1)}</span>`;
        case 'avgTokPerSec':
            return Math.round(entry.avgTokPerSec);
        case 'avgTtft':
            return entry.avgTtft >= 1000 ? `${(entry.avgTtft / 1000).toFixed(1)}s` : `${entry.avgTtft}ms`;
        case 'efficiencyScore':
            return `<span style="color:${scoreColor(entry.efficiencyScore / 10)}">${entry.efficiencyScore.toFixed(1)}</span>`;
        case 'paretoOptimal':
            return entry.paretoOptimal ? '<span title="Pareto-optimal" style="color:var(--r-active)">★</span>' : '';
        case 'throughputTestCount':
            return Number.isFinite(entry.throughputTestCount) ? entry.throughputTestCount : entry.testCount;
        case 'testCount':
            return entry.testCount;
        default:
            return '';
    }
}

function buildCsv(sorted) {
    const headers = ['rank', 'model', 'host', 'quality', 'tokPerSec', 'ttft', 'efficiencyScore', 'paretoOptimal', 'speedSampleCount', 'testCount'];
    const rows = sorted.map((e, i) => [
        i + 1, `"${e.model}"`, `"${e.host}"`, e.avgQuality.toFixed(2), e.avgTokPerSec.toFixed(1),
        e.avgTtft, e.efficiencyScore.toFixed(2), e.paretoOptimal,
        Number.isFinite(e.throughputTestCount) ? e.throughputTestCount : e.testCount,
        e.testCount
    ]);
    return [headers.join(','), ...rows.map(r => r.join(','))].join('\n');
}

function downloadCsv(csv, filename) {
    const blob = new Blob([csv], { type: 'text/csv' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    a.click();
    URL.revokeObjectURL(a.href);
}

export function renderRankedTable(container, entries) {
    const rankedEntries = rankableEfficiencyEntries(entries);
    if (rankedEntries.length === 0) {
        container.innerHTML = `<p class="eff-empty-state">${NO_THROUGHPUT_MESSAGE}</p>`;
        return { highlightRow() {} };
    }

    let sortKey = 'efficiencyScore';
    let sortAsc = false;
    let sorted = [...rankedEntries];

    function doSort() {
        sorted.sort((a, b) => {
            let va = a[sortKey], vb = b[sortKey];
            if (typeof va === 'string') { va = va.toLowerCase(); vb = (vb || '').toLowerCase(); }
            if (typeof va === 'boolean') { va = va ? 1 : 0; vb = vb ? 1 : 0; }
            if (va < vb) return sortAsc ? -1 : 1;
            if (va > vb) return sortAsc ? 1 : -1;
            return 0;
        });
    }

    function render() {
        doSort();

        const thCells = COLUMNS.map(col => {
            const arrow = col.key === sortKey ? (sortAsc ? ' \u25B2' : ' \u25BC') : '';
            const cls = col.sortable ? 'eff-th-sort' : '';
            return `<th class="${cls}" data-key="${col.key}">${col.label}${arrow}</th>`;
        }).join('');

        const rows = sorted.map((e, i) => {
            const pareto = e.paretoOptimal ? ' eff-row-pareto' : '';
            const cells = COLUMNS.map(col => {
                if (col.key === 'rank') return `<td>${i + 1}</td>`;
                return `<td>${formatCell(col, e)}</td>`;
            }).join('');
            return `<tr class="eff-row${pareto}" data-key="${e.model}@@${e.host}">${cells}</tr>`;
        }).join('');

        container.innerHTML = `
            <div class="eff-table-actions">
                <button class="eff-export-btn" id="eff-export-csv"><i class="fas fa-download"></i> Export CSV</button>
            </div>
            <div class="eff-table-wrap">
                <table class="eff-table">
                    <thead><tr>${thCells}</tr></thead>
                    <tbody>${rows}</tbody>
                </table>
            </div>
        `;

        container.querySelectorAll('.eff-th-sort').forEach(th => {
            th.addEventListener('click', () => {
                const key = th.dataset.key;
                if (sortKey === key) { sortAsc = !sortAsc; }
                else { sortKey = key; sortAsc = false; }
                render();
            });
        });

        container.querySelector('#eff-export-csv').addEventListener('click', () => {
            const date = new Date().toISOString().slice(0, 10);
            downloadCsv(buildCsv(sorted), `efficiency-map-${date}.csv`);
        });
    }

    render();

    return {
        highlightRow(key) {
            container.querySelectorAll('.eff-row').forEach(r => r.classList.remove('eff-row-highlight'));
            const row = container.querySelector(`tr[data-key="${key}"]`);
            if (row) {
                row.classList.add('eff-row-highlight');
                row.scrollIntoView({ behavior: 'smooth', block: 'center' });
            }
        }
    };
}
