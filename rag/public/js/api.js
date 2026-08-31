/**
 * RAG API Helper — shared fetch wrapper and endpoint functions.
 * Exposes window.RAG namespace for use by page scripts.
 */

(function () {
  'use strict';

  var API_BASE = '/api/rag';

  /**
   * Fetch wrapper that auto-parses JSON and checks the envelope.
   * @param {string} path - Relative path (appended to API_BASE unless absolute).
   * @param {RequestInit} [options] - Standard fetch options.
   * @returns {Promise<object>} Parsed JSON body.
   */
  async function apiFetch(path, options) {
    var url = path.startsWith('/') ? path : API_BASE + '/' + path;
    var requestOptions = Object.assign({ cache: 'no-store' }, options || {});
    var res = await fetch(url, requestOptions);
    var body = await res.json();
    if (body.ok === false) {
      var err = new Error(body.error || 'Request failed');
      err.detail = body.detail;
      err.confirmation = body.confirmation;
      err.status = res.status;
      throw err;
    }
    return body;
  }

  /**
   * GET /api/rag/status — read the latest dependency evidence without mutation.
   * Dashboard polling must stay observational so it works through the public
   * read-only surface without weakening the mutation guard.
   */
  async function getStatus() {
    return apiFetch('/api/rag/status');
  }

  /**
   * POST /api/rag/status/refresh — actively refresh dependency health.
   * Reserved for authenticated operator workflows.
   */
  async function refreshStatus() {
    return apiFetch('/api/rag/status/refresh', { method: 'POST' });
  }

  /**
   * GET /health — basic liveness check.
   */
  async function getHealth() {
    return apiFetch('/health');
  }

  /**
   * GET /api/rag/documents — list documents with optional filters.
   * @param {object} [filters] - { source, tags (comma-separated string) }
   * @returns {Promise<object>} { ok, data: { documents, total, limit, offset } }
   */
  async function getDocuments(filters) {
    var params = [];
    if (filters) {
      if (filters.source) params.push('source=' + encodeURIComponent(filters.source));
      if (filters.tags) params.push('tags=' + encodeURIComponent(filters.tags));
      if (filters.limit) params.push('limit=' + encodeURIComponent(filters.limit));
      if (filters.offset) params.push('offset=' + encodeURIComponent(filters.offset));
    }
    var qs = params.length ? '?' + params.join('&') : '';
    return apiFetch('/api/rag/documents' + qs);
  }

  /**
   * GET /api/rag/documents/:id — get document metadata.
   */
  async function getDocument(id) {
    return apiFetch('/api/rag/documents/' + encodeURIComponent(id));
  }

  /**
   * GET /api/rag/documents/:id/chunks — get all chunks for a document.
   */
  async function getDocumentChunks(id) {
    return apiFetch('/api/rag/documents/' + encodeURIComponent(id) + '/chunks');
  }

  /**
   * DELETE /api/rag/documents/:id — delete a document.
   * @param {string} id - Full opaque document identifier.
   * @param {string} confirmation - Exact `DELETE <id>` typed confirmation.
   */
  async function deleteDocument(id, confirmation) {
    return apiFetch('/api/rag/documents/' + encodeURIComponent(id), {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ confirmation: confirmation })
    });
  }

  /**
   * POST /api/rag/search — semantic search.
   * @param {string} query
   * @param {number} [topK=5]
   * @param {number} [minScore=0]
   * @param {object} [filters] - { source, tags }
   * @param {object} [options] - advanced retrieval toggles
   *   { expand, hybrid, rerank, compress } — each a boolean. Only `true`
   *   values are sent; omitting `options` preserves the default (all off).
   */
  async function search(query, topK, minScore, filters, options) {
    var body = { query: query };
    if (topK !== undefined) body.topK = topK;
    if (minScore !== undefined) body.minScore = minScore;
    if (filters) body.filters = filters;
    if (options) {
      if (options.expand === true) body.expand = true;
      if (options.hybrid === true) body.hybrid = true;
      if (options.rerank === true) body.rerank = true;
      if (options.compress === true) body.compress = true;
    }
    return apiFetch('/api/rag/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
  }

  /**
   * POST /api/rag/ingest — ingest a document.
   * @param {object} params - { text, source?, tags?, chunkSize?, chunkOverlap?, documentId? }
   * @returns {Promise<object>} { ok, data: { documentId, chunkCount, status } }
   */
  async function ingestDocument(params) {
    return apiFetch('/api/rag/ingest', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(params)
    });
  }

  /**
   * GET /api/rag/manifests/latest — latest manifest for a source.
   * @param {string} [source] - Source filter (optional).
   */
  async function getLatestManifest(source) {
    var qs = source ? '?source=' + encodeURIComponent(source) : '';
    return apiFetch('/api/rag/manifests/latest' + qs);
  }

  /**
   * GET /api/rag/deletion-preview — compare manifest vs indexed docs.
   * @param {string} [source] - Source filter (optional).
   */
  async function getDeletionPreview(source) {
    var qs = source ? '?source=' + encodeURIComponent(source) : '';
    return apiFetch('/api/rag/deletion-preview' + qs);
  }

  /**
   * POST /api/rag/cleanup — delete stale documents.
   * @param {string} source
   * @param {boolean} [dryRun=false]
   * @param {string} [confirmation] - Exact source-bound phrase for destructive runs.
   */
  async function runCleanup(source, dryRun, confirmation) {
    var body = { source: source, dryRun: dryRun !== undefined ? dryRun : false };
    if (confirmation !== undefined) body.confirmation = confirmation;
    return apiFetch('/api/rag/cleanup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
  }

  /**
   * POST /api/rag/embedding-migration/reindex — trigger embedding reindex.
   */
  async function triggerReindex(confirmation) {
    return apiFetch('/api/rag/embedding-migration/reindex', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ confirmation: confirmation })
    });
  }

  window.RAG = {
    API_BASE: API_BASE,
    apiFetch: apiFetch,
    getStatus: getStatus,
    refreshStatus: refreshStatus,
    getHealth: getHealth,
    getDocuments: getDocuments,
    getDocument: getDocument,
    getDocumentChunks: getDocumentChunks,
    deleteDocument: deleteDocument,
    search: search,
    ingestDocument: ingestDocument,
    getLatestManifest: getLatestManifest,
    getDeletionPreview: getDeletionPreview,
    runCleanup: runCleanup,
    triggerReindex: triggerReindex
  };
})();
