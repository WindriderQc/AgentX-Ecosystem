/**
 * Analytics — Shared State, Utilities & Product Analytics
 *
 * Exports: elements, charts, buildRangeQuery, checkAuth, fetchJSON,
 *          formatBytes, formatNumber, refreshProduct
 * Consumed by: analytics-cost.js (the main module entry point)
 */

const elements = {
  // Product Analytics Elements
  periodSelect: document.getElementById('periodSelect'),
  usageGroupSelect: document.getElementById('usageGroupSelect'),
  feedbackGroupSelect: document.getElementById('feedbackGroupSelect'),
  refreshBtn: document.getElementById('refreshBtn'),
  totalConversations: document.getElementById('totalConversations'),
  totalMessages: document.getElementById('totalMessages'),
  positiveFeedback: document.getElementById('positiveFeedback'),
  positiveRate: document.getElementById('positiveRate'),
  feedbackSampleSize: document.getElementById('feedbackSampleSize'),
  ragUsage: document.getElementById('ragUsage'),
  ragConversations: document.getElementById('ragConversations'),
  ragRequestedConversations: document.getElementById('ragRequestedConversations'),
  ragRequestedNotUsed: document.getElementById('ragRequestedNotUsed'),
  noRagConversations: document.getElementById('noRagConversations'),
  ragPositiveRate: document.getElementById('ragPositiveRate'),
  noRagPositiveRate: document.getElementById('noRagPositiveRate'),
  ragDelta: document.getElementById('ragDelta'),
  ragDonutLabel: document.getElementById('ragDonutLabel'),
  usageEmpty: document.getElementById('usageEmpty'),
  feedbackEmpty: document.getElementById('feedbackEmpty'),

  // RAG Metrics Elements
  refreshRagBtn: document.getElementById('refreshRagBtn'),
  ragTotalDocs: document.getElementById('ragTotalDocs'),
  ragTotalChunks: document.getElementById('ragTotalChunks'),
  ragAvgChunks: document.getElementById('ragAvgChunks'),
  ragHealth: document.getElementById('ragHealth'),
  ragSourcesBody: document.getElementById('ragSourcesBody'),
  ragOldest: document.getElementById('ragOldest'),
  ragNewest: document.getElementById('ragNewest'),
  ragEmpty: document.getElementById('ragEmpty'),

  // Cost Tracking Elements
  totalCost: document.getElementById('totalCost'),
  totalCostConvCount: document.getElementById('totalCostConvCount'),
  costPerConversation: document.getElementById('costPerConversation'),
  costPerConvMessages: document.getElementById('costPerConvMessages'),
  costPer1kTokens: document.getElementById('costPer1kTokens'),
  costTotalTokens: document.getElementById('costTotalTokens'),
  tokensPerDollar: document.getElementById('tokensPerDollar'),
  costTrendGroupSelect: document.getElementById('costTrendGroupSelect'),
  costTrendEmpty: document.getElementById('costTrendEmpty'),
  efficiencyRefreshBtn: document.getElementById('efficiencyRefreshBtn'),
  efficiencyTableBody: document.getElementById('efficiencyTableBody'),
  efficiencyEmpty: document.getElementById('efficiencyEmpty'),
  costBreakdownPie: document.getElementById('costBreakdownPie'),
  costBreakdownDonut: document.getElementById('costBreakdownDonut'),
  costBreakdownStats: document.getElementById('costBreakdownStats'),
  costBreakdownEmpty: document.getElementById('costBreakdownEmpty'),

  // System Metrics Elements
  // clearCacheBtn: document.getElementById('clearCacheBtn'), // Removed in single-page view
  timestamp: document.getElementById('sysTimestamp'), // Updated ID
  // Cache
  cacheStatus: document.getElementById('cacheStatus'),
  cacheHitRate: document.getElementById('cacheHitRate'),
  cacheBar: document.getElementById('cacheBar'),
  cacheHits: document.getElementById('cacheHits'),
  cacheMisses: document.getElementById('cacheMisses'),
  cacheSize: document.getElementById('cacheSize'),
  cacheMem: document.getElementById('cacheMem'),
  // DB
  dbTotalDocs: document.getElementById('dbTotalDocs'),
  dbConversations: document.getElementById('dbConversations'),
  dbPrompts: document.getElementById('dbPrompts'),
  dbUsers: document.getElementById('dbUsers'),
  dbIndexes: document.getElementById('dbIndexes'),
  // Conn
  connStatus: document.getElementById('connStatus'),
  connActive: document.getElementById('connActive'),
  connMax: document.getElementById('connMax'),
  connBar: document.getElementById('connBar'),
  connAvail: document.getElementById('connAvail'),
  connWaiting: document.getElementById('connWaiting'),
  connPool: document.getElementById('connPool'),
  // System
  sysStatus: document.getElementById('sysStatus'),
  sysMem: document.getElementById('sysMem'),
  sysTotalMem: document.getElementById('sysTotalMem'),
  sysBar: document.getElementById('sysBar'),
  sysNode: document.getElementById('sysNode'),
  sysUptime: document.getElementById('sysUptime'),
  sysPlatform: document.getElementById('sysPlatform'),
  // Details
  detailCacheTotal: document.getElementById('detailCacheTotal'),
  detailCacheAvg: document.getElementById('detailCacheAvg'),
  detailCacheEvict: document.getElementById('detailCacheEvict'),
  detailDbName: document.getElementById('detailDbName'),
  detailDbHost: document.getElementById('detailDbHost'),
  detailDbCollections: document.getElementById('detailDbCollections'),
  detailHeapUsed: document.getElementById('detailHeapUsed'),
  detailHeapTotal: document.getElementById('detailHeapTotal'),
  detailRss: document.getElementById('detailRss'),
};

const charts = {
  usage: null,
  feedback: null,
  rag: null,
  costTrend: null,
  costBreakdown: null,
};

let poller = null;

/* -------------------------------------------------------------------------- */
/*                                Utility Fns                                 */
/* -------------------------------------------------------------------------- */

function formatNumber(num) {
  if (num === null || num === undefined) return '–';
  return num.toLocaleString();
}

function formatPercent(value) {
  if (value === null || value === undefined || Number.isNaN(value)) return '–';
  return `${(value * 100).toFixed(1)}%`;
}

function formatBytes(bytes) {
  if (bytes === 0 || bytes === undefined) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return Math.round((bytes / Math.pow(k, i)) * 100) / 100 + ' ' + sizes[i];
}

function formatUptime(seconds) {
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const mins = Math.floor((seconds % 3600) / 60);
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${mins}m`;
  return `${mins}m`;
}

function periodRange(days) {
  const to = new Date();
  const from = new Date();
  from.setDate(to.getDate() - Number(days));
  return { from, to };
}

async function fetchJSON(url, method = 'GET') {
  const headers = { 'Content-Type': 'application/json' };

  const res = await fetch(url, { method, credentials: 'include', headers });
  if (res.status === 401) {
    throw new Error('Unauthorized');
  }

  if (!res.ok) {
    const retryAfter = res.headers.get('retry-after');
    const retryAfterMs = (() => {
      if (!retryAfter) return null;
      const seconds = Number(retryAfter);
      if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
      const asDate = Date.parse(retryAfter);
      if (!Number.isNaN(asDate)) return Math.max(0, asDate - Date.now());
      return null;
    })();

    const error = new Error(`Request failed: ${res.status}`);
    error.status = res.status;
    error.retryAfterMs = retryAfterMs;
    throw error;
  }

  // Check if response is actually JSON
  const contentType = res.headers.get('content-type');
  if (!contentType || !contentType.includes('application/json')) {
    const text = await res.text();
    throw new Error(`Expected JSON but got ${contentType}: ${text.substring(0, 100)}`);
  }

  return res.json();
}

let systemMetricsCooldownUntil = 0;
let systemMetricsBackoffMs = 0;
let systemMetricsLast429LogAt = 0;

async function checkAuth() {
  return true;
}

/* -------------------------------------------------------------------------- */
/*                            Product Analytics Logic                         */
/* -------------------------------------------------------------------------- */

function buildRangeQuery(days) {
  const { from, to } = periodRange(days);
  const params = new URLSearchParams({
    from: from.toISOString(),
    to: to.toISOString(),
  });
  return params.toString();
}

async function loadUsage(days, groupBy) {
  const query = buildRangeQuery(days);
  const qs = new URLSearchParams(`${query}&groupBy=${groupBy}`);
  const response = await fetchJSON(`/api/analytics/usage?${qs.toString()}`);
  return response.data;
}

async function loadFeedback(days, groupBy) {
  const query = buildRangeQuery(days);
  const qs = new URLSearchParams(`${query}&groupBy=${groupBy}`);
  const response = await fetchJSON(`/api/analytics/feedback?${qs.toString()}`);
  return response.data;
}

async function loadRag(days) {
  const query = buildRangeQuery(days);
  const response = await fetchJSON(`/api/analytics/rag-stats?${query}`);
  return response.data;
}

function renderUsageChart(data, groupBy) {
  const labels = data.breakdown.map((item) => {
    if (groupBy === 'day') return item.date;
    if (groupBy === 'model') return item.model || 'Unknown model';
    return item.promptVersion || 'No version';
  });

  const conversations = data.breakdown.map((item) => item.conversations || 0);
  const messages = data.breakdown.map((item) => item.messages || 0);

  const ctx = document.getElementById('usageChart').getContext('2d');
  if (charts.usage) charts.usage.destroy();

  charts.usage = new Chart(ctx, {
    type: groupBy === 'day' ? 'line' : 'bar',
    data: {
      labels,
      datasets: [
        {
          label: 'Conversations',
          data: conversations,
          borderColor: '#7cf0ff',
          backgroundColor: 'rgba(124, 240, 255, 0.35)',
          tension: 0.3,
        },
        {
          label: 'Messages',
          data: messages,
          borderColor: '#eeb0ff',
          backgroundColor: 'rgba(238, 176, 255, 0.3)',
          tension: 0.3,
        },
      ],
    },
    options: {
      responsive: true,
      plugins: {
        legend: { position: 'top' },
        tooltip: {
          callbacks: {
            label: function(context) {
              const label = context.dataset.label || '';
              const value = context.parsed.y;
              return `${label}: ${formatNumber(value)}`;
            }
          }
        }
      },
      scales: {
        y: { beginAtZero: true },
      },
    },
  });
}

function renderFeedbackChart(data, groupBy) {
  const labels = data.breakdown.map((item) => {
    if (groupBy === 'model') return item.model || 'Unknown model';
    return `${item.promptName || 'Prompt'} v${item.promptVersion || '–'}`;
  });

  const positive = data.breakdown.map((item) => item.positive || 0);
  const negative = data.breakdown.map((item) => item.negative || 0);

  const ctx = document.getElementById('feedbackChart').getContext('2d');
  if (charts.feedback) charts.feedback.destroy();

  charts.feedback = new Chart(ctx, {
    type: 'bar',
    data: {
      labels,
      datasets: [
        {
          label: 'Positive',
          data: positive,
          backgroundColor: 'rgba(124, 240, 255, 0.6)',
          borderColor: '#7cf0ff',
          stack: 'feedback',
        },
        {
          label: 'Negative',
          data: negative,
          backgroundColor: 'rgba(255, 99, 132, 0.5)',
          borderColor: '#ff6384',
          stack: 'feedback',
        },
      ],
    },
    options: {
      responsive: true,
      plugins: {
        legend: { position: 'top' },
        tooltip: {
          callbacks: {
            footer: function(tooltipItems) {
              const total = tooltipItems.reduce((sum, item) => sum + item.parsed.y, 0);
              const positive = tooltipItems.find(item => item.dataset.label === 'Positive')?.parsed.y || 0;
              const rate = total > 0 ? (positive / total * 100).toFixed(1) : '0.0';
              return `\nTotal: ${total} | Positive: ${rate}%`;
            }
          }
        }
      },
      scales: {
        x: { stacked: true },
        y: { stacked: true, beginAtZero: true },
      },
    },
  });
}

function renderRagChart(data) {
  const ctx = document.getElementById('ragDonut').getContext('2d');
  if (charts.rag) charts.rag.destroy();

  const { ragConversations, noRagConversations } = data;
  const labels = ['RAG Used', 'Non-RAG'];
  const values = [ragConversations, noRagConversations];

  charts.rag = new Chart(ctx, {
    type: 'doughnut',
    data: {
      labels,
      datasets: [
        {
          data: values,
          backgroundColor: ['rgba(124, 240, 255, 0.7)', 'rgba(238, 176, 255, 0.35)'],
          borderColor: ['#7cf0ff', '#eeb0ff'],
          borderWidth: 1,
        },
      ],
    },
    options: {
      cutout: '70%',
      plugins: {
        legend: { position: 'bottom' },
        tooltip: {
          callbacks: {
            label: function(context) {
              const label = context.label || '';
              const value = context.parsed;
              const total = context.dataset.data.reduce((a, b) => a + b, 0);
              const percentage = total > 0 ? (value / total * 100).toFixed(1) : '0.0';
              return `${label}: ${formatNumber(value)} conversations (${percentage}%)`;
            }
          }
        },
      },
    },
  });

  elements.ragDonutLabel.textContent = formatPercent(data.ragUsageRate);
}

function updateProductSummary(usage = {}, feedback = {}, rag = {}) {
  if (elements.totalConversations) elements.totalConversations.textContent = formatNumber(usage.totalConversations);
  if (elements.totalMessages) elements.totalMessages.textContent = formatNumber(usage.totalMessages);
  if (elements.positiveFeedback) elements.positiveFeedback.textContent = formatNumber(feedback.positive);
  if (elements.positiveRate) {
    elements.positiveRate.textContent =
      feedback.totalFeedback > 0 ? `(${formatPercent(feedback.positiveRate)} positive)` : '(no feedback)';
  }
  if (elements.feedbackSampleSize) {
    const total = feedback.totalFeedback || 0;
    elements.feedbackSampleSize.textContent = formatNumber(total);
  }

  if (elements.ragUsage) elements.ragUsage.textContent = formatPercent(rag.ragUsageRate);
  if (elements.ragConversations) elements.ragConversations.textContent = formatNumber(rag.ragConversations);
  if (elements.ragRequestedConversations)
    elements.ragRequestedConversations.textContent = formatNumber(rag.ragRequestedConversations);
  if (elements.noRagConversations) elements.noRagConversations.textContent = formatNumber(rag.noRagConversations);

  const ragFbTotal = rag?.feedback?.rag?.total;
  const ragFbPositive = rag?.feedback?.rag?.positive;
  const ragPositiveRate = rag?.feedback?.rag?.positiveRate;

  const noRagFbTotal = rag?.feedback?.noRag?.total;
  const noRagFbPositive = rag?.feedback?.noRag?.positive;
  const noRagPositiveRate = rag?.feedback?.noRag?.positiveRate;

  if (elements.ragPositiveRate) {
    elements.ragPositiveRate.textContent =
      ragFbTotal > 0 ? `${formatPercent(ragPositiveRate)} (${formatNumber(ragFbPositive)}/${formatNumber(ragFbTotal)})` : '–';
  }
  if (elements.noRagPositiveRate) {
    elements.noRagPositiveRate.textContent =
      noRagFbTotal > 0
        ? `${formatPercent(noRagPositiveRate)} (${formatNumber(noRagFbPositive)}/${formatNumber(noRagFbTotal)})`
        : '–';
  }

  if (elements.ragRequestedNotUsed) {
    const requested = rag?.ragRequestedConversations;
    const used = rag?.ragConversations;
    const notUsed =
      Number.isFinite(requested) && Number.isFinite(used) ? Math.max(0, requested - used) : null;
    elements.ragRequestedNotUsed.textContent = formatNumber(notUsed);
  }

  const delta = ragPositiveRate - noRagPositiveRate;
  if (elements.ragDelta) {
    elements.ragDelta.textContent = Number.isFinite(delta) ? `${delta >= 0 ? '+' : ''}${(delta * 100).toFixed(1)} pts` : '–';
  }
}

function toggleEmptyState(container, emptyEl, hasData) {
  if (hasData) {
    container.style.display = 'block';
    emptyEl.style.display = 'none';
  } else {
    container.style.display = 'none';
    emptyEl.style.display = 'block';
  }
}

async function refreshProduct() {
  const days = elements.periodSelect.value;
  const usageGroup = elements.usageGroupSelect.value;
  const feedbackGroup = elements.feedbackGroupSelect.value;

  try {
    const [usageResult, feedbackResult, ragResult] = await Promise.allSettled([
      loadUsage(days, usageGroup),
      loadFeedback(days, feedbackGroup),
      loadRag(days),
    ]);

    const usage = usageResult.status === 'fulfilled' ? usageResult.value : null;
    const feedback = feedbackResult.status === 'fulfilled' ? feedbackResult.value : null;
    const rag = ragResult.status === 'fulfilled' ? ragResult.value : null;

    updateProductSummary(usage || {}, feedback || {}, rag || {});

    const usageHasData = !!(usage && usage.breakdown && usage.breakdown.length > 0);
    toggleEmptyState(document.getElementById('usageChart'), elements.usageEmpty, usageHasData);
    if (usageHasData) renderUsageChart(usage, usageGroup);

    const feedbackHasData = !!(feedback && feedback.breakdown && feedback.breakdown.length > 0);
    toggleEmptyState(document.getElementById('feedbackChart'), elements.feedbackEmpty, feedbackHasData);
    if (feedbackHasData) renderFeedbackChart(feedback, feedbackGroup);

    const ragHasData = !!(rag && rag.totalConversations > 0);
    if (ragHasData) renderRagChart(rag);
    else if (elements.ragDonutLabel) elements.ragDonutLabel.textContent = '–';

    if (usageResult.status === 'rejected') console.warn('Usage analytics failed', usageResult.reason);
    if (feedbackResult.status === 'rejected') console.warn('Feedback analytics failed', feedbackResult.reason);
    if (ragResult.status === 'rejected') console.warn('RAG analytics failed', ragResult.reason);
  } catch (err) {
    console.error('Analytics load failed', err);
    // Don't alert aggressively on auto-refresh or tab switches, just log
  }
}


export { elements, charts, buildRangeQuery, checkAuth, fetchJSON, formatBytes, formatNumber, refreshProduct };
