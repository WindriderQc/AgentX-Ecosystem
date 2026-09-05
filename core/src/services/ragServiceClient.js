const { normalizeHostUrl } = require('../helpers/ollamaHostConfig');
const {
  CrossServiceClientError,
  requestJson: coreRequestJson
} = require('../helpers/crossServiceClient');

const DEFAULT_RAG_SERVICE_URL = 'http://localhost:3082';

class RagServiceClientError extends CrossServiceClientError {
  constructor(message, { status = 500, code = 'RAG_SERVICE_ERROR', body = null, cause = null } = {}) {
    super(message, { service: 'rag', status, code, body, cause });
    this.name = 'RagServiceClientError';
  }
}

function getRagServiceBaseUrl() {
  const configured = process.env.RAG_SERVICE_URL || DEFAULT_RAG_SERVICE_URL;
  return normalizeHostUrl(configured) || DEFAULT_RAG_SERVICE_URL;
}

async function callRagService(method, pathname, { query, body, timeoutMs } = {}) {
  const operatorToken = String(process.env.AGENTX_OPERATOR_TOKEN || '').trim();
  return coreRequestJson({
    baseUrl: getRagServiceBaseUrl(),
    path: pathname,
    method,
    query,
    body,
    headers: operatorToken ? { 'X-AgentX-Operator-Token': operatorToken } : {},
    timeoutMs,
    serviceName: 'RAG',
    errorCode: 'RAG_SERVICE_ERROR',
    ErrorClass: RagServiceClientError
  });
}

class RagServiceClient {
  async getStatus() {
    const payload = await callRagService('GET', '/api/rag/status');
    return payload?.data || payload;
  }

  async refreshStatus() {
    const payload = await callRagService('POST', '/api/rag/status/refresh');
    return payload?.data || payload;
  }

  async searchSimilarChunks(query, options = {}) {
    const payload = await callRagService('POST', '/api/rag/search', {
      body: {
        query,
        topK: options.topK,
        minScore: options.minScore,
        filters: options.filters,
        expand: options.expand || undefined,
        hybrid: options.hybrid || undefined,
        rerank: options.rerank || undefined,
        compress: options.compress || undefined
      }
    });
    const data = payload?.data || payload;
    return Array.isArray(data?.results) ? data.results : [];
  }

  async listDocuments(filters = {}) {
    const payload = await callRagService('GET', '/api/rag/documents', { query: filters });
    return payload?.data || payload;
  }

  async upsertDocumentWithChunks(text, metadata = {}) {
    const payload = await callRagService('POST', '/api/rag/documents', {
      timeoutMs: metadata.timeoutMs,
      body: {
        text,
        source: metadata.source,
        tags: metadata.tags,
        chunkSize: metadata.chunkSize,
        chunkOverlap: metadata.chunkOverlap,
        documentId: metadata.documentId
      }
    });
    return payload?.data || payload;
  }

  async deleteDocument(documentId) {
    const payload = await callRagService('DELETE', `/api/rag/documents/${encodeURIComponent(documentId)}`, {
      body: { confirmation: `DELETE ${documentId}` }
    });
    return payload?.data || payload;
  }

  async getDocument(documentId) {
    const payload = await callRagService('GET', `/api/rag/documents/${encodeURIComponent(documentId)}`);
    return payload?.data || payload;
  }

  async getDocumentChunks(documentId) {
    const payload = await callRagService('GET', `/api/rag/documents/${encodeURIComponent(documentId)}/chunks`);
    return payload?.data || payload;
  }
}

let client = null;
function getRagServiceClient() {
  if (!client) client = new RagServiceClient();
  return client;
}

module.exports = {
  RagServiceClient,
  RagServiceClientError,
  getRagServiceBaseUrl,
  getRagServiceClient
};
