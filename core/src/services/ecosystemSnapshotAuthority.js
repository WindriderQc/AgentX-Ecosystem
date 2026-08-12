'use strict';

function positiveInteger(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.round(n);
}

function parseYamlScalar(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  if ((raw.startsWith('"') && raw.endsWith('"')) || (raw.startsWith("'") && raw.endsWith("'"))) {
    return raw.slice(1, -1);
  }
  return raw;
}

function extractSimpleYamlBlock(yaml, blockName) {
  if (typeof yaml !== 'string' || !yaml.trim()) return null;
  const lines = yaml.split(/\r?\n/);
  const block = {};
  let inBlock = false;

  for (const line of lines) {
    if (!line.trim() || line.trimStart().startsWith('#')) continue;
    const top = line.match(/^([A-Za-z0-9_-]+):\s*$/);
    if (top) {
      if (inBlock) break;
      inBlock = top[1] === blockName;
      continue;
    }
    if (!inBlock) continue;
    const field = line.match(/^  ([A-Za-z0-9_-]+):\s*(.*)$/);
    if (field) block[field[1]] = parseYamlScalar(field[2]);
  }

  return Object.keys(block).length ? block : null;
}

function cleanBaseUrl(value) {
  return String(value || '').replace(/\/+$/, '');
}

function normalizeAuthorityModel(value) {
  return String(value || '').trim().toLowerCase();
}

function urlsMatch(left, right) {
  return cleanBaseUrl(left) === cleanBaseUrl(right);
}

function authorityMismatch(mismatches, surface, field, current, expected) {
  if (current === undefined || current === null || expected === undefined || expected === null) return;
  if (field === 'baseUrl' && urlsMatch(current, expected)) return;
  if (field === 'model' && normalizeAuthorityModel(current) === normalizeAuthorityModel(expected)) return;
  if (field === 'context' && positiveInteger(current) === positiveInteger(expected)) return;
  if (!['baseUrl', 'model', 'context'].includes(field) && current === expected) return;
  mismatches.push({ surface, field, current, expected });
}

function summarizeHermesConfig(raw) {
  const config = raw?.rawConfig || raw?.config || raw?.resolvedConfig || raw || {};
  const yamlModel = extractSimpleYamlBlock(raw?.yaml || config?.yaml, 'model');
  const model = yamlModel || config.model || config.models?.default || config.models?.current || {};
  const modelObject = typeof model === 'string' ? {} : model;
  return {
    available: Boolean(raw),
    status: raw ? 'checked' : 'missing',
    model: {
      default: modelObject.default || modelObject.model || modelObject.name || (typeof model === 'string' ? model : null),
      provider: modelObject.provider || config.provider || null,
      baseUrl: modelObject.base_url || modelObject.baseURL || modelObject.baseUrl || modelObject.url || config.base_url || null,
      contextLength: positiveInteger(
        modelObject.context_length ||
        modelObject.contextLength ||
        config.model_context_length ||
        config.context_length
      ),
      ollamaNumCtx: positiveInteger(modelObject.ollama_num_ctx || modelObject.num_ctx || config.ollama_num_ctx),
      apiKeyConfigured: Boolean(modelObject.api_key || modelObject.apiKey || config.api_key)
    }
  };
}

function classifyHermesAuthority(expectedHermes, registryPolicy, liveStatus) {
  const expected = expectedHermes || {};
  const expectedConfig = expected.defaultModelConfig || {};
  const authority = expected.authority || {};
  const expectedBaseUrl = authority.expectedBaseUrl || expected.proxyBaseUrl || expectedConfig.base_url || null;
  const expectedModel = authority.expectedModel || expectedConfig.default || null;
  const expectedContext = positiveInteger(authority.expectedContext || expectedConfig.context_length);
  const registryBaseUrl = registryPolicy?.baseUrl || registryPolicy?.base_url || null;
  const registryModel = registryPolicy?.primaryModel || registryPolicy?.primary_model || null;
  const registryContext = positiveInteger(registryPolicy?.context);
  const liveConfig = liveStatus?.liveConfig || {};
  const liveModel = liveConfig.model || {};
  const mismatches = [];

  authorityMismatch(mismatches, 'registry', 'baseUrl', registryBaseUrl, expectedBaseUrl);
  authorityMismatch(mismatches, 'registry', 'model', registryModel, expectedModel);
  authorityMismatch(mismatches, 'registry', 'context', registryContext, expectedContext);

  if (liveConfig.available) {
    authorityMismatch(mismatches, 'liveConfig', 'baseUrl', liveModel.baseUrl, expectedBaseUrl);
    authorityMismatch(mismatches, 'liveConfig', 'model', liveModel.default, expectedModel);
    authorityMismatch(mismatches, 'liveConfig', 'context', liveModel.contextLength, expectedContext);
  } else if (liveStatus?.configured !== false) {
    mismatches.push({
      surface: 'liveConfig',
      field: 'access',
      current: liveConfig.status || 'not_checked',
      expected: 'validated_or_documented_override'
    });
  }

  const overrideStatus = registryPolicy?.authorityPolicy?.status || registryPolicy?.authority_policy?.status;
  const status = overrideStatus === 'intentional_override'
    ? 'intentional_override'
    : (mismatches.length ? 'drifted' : 'aligned');

  return {
    policy: authority.policy || registryPolicy?.authorityPolicy?.policy || registryPolicy?.authority_policy?.policy || 'agentx_proxy',
    status,
    decisionDate: authority.decisionDate || registryPolicy?.authorityPolicy?.decisionDate || registryPolicy?.authority_policy?.decision_date || null,
    expected: {
      baseUrl: expectedBaseUrl,
      model: expectedModel,
      context: expectedContext
    },
    registry: {
      baseUrl: registryBaseUrl,
      model: registryModel,
      context: registryContext
    },
    live: {
      dashboardReachable: liveStatus?.configured !== false,
      gatewayRunning: liveStatus?.gateway?.running ?? null,
      configValidation: liveConfig.available ? 'checked' : (liveConfig.status || 'not_checked')
    },
    mutation: authority.liveConfigValidation || 'human_gated',
    directRuntimeBypass: authority.directRuntimeBypass || 'pending_drift_until_classified',
    mismatches
  };
}

module.exports = {
  classifyHermesAuthority,
  summarizeHermesConfig,
  extractSimpleYamlBlock
};
