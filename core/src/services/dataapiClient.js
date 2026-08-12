const {
  CrossServiceClientError,
  requestJson: coreRequestJson
} = require('../helpers/crossServiceClient');

class DataApiError extends CrossServiceClientError {
  constructor(message, { status, body, code = 'DATAAPI_ERROR', cause = null } = {}) {
    super(message, { service: 'dataapi', status, body, code, cause });
    this.name = 'DataApiError';
  }
}

function getBaseUrl() {
  const raw = process.env.DATAAPI_BASE_URL || '';
  if (!raw) return 'http://localhost:3083';
  return raw.replace(/\/+$/, '');
}

function getApiKey() {
  return process.env.DATAAPI_API_KEY || null;
}

async function callDataApi(method, pathname, { query, body, timeoutMs = 30000 } = {}) {
  const apiKey = getApiKey();
  if (!apiKey) {
    throw new DataApiError('DATAAPI_API_KEY is not configured');
  }

  return coreRequestJson({
    baseUrl: getBaseUrl(),
    path: pathname,
    method,
    query,
    body,
    timeoutMs,
    serviceName: 'DataAPI',
    errorCode: 'DATAAPI_ERROR',
    ErrorClass: DataApiError,
    headers: { 'x-api-key': apiKey }
  });
}

const dataapi = {
  files: {
    search: async ({ q, limit = 50, skip = 0 } = {}) => {
      return callDataApi('GET', '/api/v1/storage/files/browse', { query: { q, limit, skip } });
    },
    duplicates: async () => {
      return callDataApi('GET', '/api/v1/storage/files/duplicates');
    },
    stats: async () => {
      return callDataApi('GET', '/api/v1/storage/files/stats');
    },
    tree: async ({ root = '/' } = {}) => {
      return callDataApi('GET', '/api/v1/storage/files/tree', { query: { root } });
    },
    cleanupRecommendations: async () => {
      return callDataApi('GET', '/api/v1/storage/files/cleanup-recommendations');
    },
    export: async ({ type = 'summary', format = 'json' } = {}) => {
      return callDataApi('POST', '/api/v1/exports/generate', { body: { type, format } });
    },
    exportsList: async () => {
      return callDataApi('GET', '/api/v1/exports');
    }
  },
  storage: {
    scanStart: async ({ roots, extensions, batch_size } = {}) => {
      return callDataApi('POST', '/api/v1/storage/scan', { body: { roots, extensions, batch_size }, timeoutMs: 60000 });
    },
    scanStatus: async ({ scan_id } = {}) => {
      return callDataApi('GET', `/api/v1/storage/status/${encodeURIComponent(scan_id)}`);
    },
    scansList: async ({ limit = 10, skip = 0 } = {}) => {
      return callDataApi('GET', '/api/v1/storage/scans', { query: { limit, skip } });
    },
    scanStop: async ({ scan_id } = {}) => {
      return callDataApi('POST', `/api/v1/storage/stop/${encodeURIComponent(scan_id)}`);
    }
  },
  live: {
    iss: async () => callDataApi('GET', '/api/v1/livedata/iss'),
    quakes: async () => callDataApi('GET', '/api/v1/livedata/quakes'),
    pressure: async () => callDataApi('GET', '/api/v1/livedata/pressure'),
    weather: async () => callDataApi('GET', '/api/v1/livedata/weather')
  }
};

module.exports = {
  dataapi,
  DataApiError
};
