/**
 * RAG Dashboard — fetches health + status and updates the DOM.
 * Depends on: js/api.js (window.RAG)
 */

(function () {
  'use strict';

  var REFRESH_INTERVAL = 30000; // 30 seconds
  var refreshInFlight = false;
  var latestHealth = null;
  var latestStatus = null;

  // ── DOM refs (resolved once on load) ──────────────────────

  var els = {};

  function cacheElements() {
    els.serviceStatus   = document.getElementById('service-status');
    els.serviceDot      = document.getElementById('service-dot');
    els.depMongo        = document.getElementById('dep-mongo');
    els.depQdrant       = document.getElementById('dep-qdrant');
    els.depEmbedding    = document.getElementById('dep-embedding');
    els.statDocs        = document.getElementById('stat-docs');
    els.statChunks      = document.getElementById('stat-chunks');
    els.statDimension   = document.getElementById('stat-dimension');
    els.lastUpdated     = document.getElementById('last-updated');
    els.emptyBanner     = document.getElementById('empty-index-banner');
    els.emptyDetail     = document.getElementById('empty-banner-detail');
    els.opsService      = document.getElementById('ops-service');
    els.opsServiceValue = document.getElementById('ops-service-value');
    els.opsServiceDetail = document.getElementById('ops-service-detail');
    els.opsCorpus       = document.getElementById('ops-corpus');
    els.opsCorpusValue  = document.getElementById('ops-corpus-value');
    els.opsCorpusDetail = document.getElementById('ops-corpus-detail');
    els.opsEmbedding    = document.getElementById('ops-embedding');
    els.opsEmbeddingValue = document.getElementById('ops-embedding-value');
    els.opsEmbeddingDetail = document.getElementById('ops-embedding-detail');
    els.opsQuery        = document.getElementById('ops-query');
    els.opsQueryValue   = document.getElementById('ops-query-value');
    els.opsQueryDetail  = document.getElementById('ops-query-detail');
  }

  // ── Render helpers ────────────────────────────────────────

  function renderDot(healthy) {
    return healthy ? 'ok' : 'error';
  }

  function normalizeState(state) {
    if (state === 'warn') return 'warn';
    if (state === true || state === 'ok') return 'ok';
    return 'error';
  }

  function renderHealthSuccess(health) {
    latestHealth = health;
    var isOk = health.status === 'ok';

    if (els.serviceDot) {
      els.serviceDot.className = 'status-dot ' + (isOk ? 'ok' : 'error');
    }

    if (els.serviceStatus) {
      els.serviceStatus.textContent = isOk ? 'ok' : 'degraded';
      els.serviceStatus.className = isOk ? 'status-ok' : 'status-error';
    }

    var dbOk = health.db === 'connected';
    renderDepRow(els.depMongo, 'MongoDB', dbOk, dbOk ? 'connected' : 'disconnected');
    renderOpsStrip();
  }

  function renderHealthFailure() {
    latestHealth = { status: 'unavailable', db: 'disconnected' };
    if (els.serviceDot) els.serviceDot.className = 'status-dot error';
    if (els.serviceStatus) {
      els.serviceStatus.textContent = 'unavailable';
      els.serviceStatus.className = 'status-error';
    }
    renderDepRow(els.depMongo, 'MongoDB', false, 'unavailable');
    renderOpsStrip();
  }

  function renderStatusSuccess(data) {
    latestStatus = data || {};
    var qdrantOk = data.vectorStore && data.vectorStore.healthy;
    var qdrantDetail = qdrantOk
      ? (data.vectorStore.type || 'qdrant')
      : (data.vectorStore && data.vectorStore.error ? data.vectorStore.error : 'unhealthy');
    renderDepRow(els.depQdrant, 'Qdrant', qdrantOk, qdrantDetail);

    var emb = data.dependencies && data.dependencies.embedding ? data.dependencies.embedding : null;
    var embModel = data.embeddingModel || '';
    var embOk = !!(emb && emb.healthy === true);
    var embChecking = !!(emb && emb.checking === true);
    var embState = embChecking ? 'warn' : (embOk ? 'ok' : 'error');
    var embDetail = embOk
      ? formatEmbeddingDetail(emb, embModel)
      : ((emb && emb.error) || 'unavailable');
    renderDepRow(els.depEmbedding, 'Embedding Provider', embState, embDetail);

    if (els.statDocs) els.statDocs.textContent = formatNumber(data.documentCount);
    if (els.statChunks) els.statChunks.textContent = formatNumber(data.chunkCount);
    if (els.statDimension) els.statDimension.textContent = data.vectorDimension || '--';

    // Empty-index banner: loud when documentCount === 0
    renderEmptyBanner(data);
    renderOpsStrip();
  }

  function renderEmptyBanner(data) {
    if (!els.emptyBanner) return;
    var docs = Number(data && data.documentCount);
    if (!isFinite(docs) || docs > 0) {
      els.emptyBanner.style.display = 'none';
      return;
    }
    els.emptyBanner.style.display = 'flex';
    // Fill in what we already know synchronously, then refine with metrics fetch.
    var embModel = (data && data.embeddingModel) || 'unknown';
    var dim = (data && data.vectorDimension) || '?';
    var baseline = 'Embedding: ' + embModel + ' · dim ' + dim + ' · last ingest: checking…';
    if (els.emptyDetail) els.emptyDetail.textContent = baseline;

    // Metrics endpoint exposes lastIngest {timestamp, source}. Fire-and-forget.
    fetch('/api/rag/metrics', { cache: 'no-store' })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (payload) {
        if (!els.emptyDetail) return;
        var li = payload && payload.data && payload.data.lastIngest;
        var ingestStr;
        if (!li || !li.timestamp) {
          ingestStr = 'last ingest: never';
        } else {
          var age = ageSince(new Date(li.timestamp));
          ingestStr = 'last ingest: ' + age + ' ago' + (li.source ? ' (' + li.source + ')' : '');
        }
        els.emptyDetail.textContent = 'Embedding: ' + embModel + ' · dim ' + dim + ' · ' + ingestStr;
      })
      .catch(function () { /* baseline already rendered */ });
  }

  function ageSince(date) {
    var s = Math.floor((Date.now() - date.getTime()) / 1000);
    if (s < 60) return s + 's';
    if (s < 3600) return Math.floor(s / 60) + 'm';
    if (s < 86400) return Math.floor(s / 3600) + 'h';
    return Math.floor(s / 86400) + 'd';
  }

  function renderStatusFailure() {
    latestStatus = null;
    renderDepRow(els.depQdrant, 'Qdrant', false, 'unavailable');
    renderDepRow(els.depEmbedding, 'Embedding Provider', false, 'unavailable');
    if (els.statDocs) els.statDocs.textContent = '--';
    if (els.statChunks) els.statChunks.textContent = '--';
    if (els.statDimension) els.statDimension.textContent = '--';
    if (els.emptyBanner) els.emptyBanner.style.display = 'none';
    renderOpsStrip();
  }

  function setOpsItem(root, valueEl, detailEl, state, value, detail) {
    if (!root) return;
    root.className = 'rag-ops-item is-' + state;
    if (valueEl) valueEl.textContent = value;
    if (detailEl) detailEl.textContent = detail;
  }

  function renderOpsStrip() {
    var serviceOk = latestHealth && latestHealth.status === 'ok';
    var serviceState = latestHealth ? (serviceOk ? 'ok' : 'error') : 'loading';
    setOpsItem(
      els.opsService,
      els.opsServiceValue,
      els.opsServiceDetail,
      serviceState,
      latestHealth ? (serviceOk ? 'Online' : 'Degraded') : 'Checking...',
      latestHealth ? ('MongoDB ' + (latestHealth.db || 'unknown')) : 'Waiting for health response'
    );

    var docs = latestStatus ? Number(latestStatus.documentCount || 0) : null;
    var chunks = latestStatus ? Number(latestStatus.chunkCount || 0) : null;
    var corpusState = latestStatus ? (docs > 0 ? 'ok' : 'warn') : 'loading';
    setOpsItem(
      els.opsCorpus,
      els.opsCorpusValue,
      els.opsCorpusDetail,
      corpusState,
      latestStatus ? (formatNumber(docs) + ' docs') : 'Checking...',
      latestStatus ? (formatNumber(chunks) + ' chunks indexed') : 'Counting indexed documents and chunks'
    );

    var emb = latestStatus && latestStatus.dependencies ? latestStatus.dependencies.embedding : null;
    var embChecking = !!(emb && emb.checking === true);
    var embOk = !!(emb && emb.healthy === true);
    var embState = latestStatus ? (embChecking ? 'warn' : embOk ? 'ok' : 'error') : 'loading';
    setOpsItem(
      els.opsEmbedding,
      els.opsEmbeddingValue,
      els.opsEmbeddingDetail,
      embState,
      latestStatus ? (embOk ? (emb.model || latestStatus.embeddingModel || 'Ready') : embChecking ? 'Checking' : 'Blocked') : 'Checking...',
      latestStatus ? formatEmbeddingDetail(emb, latestStatus.embeddingModel || '') : 'Resolving provider and model'
    );

    var qdrantOk = !!(latestStatus && latestStatus.vectorStore && latestStatus.vectorStore.healthy);
    var queryState = 'loading';
    var queryValue = 'Checking...';
    var queryDetail = 'Search readiness depends on service, vector store, embeddings, and corpus';
    if (latestStatus || latestHealth) {
      if (!serviceOk) {
        queryState = 'error';
        queryValue = 'Blocked';
        queryDetail = 'Service health is degraded or unavailable.';
      } else if (!qdrantOk) {
        queryState = 'error';
        queryValue = 'Blocked';
        queryDetail = 'Vector store is unavailable.';
      } else if (!embOk) {
        queryState = embChecking ? 'warn' : 'error';
        queryValue = embChecking ? 'Checking' : 'Blocked';
        queryDetail = embChecking ? 'Embedding provider check is still running.' : 'Embedding provider is unavailable.';
      } else if (docs === 0) {
        queryState = 'warn';
        queryValue = 'Index empty';
        queryDetail = 'Search is healthy, but there are no documents to retrieve yet.';
      } else {
        queryState = 'ok';
        queryValue = 'Ready';
        queryDetail = 'Search can retrieve from the active corpus.';
      }
    }
    setOpsItem(els.opsQuery, els.opsQueryValue, els.opsQueryDetail, queryState, queryValue, queryDetail);
  }

  function renderDepRow(el, label, state, detail) {
    if (!el) return;
    var dotClass = normalizeState(state);
    var textClass = dotClass === 'ok'
      ? 'status-ok'
      : (dotClass === 'warn' ? 'status-warn' : 'status-error');
    el.innerHTML =
      '<td class="dep-name">' + escapeHtml(label) + '</td>' +
      '<td class="dep-status">' +
        '<span class="status-dot ' + dotClass + '"></span> ' +
        '<span class="' + textClass + '">' +
          escapeHtml(detail) +
        '</span>' +
      '</td>';
  }

  function formatEmbeddingDetail(embedding, fallbackModel) {
    if (!embedding) {
      return fallbackModel || 'not configured';
    }

    var provider = embedding.provider || 'unknown';
    var model = embedding.model || fallbackModel || 'unknown';
    var hosts = Array.isArray(embedding.hosts) ? embedding.hosts : [];
    var endpoint = embedding.endpoint || (hosts.length > 0 ? hosts[0] : '');
    var extraHosts = hosts.length > 1 ? ' (+' + (hosts.length - 1) + ' more)' : '';
    var detail = model;

    if (endpoint) {
      detail += ' via ' + endpoint + extraHosts;
    }

    if (provider) {
      detail += ' [' + provider + ']';
    }

    return detail;
  }

  function escapeHtml(str) {
    if (!str) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  // ── Main refresh ──────────────────────────────────────────

  async function refreshDashboard() {
    if (refreshInFlight) {
      return;
    }

    refreshInFlight = true;

    try {
      var healthPromise = window.RAG.getHealth()
        .then(function (health) {
          renderHealthSuccess(health);
        })
        .catch(function () {
          renderHealthFailure();
        });

      var statusPromise = window.RAG.getStatus()
        .then(function (status) {
          renderStatusSuccess(status.data);
        })
        .catch(function () {
          renderStatusFailure();
        });

      await Promise.allSettled([healthPromise, statusPromise]);

      if (els.lastUpdated) {
        els.lastUpdated.textContent = new Date().toLocaleTimeString();
      }
    } finally {
      refreshInFlight = false;
    }
  }

  function formatNumber(n) {
    if (n == null) return '--';
    return Number(n).toLocaleString();
  }

  // ── Init ──────────────────────────────────────────────────

  document.addEventListener('DOMContentLoaded', function () {
    cacheElements();
    refreshDashboard();
    setInterval(refreshDashboard, REFRESH_INTERVAL);
  });
})();
