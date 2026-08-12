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

async function fetchVoiceSummary(windowKey) {
  const res = await fetch(`/api/analytics/voice/summary?window=${encodeURIComponent(windowKey)}`, {
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

function voiceMetricValue(metric, field) {
  if (!metric || !metric.sampleSize || !Number.isFinite(metric[field])) return '—';
  if (metric.unit === 'ratio') return metric[field].toFixed(2);
  return ms(metric[field]);
}

function renderVoiceUnavailable(message) {
  setText('voiceStatus', 'unavailable');
  setText('voiceSamples', '—');
  setText('voiceFirstAudio', '—');
  setText('voiceFirstAudioSample', 'source unavailable');
  setText('voiceTotalTurn', '—');
  setText('voiceTotalTurnSample', 'source unavailable');
  setText('voiceReliability', '—');
  setText('voiceRateSample', message || 'source unavailable');
}

function renderVoice(d) {
  const metrics = d.metrics || {};
  const errors = d.rates?.errors || {};
  const fallbacks = d.rates?.fallbacks || {};
  const status = d.status || 'unavailable';
  setText('voiceStatus', status);
  setText('voiceSamples', compact(d.sampleSize));
  setText('voiceScope', `${d.privacy || 'No audio or message content retained.'} · ${d.confidence || 'unknown'} confidence`);
  setText('voiceFirstAudio', voiceMetricValue(metrics.firstAudioMs, 'p95'));
  setText('voiceFirstAudioSample', metrics.firstAudioMs?.sampleSize
    ? `n=${metrics.firstAudioMs.sampleSize} · target ${ms(metrics.firstAudioMs.target)}`
    : 'no samples');
  setText('voiceTotalTurn', voiceMetricValue(metrics.totalTurnMs, 'p95'));
  setText('voiceTotalTurnSample', metrics.totalTurnMs?.sampleSize
    ? `n=${metrics.totalTurnMs.sampleSize} · target ${ms(metrics.totalTurnMs.target)}`
    : 'no samples');
  setText('voiceReliability', errors.sampleSize
    ? `${errors.ratePct.toFixed(1)}% / ${fallbacks.ratePct.toFixed(1)}%`
    : '—');
  setText('voiceRateSample', errors.sampleSize ? `n=${errors.sampleSize}` : 'no samples');

  const statusEl = $('voiceStatus');
  if (statusEl) statusEl.style.color = status === 'healthy'
    ? '#34d399'
    : status === 'degraded' || status === 'idle'
      ? '#f59e0b'
      : status === 'failed'
        ? '#f87171'
        : 'var(--muted)';

  const metricBody = $('voiceSloTableBody');
  if (metricBody) {
    const rows = Object.values(metrics);
    metricBody.innerHTML = rows.length ? rows.map((metric) => {
      const tone = metric.status === 'healthy' ? '#34d399' : metric.status === 'degraded' ? '#f59e0b' : 'var(--muted)';
      const target = metric.unit === 'ratio' ? metric.target.toFixed(2) : ms(metric.target);
      return `<tr>
        <td style="padding:8px;border-bottom:1px solid var(--panel-border);">${escapeHtml(metric.label)}</td>
        <td style="padding:8px;text-align:right;border-bottom:1px solid var(--panel-border);">${voiceMetricValue(metric, 'p50')}</td>
        <td style="padding:8px;text-align:right;border-bottom:1px solid var(--panel-border);color:${tone};">${voiceMetricValue(metric, 'p95')} / ${target}</td>
        <td style="padding:8px;text-align:right;border-bottom:1px solid var(--panel-border);">${metric.sampleSize || '—'}</td>
      </tr>`;
    }).join('') : '<tr><td colspan="4" style="padding:16px;text-align:center;color:var(--muted);">No voice metrics available.</td></tr>';
  }

  const segmentBody = $('voiceSegmentsBody');
  if (segmentBody) {
    const segments = d.segments || [];
    segmentBody.innerHTML = segments.length ? segments.slice(0, 12).map((segment) => {
      const route = `${escapeHtml(segment.surface)} · ${escapeHtml(segment.lane)}<br><span style="color:var(--muted);">${escapeHtml(segment.model)} · ${escapeHtml(segment.ttsProvider)}</span>`;
      return `<tr>
        <td style="padding:8px;border-bottom:1px solid var(--panel-border);">${route}</td>
        <td style="padding:8px;text-align:right;border-bottom:1px solid var(--panel-border);">${segment.successRatePct.toFixed(1)}%</td>
        <td style="padding:8px;text-align:right;border-bottom:1px solid var(--panel-border);">${Number.isFinite(segment.firstAudioP95Ms) ? ms(segment.firstAudioP95Ms) : '—'}</td>
        <td style="padding:8px;text-align:right;border-bottom:1px solid var(--panel-border);">${segment.samples}</td>
      </tr>`;
    }).join('') : '<tr><td colspan="4" style="padding:16px;text-align:center;color:var(--muted);">Idle — no voice turns in this window.</td></tr>';
  }
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
    renderDailyChart(data);
  } catch (err) {
    console.error('Inference analytics failed:', err);
    setText('infScope', `Could not load inference analytics: ${err.message}`);
  }
  try {
    renderVoice(await fetchVoiceSummary(windowKey));
  } catch (err) {
    console.error('Voice observability failed:', err);
    renderVoiceUnavailable(err.message);
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
