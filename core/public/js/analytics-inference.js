/**
 * Platform Inference panel.
 *
 * Reads /api/analytics/inference/summary — the `inferencelogs` collection —
 * rather than `conversations`, which only the chat UI writes.
 *
 * Series colours are the validated dark-mode categorical palette (adjacent-pair
 * CVD dE 8.4, normal-vision 19.3 on this surface). Fixed order, never cycled:
 * a caller keeps its colour when the filter changes the series count.
 */

const SERIES = ['#3987e5', '#d95926', '#199e70', '#c98500', '#d55181'];
const SURFACE = '#121726';
const TEXT = '#e8edf5';
const MUTED = '#93a0b5';
const GRID = 'rgba(255,255,255,0.06)';

let dailyChart = null;

const $ = (id) => document.getElementById(id);

function compact(n) {
  if (!Number.isFinite(n)) return '—';
  if (Math.abs(n) >= 1e9) return `${(n / 1e9).toFixed(2)}B`;
  if (Math.abs(n) >= 1e6) return `${(n / 1e6).toFixed(2)}M`;
  if (Math.abs(n) >= 1e3) return `${(n / 1e3).toFixed(1)}k`;
  return String(Math.round(n));
}

function ms(n) {
  if (!Number.isFinite(n)) return '—';
  return n >= 1000 ? `${(n / 1000).toFixed(1)}s` : `${Math.round(n)}ms`;
}

function setText(id, value) {
  const el = $(id);
  if (el) el.textContent = value;
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>'"]/g, (char) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    "'": '&#39;',
    '"': '&quot;'
  })[char]);
}

async function fetchSummary(windowKey) {
  const res = await fetch(`/api/analytics/inference/summary?window=${encodeURIComponent(windowKey)}`, {
    headers: { Accept: 'application/json' }
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const body = await res.json();
  if (!body || body.ok === false || !body.data) throw new Error(body?.message || 'Malformed response');
  return body.data;
}

function renderTiles(d) {
  const t = d.totals || {};
  setText('infScope', d.scope || '');
  setText('infCalls', compact(t.calls));
  setText('infCallsPerDay', compact(t.callsPerDay));
  setText('infTokensOut', compact(t.tokensOut));
  setText('infTokensIn', compact(t.tokensIn));
  setText('infErrorRate', `${(t.errorRate ?? 0).toFixed(2)}%`);
  setText('infErrors', compact(t.errors));
  setText('infHours', `${(t.inferenceHours ?? 0).toFixed(1)}h`);
  setText('infTokPerSec', (t.tokensOutPerSecond ?? 0).toFixed(1));

  setText('infFallbackRate', `${(t.fallbackRate ?? 0).toFixed(2)}%`);
  setText('infFallbacks', compact(t.fallbackCalls));
  setText('infAvgLatency', ms(t.avgLatencyMs));
  setText('infAvgClassification', ms(t.avgClassificationMs));
  setText('infClassifiedCalls', compact(t.classifiedCalls));
  setText('infClassificationPct', `${(t.classificationOverheadPct ?? 0).toFixed(1)}%`);
  setText('infClassifiedTotal', ms(t.avgTotalForClassifiedMs));

  const errorLink = $('infErrorLink');
  if (errorLink) {
    const params = new URLSearchParams({ status: 'error,timeout' });
    if (d.window?.from) params.set('from', new Date(d.window.from).toISOString());
    if (d.window?.to) params.set('to', new Date(d.window.to).toISOString());
    errorLink.href = `/api/analytics/inference/logs?${params.toString()}`;
  }

  const errEl = $('infErrorRate');
  if (errEl) errEl.style.color = t.errorRate > 5 ? '#f87171' : t.errorRate > 1 ? '#f59e0b' : 'inherit';

  const local = d.local || {};
  setText('infLocalHours', `${(local.inferenceHours ?? 0).toFixed(1)}h`);
  setText('infLocalCalls', compact(local.calls));

  const cloud = d.cloud || {};
  // null means "no resolvable price", which is not the same as zero spend.
  setText('infCloudSpend', Number.isFinite(cloud.estimatedCostUsd)
    ? `$${cloud.estimatedCostUsd.toFixed(4)}`
    : (cloud.calls ? 'unpriced' : '$0.00'));
  setText('infCloudNote', cloud.calls
    ? `${compact(cloud.calls)} cloud calls${cloud.unpricedModels?.length ? ` · ${cloud.unpricedModels.length} unpriced` : ''}`
    : 'no cloud-routed calls');
}

function renderDimensionBreakdowns(d) {
  const container = $('infDimensionBreakdowns');
  if (!container) return;
  const dimensions = [
    ['Caller', d.byCaller || [], 'caller'],
    ['Task Type', d.byTaskType || [], 'taskType'],
    ['Fallback Used', d.byFallbackUsed || [], 'fallbackUsed'],
    ['Degraded', d.byDegraded || [], 'degraded'],
  ];
  const cell = 'padding:6px 8px;border-bottom:1px solid var(--panel-border);';
  container.innerHTML = `<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(210px,1fr));gap:16px;">
    ${dimensions.map(([title, rows, key]) => `<div>
      <h3 style="font-size:13px;margin:0 0 6px;">${title}</h3>
      <table style="width:100%;border-collapse:collapse;font-size:12px;"><tbody>
        ${(rows.length ? rows.slice(0, 12) : [{ [key]: 'no data', calls: 0, errorRate: 0 }]).map(row => `<tr>
          <td style="${cell}">${escapeHtml(String(row[key] ?? 'unknown').replace(/_/g, ' '))}</td>
          <td style="${cell}text-align:right;">${compact(row.calls)}</td>
          <td style="${cell}text-align:right;color:var(--muted);">${(row.errorRate || 0).toFixed(1)}% err</td>
        </tr>`).join('')}
      </tbody></table>
    </div>`).join('')}
  </div>`;
}

function renderModelTable(d) {
  const body = $('infModelTableBody');
  if (!body) return;
  const rows = d.byModel || [];
  if (!rows.length) {
    body.innerHTML = '<tr><td colspan="7" style="padding:16px;text-align:center;color:var(--muted);">No inference recorded in this window.</td></tr>';
    return;
  }
  const cell = 'padding:8px;border-bottom:1px solid var(--panel-border);';
  body.innerHTML = rows.map((m) => {
    const model = escapeHtml(m.model);
    const cost = m.isCloud
      ? (Number.isFinite(m.estimatedCostUsd) ? `$${m.estimatedCostUsd.toFixed(4)}` : 'unpriced')
      : '<span style="color:var(--muted);">local</span>';
    const errColor = m.errorRate > 5 ? '#f87171' : m.errorRate > 1 ? '#f59e0b' : 'var(--muted)';
    return `<tr>
      <td style="${cell}text-align:left;">${model}${m.isCloud ? ' <span style="font-size:11px;color:var(--muted);">cloud</span>' : ''}</td>
      <td style="${cell}text-align:right;">${compact(m.calls)}</td>
      <td style="${cell}text-align:right;color:${errColor};">${m.errorRate.toFixed(1)}%</td>
      <td style="${cell}text-align:right;">${compact(m.tokensOut)}</td>
      <td style="${cell}text-align:right;">${ms(m.avgLatencyMs)}</td>
      <td style="${cell}text-align:right;">${m.tokensOutPerSecond.toFixed(1)}</td>
      <td style="${cell}text-align:right;">${cost}</td>
    </tr>`;
  }).join('');
}

function renderDailyChart(d) {
  const canvas = $('infDailyChart');
  const empty = $('infDailyEmpty');
  if (!canvas || typeof Chart === 'undefined') return;

  const cross = d.byDayCaller || [];
  const dates = [...new Set(cross.map((r) => r.date))].sort();

  if (!dates.length) {
    if (dailyChart) { dailyChart.destroy(); dailyChart = null; }
    canvas.style.display = 'none';
    if (empty) empty.style.display = 'block';
    return;
  }
  canvas.style.display = 'block';
  if (empty) empty.style.display = 'none';

  // Fixed slot order by total volume, capped at 4 named series + Other,
  // so a caller never changes colour when the window changes.
  const totals = {};
  cross.forEach((r) => { totals[r.caller] = (totals[r.caller] || 0) + r.calls; });
  const ranked = Object.keys(totals).sort((a, b) => totals[b] - totals[a]);
  const named = ranked.slice(0, 4);
  const hasOther = ranked.length > 4;

  const seriesKeys = hasOther ? [...named, 'other'] : named;
  const datasets = seriesKeys.map((key, i) => ({
    label: key,
    backgroundColor: SERIES[i],
    borderColor: SURFACE,
    borderWidth: 2,          // 2px surface gap between stacked segments
    borderRadius: 4,
    borderSkipped: false,
    data: dates.map((date) => cross
      .filter((r) => r.date === date && (key === 'other' ? !named.includes(r.caller) : r.caller === key))
      .reduce((sum, r) => sum + r.calls, 0))
  }));

  if (dailyChart) dailyChart.destroy();
  dailyChart = new Chart(canvas.getContext('2d'), {
    type: 'bar',
    data: { labels: dates, datasets },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: {
          position: 'bottom',
          labels: { color: TEXT, boxWidth: 12, boxHeight: 12, usePointStyle: true, pointStyle: 'rectRounded' }
        },
        tooltip: {
          backgroundColor: 'rgba(11,16,28,0.95)',
          borderColor: 'rgba(255,255,255,0.12)',
          borderWidth: 1,
          titleColor: TEXT,
          bodyColor: TEXT,
          callbacks: {
            footer: (items) => `total ${compact(items.reduce((s, i) => s + i.parsed.y, 0))} calls`
          }
        }
      },
      scales: {
        x: { stacked: true, grid: { display: false }, ticks: { color: MUTED } },
        y: {
          stacked: true,
          beginAtZero: true,
          grid: { color: GRID },
          ticks: { color: MUTED, callback: (v) => compact(v) },
          title: { display: true, text: 'calls', color: MUTED }
        }
      }
    }
  });
}

/**
 * Codex entitlement. The federated endpoint has always computed this block;
 * the page simply never rendered it.
 */
async function renderCodex(windowKey) {
  const section = $('infCodexSection');
  if (!section) return;
  try {
    const res = await fetch(`/api/analytics/federated?window=${encodeURIComponent(windowKey)}`, {
      headers: { Accept: 'application/json' }
    });
    if (!res.ok) return;
    const body = await res.json();
    const c = body?.codexSubscription;
    if (!c || !c.available) { section.style.display = 'none'; return; }

    section.style.display = '';
    setText('infCodexPlan', c.plan?.name
      ? `${c.plan.name}${Number.isFinite(c.plan.monthlyCostUsd) ? ` · $${c.plan.monthlyCostUsd}/mo` : ''}`
      : '—');

    const used = c.quota?.primary?.usedPercent;
    setText('infCodexQuota', Number.isFinite(used) ? `${used}%` : '—');
    const resetMs = c.quota?.primary?.resetsAtMs;
    setText('infCodexReset', Number.isFinite(resetMs)
      ? `resets ${new Date(resetMs).toLocaleDateString()}`
      : 'no reset reported');

    setText('infCodexTokens', compact(c.currentMonth?.totalTokens));
    setText('infCodexSessions', compact(c.currentMonth?.sessions));
    setText('infCodexCached', Number.isFinite(c.cachedInputPct) ? `${c.cachedInputPct.toFixed(1)}%` : '—');
    setText('infCodexRate', Number.isFinite(c.effectiveCostPer1MTokensUsd)
      ? `$${c.effectiveCostPer1MTokensUsd.toFixed(4)}`
      : '—');
    setText('infCodexMessage', c.valueMessage || '');
  } catch (err) {
    console.error('Codex entitlement fetch failed:', err);
    section.style.display = 'none';
  }
}

/**
 * The chat-lane widgets (usage, feedback, RAG adoption, all four cost panels)
 * read `conversations`, which only POST /api/chat and /api/chat/stream write.
 * On a fleet driven by agents, proxies and pipelines that collection is empty,
 * so those six sections rendered as a wall of "No data" and zeros that looked
 * like a broken page rather than an unused feature.
 *
 * Collapse them to a single honest line when the window holds no conversations,
 * with an opt-in to show them anyway. They come back automatically the moment
 * someone uses the chat UI.
 */
const WINDOW_DAYS = { '24h': 1, '7d': 7, '30d': 30, '90d': 90 };

function setChatLaneVisible(visible) {
  document.querySelectorAll('.chat-lane').forEach((el) => {
    el.style.display = visible ? '' : 'none';
  });
}

async function applyChatLaneCollapse(windowKey) {
  const note = $('chatLaneEmptyNote');
  const heading = $('chatLaneHeading');
  if (!note) return;

  const days = WINDOW_DAYS[windowKey] || 7;
  const to = new Date();
  const from = new Date(to.getTime() - days * 86400000);

  let conversations = null;
  try {
    const res = await fetch(`/api/analytics/usage?from=${from.toISOString()}&to=${to.toISOString()}`, {
      headers: { Accept: 'application/json' }
    });
    if (res.ok) {
      const body = await res.json();
      const d = body?.data || body;
      conversations = Number(d?.totalConversations ?? 0);
    }
  } catch (err) {
    console.error('Chat-lane probe failed:', err);
  }

  // Unknown (probe failed) is not the same as zero — leave the widgets alone.
  if (conversations === null || conversations > 0) {
    note.style.display = 'none';
    setChatLaneVisible(true);
    if (heading) heading.style.display = '';
    return;
  }

  setChatLaneVisible(false);
  if (heading) heading.style.display = 'none';
  note.style.display = '';
  note.innerHTML = `<strong>Chat lane: no conversations in the last ${days} days.</strong>
    The usage, feedback, RAG-adoption and cost panels below read the
    <code>conversations</code> collection, which only the chat UI writes — agent,
    pipeline and proxy traffic is in Platform Inference above.
    <a href="#" id="chatLaneShowAnyway" style="color: var(--accent);">Show them anyway</a>.`;

  const link = $('chatLaneShowAnyway');
  if (link) {
    link.addEventListener('click', (e) => {
      e.preventDefault();
      setChatLaneVisible(true);
      if (heading) heading.style.display = '';
      note.style.display = 'none';
    });
  }
}

async function load() {
  const windowKey = $('infWindow')?.value || '7d';
  try {
    const data = await fetchSummary(windowKey);
    renderTiles(data);
    renderModelTable(data);
    renderDimensionBreakdowns(data);
    renderDailyChart(data);
  } catch (err) {
    console.error('Inference analytics failed:', err);
    setText('infScope', `Could not load inference analytics: ${err.message}`);
  }
  renderCodex(windowKey);
  applyChatLaneCollapse(windowKey);
}

function init() {
  $('infRefreshBtn')?.addEventListener('click', load);
  $('infWindow')?.addEventListener('change', load);
  load();
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
