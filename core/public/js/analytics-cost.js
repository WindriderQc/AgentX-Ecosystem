/**
 * Analytics — Cost Tracking, System Metrics, RAG Metrics & Initialization
 *
 * Extracted from analytics.js — loaded as the main module in analytics.html.
 * Imports shared state and utilities from analytics.js.
 * (ES modules are strict by default — no 'use strict' needed.)
 */

import {
  elements, charts,
  buildRangeQuery, checkAuth, fetchJSON,
  formatBytes, formatNumber, refreshProduct
} from './analytics.js';


/* -------------------------------------------------------------------------- */
/*                          Cost Tracking Logic                               */
/* -------------------------------------------------------------------------- */

async function loadCosts(days, groupBy = null, breakdown = null) {
  const query = buildRangeQuery(days);
  const params = new URLSearchParams(query);

  // Backend supports: groupBy={model|day|promptVersion}
  // Older UI code passed a `breakdown` arg; treat it as a fallback groupBy.
  const effectiveGroupBy = groupBy || breakdown;
  if (effectiveGroupBy) params.append('groupBy', effectiveGroupBy);

  try {
    const response = await fetchJSON(`/api/analytics/costs?${params.toString()}`);
    return response.data;
  } catch (err) {
    console.error('Cost data load failed:', err);
    return null;
  }
}

async function refreshCostStats() {
  const days = elements.periodSelect.value;

  try {
    const data = await loadCosts(days);

    if (!data) {
      elements.totalCost.textContent = '—';
      elements.costPerConversation.textContent = '—';
      elements.costPer1kTokens.textContent = '—';
      elements.tokensPerDollar.textContent = '—';
      return;
    }

    const summary = data.summary || {};
    const totalCost = summary.totalCost || 0;
    const totalTokens = summary.totalTokens || 0;
    const tokensPerDollar = totalCost > 0 ? (totalTokens / totalCost) : 0;

    elements.totalCost.textContent = `$${(totalCost || 0).toFixed(2)}`;
    if (elements.totalCostConvCount) {
      elements.totalCostConvCount.textContent = formatNumber(summary.totalConversations || 0);
    }

    elements.costPerConversation.textContent = `$${(summary.avgCostPerConversation || 0).toFixed(3)}`;
    if (elements.costPerConvMessages) {
      const avgMsgs = summary.totalMessages && summary.totalConversations
        ? (summary.totalMessages / summary.totalConversations).toFixed(1)
        : '—';
      elements.costPerConvMessages.textContent = avgMsgs;
    }

    elements.costPer1kTokens.textContent = `$${(summary.costPer1kTokens || 0).toFixed(4)}`;
    if (elements.costTotalTokens) {
      elements.costTotalTokens.textContent = formatNumber(totalTokens);
    }

    elements.tokensPerDollar.textContent = Math.round(tokensPerDollar || 0).toLocaleString();
  } catch (err) {
    console.error('Cost stats refresh error:', err);
  }
}

async function refreshCostTrend() {
  const days = elements.periodSelect.value;
  const groupBy = elements.costTrendGroupSelect.value;

  try {
    const data = await loadCosts(days, groupBy);

    const breakdown = data?.breakdown || [];
    if (!data || breakdown.length === 0) {
      if (charts.costTrend) charts.costTrend.destroy();
      document.getElementById('costTrendChart').style.display = 'none';
      elements.costTrendEmpty.style.display = 'block';
      return;
    }

    document.getElementById('costTrendChart').style.display = 'block';
    elements.costTrendEmpty.style.display = 'none';

    let items = breakdown;
    if (groupBy === 'day') {
      items = [...breakdown].sort((a, b) => String(a.key).localeCompare(String(b.key)));
    }

    // Extract labels based on groupBy
    const labels = items.map(item => {
      if (groupBy === 'day') return String(item.key);
      if (groupBy === 'model') return item.key || 'Unknown';
      if (groupBy === 'promptVersion') return `${item.key?.name || 'Prompt'} v${item.key?.version ?? '?'}`;
      return String(item.key ?? '');
    });

    const costData = items.map(item => item.cost?.total || 0);
    const conversationData = items.map(item => item.conversationCount || 0);

    // Recreate chart
    if (charts.costTrend) charts.costTrend.destroy();

    const ctx = document.getElementById('costTrendChart').getContext('2d');
    charts.costTrend = new Chart(ctx, {
      type: 'line',
      data: {
        labels,
        datasets: [
          {
            label: 'Cost (USD)',
            data: costData,
            borderColor: '#7cf0ff',
            backgroundColor: 'rgba(124, 240, 255, 0.05)',
            borderWidth: 2,
            fill: true,
            tension: 0.4,
            pointRadius: 4,
            pointHoverRadius: 6,
            pointBackgroundColor: '#7cf0ff',
            pointBorderColor: 'rgba(12, 15, 26, 0.8)',
            pointBorderWidth: 2,
            yAxisID: 'y'
          },
          {
            label: 'Conversations',
            data: conversationData,
            borderColor: '#eeb0ff',
            backgroundColor: 'rgba(238, 176, 255, 0.05)',
            borderWidth: 2,
            fill: false,
            tension: 0.4,
            pointRadius: 3,
            pointBackgroundColor: '#eeb0ff',
            yAxisID: 'y1'
          }
        ]
      },
      options: {
        responsive: true,
        interaction: {
          mode: 'index',
          intersect: false
        },
        plugins: {
          legend: {
            labels: {
              color: '#e8edf5',
              font: { family: 'Space Grotesk', size: 12 },
              padding: 16
            },
            display: true,
            position: 'top'
          },
          tooltip: {
            backgroundColor: 'rgba(0, 0, 0, 0.8)',
            titleColor: '#7cf0ff',
            bodyColor: '#e8edf5',
            borderColor: 'rgba(255, 255, 255, 0.1)',
            borderWidth: 1,
            padding: 10,
            displayColors: true,
            callbacks: {
              label: function(context) {
                if (context.dataset.yAxisID === 'y') {
                  return context.dataset.label + ': $' + context.parsed.y.toFixed(2);
                }
                return context.dataset.label + ': ' + context.parsed.y + ' conversations';
              }
            }
          }
        },
        scales: {
          x: {
            grid: {
              color: 'rgba(255, 255, 255, 0.03)'
            },
            ticks: {
              color: '#93a0b5',
              font: { size: 11 }
            }
          },
          y: {
            type: 'linear',
            position: 'left',
            title: {
              display: true,
              text: 'Cost (USD)',
              color: '#7cf0ff',
              font: { weight: 'bold', size: 12 }
            },
            grid: {
              color: 'rgba(255, 255, 255, 0.03)'
            },
            ticks: {
              color: '#93a0b5',
              font: { size: 11 },
              callback: function(value) {
                return '$' + value.toFixed(2);
              }
            }
          },
          y1: {
            type: 'linear',
            position: 'right',
            title: {
              display: true,
              text: 'Conversations',
              color: '#eeb0ff',
              font: { weight: 'bold', size: 12 }
            },
            grid: {
              drawOnChartArea: false
            },
            ticks: {
              color: '#93a0b5',
              font: { size: 11 }
            }
          }
        }
      }
    });
  } catch (err) {
    console.error('Cost trend refresh error:', err);
  }
}

async function refreshEfficiencyTable() {
  const days = elements.periodSelect.value;

  try {
    const data = await loadCosts(days, 'model');
    const breakdown = data?.breakdown || [];

    if (!data || breakdown.length === 0) {
      elements.efficiencyEmpty.style.display = 'block';
      elements.efficiencyTableBody.innerHTML = '<tr><td colspan="8" style="padding: 16px; text-align: center; color: var(--muted);">No data</td></tr>';
      return;
    }

    elements.efficiencyEmpty.style.display = 'none';

    // Sort by efficiency (ascending cost per 1k tokens)
    const sorted = [...breakdown].sort((a, b) => (a.cost?.per1kTokens || 0) - (b.cost?.per1kTokens || 0));

    // Create rows
    elements.efficiencyTableBody.innerHTML = sorted.map((row, idx) => {
      const efficiencyLabel = idx === 0 ? 'Best ★' :
                              idx === sorted.length - 1 ? 'Least Efficient' :
                              `${idx + 1}/${sorted.length}`;
      const efficiencyColor = idx === 0 ? '#4ade80' :
                              idx === sorted.length - 1 ? '#f87171' :
                              '#fbbf24';
      const efficiencyBg = idx === 0 ? 'rgba(76, 222, 128, 0.2)' :
                           idx === sorted.length - 1 ? 'rgba(248, 113, 113, 0.2)' :
                           'rgba(251, 191, 36, 0.2)';

      return `
        <tr style="border-bottom: 1px solid var(--panel-border); transition: background 0.2s;">
          <td style="padding: 8px; color: var(--text); font-weight: 500;">
            <i class="fas fa-cube" style="color: var(--accent); margin-right: 6px; font-size: 11px;"></i>
            ${row.key || 'Unknown'}
          </td>
          <td style="padding: 8px; text-align: right; color: var(--accent);">
            <strong>$${(row.cost?.total || 0).toFixed(2)}</strong>
          </td>
          <td style="padding: 8px; text-align: right; color: var(--muted);">
            ${formatNumber(row.messages || 0)}
          </td>
          <td style="padding: 8px; text-align: right; color: var(--text);">
            ${formatNumber(row.tokens?.total || 0)}
          </td>
          <td style="padding: 8px; text-align: right; color: var(--text);">
            $${(row.cost?.per1kTokens || 0).toFixed(4)}
          </td>
          <td style="padding: 8px; text-align: right; color: #4ade80;">
            <strong>${Math.round(((row.cost?.total || 0) > 0 ? (row.tokens?.total || 0) / row.cost.total : 0) || 0).toLocaleString()}</strong>
          </td>
          <td style="padding: 8px; text-align: right; color: var(--text);">
            $${(row.cost?.avgPerConversation || 0).toFixed(3)}
          </td>
          <td style="padding: 8px; text-align: center;">
            <span style="background: ${efficiencyBg}; color: ${efficiencyColor}; padding: 2px 6px; border-radius: 4px; font-size: 11px; font-weight: 600;">
              ${efficiencyLabel}
            </span>
          </td>
        </tr>
      `;
    }).join('');
  } catch (err) {
    console.error('Efficiency table refresh error:', err);
    elements.efficiencyTableBody.innerHTML = '<tr><td colspan="8" style="padding: 16px; text-align: center; color: #f87171;">Error loading data</td></tr>';
  }
}

async function refreshCostBreakdown() {
  const days = elements.periodSelect.value;

  try {
    const data = await loadCosts(days, 'model');

    if (!data || !data.breakdown || data.breakdown.length === 0) {
      if (charts.costBreakdown) charts.costBreakdown.destroy();
      elements.costBreakdownEmpty.style.display = 'block';
      return;
    }

    elements.costBreakdownEmpty.style.display = 'none';

    // Generate colors
    const colors = [
      'rgba(124, 240, 255, 0.8)',
      'rgba(238, 176, 255, 0.8)',
      'rgba(74, 222, 128, 0.8)',
      'rgba(251, 191, 36, 0.8)',
      'rgba(59, 130, 246, 0.8)',
      'rgba(168, 85, 247, 0.8)',
      'rgba(236, 72, 153, 0.8)',
      'rgba(249, 115, 22, 0.8)'
    ];

    // Create chart
    if (charts.costBreakdown) charts.costBreakdown.destroy();

    const isDonut = elements.costBreakdownDonut.checked;

    const items = data.breakdown.map(item => ({
      label: item.key || 'Unknown',
      cost: item.cost?.total || 0,
      conversations: item.conversationCount || 0,
      tokens: item.tokens?.total || 0
    }));

    const totalCost = items.reduce((sum, item) => sum + item.cost, 0);

    const ctx = document.getElementById('costBreakdownChart').getContext('2d');
    charts.costBreakdown = new Chart(ctx, {
      type: isDonut ? 'doughnut' : 'pie',
      data: {
        labels: items.map(b => b.label),
        datasets: [{
          data: items.map(b => b.cost),
          backgroundColor: items.map((_, i) => colors[i % colors.length]),
          borderColor: 'rgba(12, 15, 26, 0.8)',
          borderWidth: 2,
          hoverOffset: 4
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: true,
        plugins: {
          legend: {
            display: false
          },
          tooltip: {
            backgroundColor: 'rgba(0, 0, 0, 0.8)',
            titleColor: '#7cf0ff',
            bodyColor: '#e8edf5',
            borderColor: 'rgba(255, 255, 255, 0.1)',
            borderWidth: 1,
            padding: 10,
            callbacks: {
              label: function(context) {
                const value = context.parsed;
                const total = context.dataset.data.reduce((a, b) => a + b, 0);
                const percentage = total > 0 ? ((value / total) * 100).toFixed(1) : '0.0';
                return `$${value.toFixed(2)} (${percentage}%)`;
              }
            }
          }
        }
      }
    });

    // Populate stats panel
    elements.costBreakdownStats.innerHTML = items
      .sort((a, b) => (b.cost || 0) - (a.cost || 0))
      .map((item, idx) => {
        const color = colors[idx % colors.length];
        const percentage = totalCost > 0 ? ((item.cost / totalCost) * 100) : 0;

        return `
          <div style="padding: 12px; background: rgba(255, 255, 255, 0.02); border-left: 3px solid ${color}; border-radius: 4px;">
            <div style="display: flex; justify-content: space-between; align-items: baseline; margin-bottom: 4px;">
              <strong style="color: var(--text);">${item.label}</strong>
              <span style="color: var(--accent); font-weight: 600;">$${(item.cost || 0).toFixed(2)}</span>
            </div>
            <div style="display: flex; justify-content: space-between; align-items: center; gap: 12px;">
              <div style="flex: 1;">
                <div style="height: 4px; background: rgba(255, 255, 255, 0.1); border-radius: 2px; overflow: hidden;">
                  <div style="height: 100%; width: ${percentage}%; background: ${color}; transition: width 0.3s;"></div>
                </div>
              </div>
              <span style="font-size: 11px; color: var(--muted); white-space: nowrap;">
                ${percentage.toFixed(1)}%
              </span>
            </div>
            <div style="font-size: 11px; color: var(--muted); margin-top: 6px; display: flex; justify-content: space-between;">
              <span>${item.conversations || 0} conversations</span>
              <span>${formatNumber(item.tokens || 0)} tokens</span>
            </div>
          </div>
        `;
      }).join('');
  } catch (err) {
    console.error('Cost breakdown refresh error:', err);
  }
}

/* -------------------------------------------------------------------------- */
/*                            System Metrics Logic                            */
/* -------------------------------------------------------------------------- */

let systemMetricsBackoffMs = 0;
let systemMetricsCooldownUntil = 0;

async function refreshSystem() {
  const now = Date.now();
  if (now < systemMetricsCooldownUntil) return;

  try {
    const [summary, database] = await Promise.all([
      fetchJSON('/api/metrics/summary'),
      fetchJSON('/api/metrics/database')
    ]);

    renderSystemMetrics({ summary, database });
    updateTimestamp();

    systemMetricsBackoffMs = 0;
    systemMetricsCooldownUntil = 0;

  } catch (err) {
    const status = err?.status;
    if (status === 429) {
      const retryAfterMs = Number.isFinite(err?.retryAfterMs) ? err.retryAfterMs : null;
      const nextBackoff = retryAfterMs ?? (systemMetricsBackoffMs ? systemMetricsBackoffMs * 2 : 15000);
      systemMetricsBackoffMs = Math.min(Math.max(nextBackoff, 15000), 120000);
      systemMetricsCooldownUntil = Date.now() + systemMetricsBackoffMs;

      if (Date.now() - systemMetricsLast429LogAt > 10000) {
        // eslint-disable-next-line no-console
        console.warn(`System metrics rate-limited (429). Backing off for ${Math.round(systemMetricsBackoffMs / 1000)}s`);
        systemMetricsLast429LogAt = Date.now();
      }
      return;
    }

    console.error('System metrics load failed', err);
  }
}

function updateTimestamp() {
  const now = new Date().toLocaleTimeString();
  elements.timestamp.textContent = `Updated: ${now}`;
}

function setStatus(el, val, healthyThreshold = 70, warningThreshold = 90, reverse = false) {
    let status = 'healthy';
    if (!reverse) {
        if (val >= healthyThreshold) status = 'healthy';
        else if (val >= 50) status = 'warning';
        else status = 'error';
    } else {
        // Lower is better (e.g. usage)
        if (val < healthyThreshold) status = 'healthy';
        else if (val < warningThreshold) status = 'warning';
        else status = 'error';
    }

    el.className = `status-dot ${status}`;
}

function renderSystemMetrics(metrics) {
  const summaryData = metrics.summary?.data ?? {};
  const databaseData = metrics.database?.data ?? {};

  // No cache service active (RAG stripped) — use safe defaults
  const cache = summaryData.cache ?? {
    hitRate: 0, hitCount: 0, missCount: 0,
    size: 0, maxSize: 0, memorySizeBytes: 0,
    avgEntrySizeBytes: 0, evictions: 0,
  };

  // Backend returns collections as an array; convert to keyed map expected by render code
  const rawCollections = Array.isArray(databaseData.collections)
    ? databaseData.collections.reduce((acc, c) => { acc[c.name] = c; return acc; }, {})
    : (databaseData.collections ?? {});
  const db = {
    collections: rawCollections,
    database: {
      indexes: databaseData.totals?.indexes ?? 0,
      name: summaryData.mongo?.name ?? '—',
    },
  };

  // Map mongo connection info to expected connection shape
  const mongoInfo = summaryData.mongo ?? {};
  const conn = summaryData.connection ?? {
    activeConnections: mongoInfo.readyState === 1 ? 1 : 0,
    poolSize: 100,
    host: mongoInfo.host ?? '—',
    availableConnections: mongoInfo.readyState === 1 ? 99 : 0,
    waitingConnections: 0,
    minPoolSize: 5,
  };

  // Map process/os info to expected system shape; backend memory is in MB, convert to bytes
  const proc = summaryData.process ?? {};
  const osInfo = summaryData.os ?? {};
  const memMB = proc.memoryUsage ?? {};
  const toBytes = mb => Math.round((mb ?? 0) * 1048576);
  const sys = summaryData.system ?? {
    memory: {
      heapUsed: toBytes(memMB.heapUsed),
      heapTotal: toBytes(memMB.heapTotal),
      formatted: {
        heapUsed: formatBytes(toBytes(memMB.heapUsed)),
        heapTotal: formatBytes(toBytes(memMB.heapTotal)),
        rss: formatBytes(toBytes(memMB.rss)),
      },
    },
    nodeVersion: proc.nodeVersion ?? 'unknown',
    uptime: { formatted: proc.uptimeFormatted ?? '—' },
    platform: osInfo.platform ?? 'linux',
  };

    // --- Cache ---
    const hitRate = (cache.hitRate * 100);
    elements.cacheHitRate.textContent = hitRate.toFixed(1) + '%';
    elements.cacheBar.style.width = `${hitRate}%`;
    setStatus(elements.cacheStatus, hitRate, 70, 50);

    elements.cacheHits.textContent = formatNumber(cache.hitCount);
    elements.cacheMisses.textContent = formatNumber(cache.missCount);
    elements.cacheSize.textContent = `${cache.size}/${cache.maxSize || '∞'}`;
    elements.cacheMem.textContent = formatBytes(cache.memorySizeBytes);

    elements.detailCacheTotal.textContent = formatNumber(cache.hitCount + cache.missCount);
    elements.detailCacheAvg.textContent = formatBytes(cache.avgEntrySizeBytes);
    elements.detailCacheEvict.textContent = formatNumber(cache.evictions);

    // --- Database ---
    const totalDocs = Object.values(db.collections).reduce((a, b) => a + (b.count || 0), 0);
    elements.dbTotalDocs.textContent = formatNumber(totalDocs);
    elements.dbConversations.textContent = formatNumber(db.collections.conversations?.count);
    elements.dbPrompts.textContent = formatNumber(db.collections.promptConfigs?.count);
    elements.dbUsers.textContent = formatNumber(db.collections.userProfiles?.count);
    elements.dbIndexes.textContent = db.database.indexes;

    elements.detailDbName.textContent = db.database.name;
    elements.detailDbHost.textContent = conn.host; // Conn has host info
    elements.detailDbCollections.textContent = Object.keys(db.collections).length;

    // --- Connections ---
    const activeConn = conn.activeConnections || 0;
    const maxConn = conn.poolSize || 100;
    const connUsage = (activeConn / maxConn) * 100;

    elements.connActive.textContent = activeConn;
    elements.connMax.textContent = maxConn;
    elements.connBar.style.width = `${connUsage}%`;
    setStatus(elements.connStatus, connUsage, 70, 90, true); // Reverse: lower usage is better/healthy until 70%

    elements.connAvail.textContent = conn.availableConnections;
    elements.connWaiting.textContent = conn.waitingConnections;
    elements.connPool.textContent = `${conn.minPoolSize}-${conn.poolSize}`;

    // --- System ---
    // Use heap metrics consistently for the Memory (Heap) display
    elements.sysMem.textContent = formatBytes(sys.memory.heapUsed);
    elements.sysTotalMem.textContent = formatBytes(sys.memory.heapTotal);
    const memUsagePercent = (sys.memory.heapUsed / sys.memory.heapTotal) * 100;
    elements.sysBar.style.width = `${memUsagePercent}%`;
    setStatus(elements.sysStatus, memUsagePercent, 80, 90, true);

    // Safe access to optional elements
    if (elements.sysNode) elements.sysNode.textContent = sys.nodeVersion || 'v18+';
    if (elements.sysUptime) elements.sysUptime.textContent = sys.uptime.formatted;
    if (elements.sysPlatform) elements.sysPlatform.textContent = sys.platform || 'Linux';

    if (elements.detailHeapUsed) elements.detailHeapUsed.textContent = sys.memory.formatted.heapUsed;
    if (elements.detailHeapTotal) elements.detailHeapTotal.textContent = sys.memory.formatted.heapTotal;
    if (elements.detailRss) elements.detailRss.textContent = sys.memory.formatted.rss;
}

async function clearCache() {
    if (!confirm('Clear embedding cache? This will reset all cache statistics.')) return;
    try {
        await fetchJSON('/api/metrics/cache/clear', 'POST');
        refreshSystem();
    } catch (e) {
        alert('Failed to clear cache');
    }
}

/* -------------------------------------------------------------------------- */
/*                              RAG Metrics                                   */
/* -------------------------------------------------------------------------- */

async function refreshRagMetrics() {
    try {
        const data = await fetchJSON('/api/rag/metrics');

        if (!data || !data.stats) {
            if (elements.ragEmpty) elements.ragEmpty.style.display = 'block';
            return;
        }

        if (elements.ragEmpty) elements.ragEmpty.style.display = 'none';

        const stats = data.stats;

        // Update stats cards
        if (elements.ragTotalDocs) {
            elements.ragTotalDocs.textContent = stats.totalDocuments == null ? '—' : formatNumber(stats.totalDocuments);
        }
        if (elements.ragTotalChunks) {
            elements.ragTotalChunks.textContent = stats.totalChunks == null ? '—' : formatNumber(stats.totalChunks);
        }
        if (elements.ragAvgChunks) {
            elements.ragAvgChunks.textContent = stats.avgChunksPerDoc == null ? '—' : stats.avgChunksPerDoc;
        }
        if (elements.ragHealth) {
            const health = data.healthy === true
                ? { icon: '✓', color: 'var(--success)', label: 'Healthy' }
                : data.healthy === false
                    ? { icon: '✗', color: 'var(--danger)', label: 'Unhealthy' }
                    : { icon: '?', color: 'var(--warning)', label: 'Unknown' };
            elements.ragHealth.innerHTML = `<span style="color: ${health.color}">${health.icon} ${health.label}</span>`;
        }

        // Update source breakdown table
        if (elements.ragSourcesBody && !stats.sourceBreakdown) {
            elements.ragSourcesBody.innerHTML = '<tr><td colspan="4" style="padding:16px;text-align:center;color:var(--muted);">Source breakdown unavailable from the RAG service.</td></tr>';
        } else if (elements.ragSourcesBody && stats.sourceBreakdown) {
            const sources = Object.entries(stats.sourceBreakdown);

            if (sources.length === 0) {
                elements.ragSourcesBody.innerHTML = `
                    <tr>
                        <td colspan="4" style="padding: 16px; text-align: center; color: var(--muted);">
                            No documents ingested yet
                        </td>
                    </tr>
                `;
            } else {
                elements.ragSourcesBody.innerHTML = sources.map(([source, data]) => {
                    const avgChunks = data.count > 0 ? (data.chunks / data.count).toFixed(1) : '0';
                    const avgNum = parseFloat(avgChunks);

                    // Color code avg chunks based on typical range (12-20)
                    let avgColor = 'var(--text)';
                    let avgIcon = '';
                    if (avgNum < 8) {
                        avgColor = '#f59e0b'; // amber - low chunks
                        avgIcon = '<i class="fas fa-exclamation-triangle" style="font-size: 10px; margin-left: 4px;" title="Low chunk count - document may be very short"></i>';
                    } else if (avgNum >= 12 && avgNum <= 25) {
                        avgColor = '#10b981'; // green - optimal
                        avgIcon = '<i class="fas fa-check-circle" style="font-size: 10px; margin-left: 4px;" title="Optimal chunk count"></i>';
                    } else if (avgNum > 30) {
                        avgColor = '#3b82f6'; // blue - large docs
                        avgIcon = '<i class="fas fa-info-circle" style="font-size: 10px; margin-left: 4px;" title="Large documents"></i>';
                    }

                    return `
                        <tr style="border-bottom: 1px solid rgba(255,255,255,0.05);">
                            <td style="padding: 8px;">
                                <i class="fas fa-folder" style="color: var(--muted); margin-right: 6px;"></i>${source}
                            </td>
                            <td style="padding: 8px; text-align: right;">${formatNumber(data.count)}</td>
                            <td style="padding: 8px; text-align: right;">${formatNumber(data.chunks)}</td>
                            <td style="padding: 8px; text-align: right; color: ${avgColor}; font-weight: 500;">
                                ${avgChunks}${avgIcon}
                            </td>
                        </tr>
                    `;
                }).join('');
            }
        }

        // Update date info
        if (elements.ragOldest) {
            elements.ragOldest.textContent = stats.oldestDocument
                ? new Date(stats.oldestDocument).toLocaleString()
                : 'not recorded';
        }
        if (elements.ragNewest) {
            elements.ragNewest.textContent = stats.newestDocument
                ? new Date(stats.newestDocument).toLocaleString()
                : 'not recorded';
        }

        // Update timestamp
        const timestampEl = document.getElementById('ragMetricsTimestamp');
        if (timestampEl) {
            const now = new Date();
            timestampEl.textContent = `Updated ${now.toLocaleTimeString()}`;
        }

    } catch (error) {
        console.error('Failed to fetch RAG metrics:', error);

        // Show more helpful error in the UI
        if (elements.ragEmpty) {
            elements.ragEmpty.innerHTML = `
                <div style="color: var(--danger); padding: 20px; text-align: center;">
                    <i class="fas fa-exclamation-triangle"></i><br>
                    <strong>Failed to load RAG metrics</strong><br>
                    <small style="color: var(--muted);">${error.message}</small>
                </div>
            `;
            elements.ragEmpty.style.display = 'block';
        }

        // Set all fields to error state
        if (elements.ragTotalDocs) elements.ragTotalDocs.textContent = 'Error';
        if (elements.ragTotalChunks) elements.ragTotalChunks.textContent = 'Error';
        if (elements.ragAvgChunks) elements.ragAvgChunks.textContent = 'Error';
        if (elements.ragHealth) {
            elements.ragHealth.innerHTML = '<span style="color: var(--danger)">✗ Error</span>';
        }
    }
}

/* -------------------------------------------------------------------------- */
/*                                Initialization                              */
/* -------------------------------------------------------------------------- */

async function refreshAll() {
    elements.refreshBtn.innerHTML = '<i class="fas fa-sync-alt fa-spin"></i> Refreshing...';
    elements.refreshBtn.disabled = true;

    try {
        await Promise.all([
            refreshProduct(),
            refreshSystem(),
            refreshRagMetrics(),
            refreshCostStats(),
            refreshCostTrend(),
            refreshEfficiencyTable(),
            refreshCostBreakdown()
        ]);
    } catch (e) {
        console.error('Refresh failed:', e);
    } finally {
        elements.refreshBtn.innerHTML = '<i class="fas fa-sync-alt"></i> Refresh';
        elements.refreshBtn.disabled = false;
    }
}

async function refreshAllCostTracking() {
    try {
        await Promise.all([
            refreshCostStats(),
            refreshCostTrend(),
            refreshEfficiencyTable(),
            refreshCostBreakdown()
        ]);
    } catch (e) {
        console.error('Cost tracking refresh failed:', e);
    }
}

document.addEventListener('DOMContentLoaded', async () => {
  const isAuthenticated = await checkAuth();
  if (!isAuthenticated) return;

  // Event Listeners
  if (elements.refreshBtn) elements.refreshBtn.addEventListener('click', refreshAll);
  if (elements.refreshRagBtn) {
    elements.refreshRagBtn.addEventListener('click', async () => {
      elements.refreshRagBtn.innerHTML = '<i class="fas fa-sync-alt fa-spin"></i> Refreshing...';
      elements.refreshRagBtn.disabled = true;
      try {
        await refreshRagMetrics();
      } finally {
        elements.refreshRagBtn.innerHTML = '<i class="fas fa-sync-alt"></i> Refresh';
        elements.refreshRagBtn.disabled = false;
      }
    });
  }

  // Toggle RAG help panel
  const toggleRagHelpBtn = document.getElementById('toggleRagHelp');
  const ragHelpPanel = document.getElementById('ragHelpPanel');
  if (toggleRagHelpBtn && ragHelpPanel) {
    toggleRagHelpBtn.addEventListener('click', () => {
      const isVisible = ragHelpPanel.style.display !== 'none';
      ragHelpPanel.style.display = isVisible ? 'none' : 'block';
    });
  }
  if (elements.periodSelect) {
    elements.periodSelect.addEventListener('change', () => {
      refreshProduct();
      refreshAllCostTracking();
    });
  }
  if (elements.usageGroupSelect) elements.usageGroupSelect.addEventListener('change', refreshProduct);
  if (elements.feedbackGroupSelect) elements.feedbackGroupSelect.addEventListener('change', refreshProduct);

  // Cost Tracking Event Listeners
  if (elements.costTrendGroupSelect) {
    elements.costTrendGroupSelect.addEventListener('change', refreshCostTrend);
  }
  if (elements.efficiencyRefreshBtn) {
    elements.efficiencyRefreshBtn.addEventListener('click', async () => {
      elements.efficiencyRefreshBtn.innerHTML = '<i class="fas fa-sync-alt fa-spin"></i> Refreshing...';
      elements.efficiencyRefreshBtn.disabled = true;
      try {
        await refreshEfficiencyTable();
      } finally {
        elements.efficiencyRefreshBtn.innerHTML = '<i class="fas fa-sync-alt"></i> Refresh';
        elements.efficiencyRefreshBtn.disabled = false;
      }
    });
  }
  if (elements.costBreakdownPie) {
    elements.costBreakdownPie.addEventListener('change', refreshCostBreakdown);
  }
  if (elements.costBreakdownDonut) {
    elements.costBreakdownDonut.addEventListener('change', refreshCostBreakdown);
  }

  // Initial Load
  refreshAll();

  // The System Metrics block this poll fed is display:none in analytics.ejs,
  // and /api/metrics/database runs db.stats() plus a per-collection stats()
  // across ~85 collections. Polling an invisible panel every 15s is pure load,
  // so the poller is not started here. Re-enable alongside the panel if it
  // is ever made visible again.
});
