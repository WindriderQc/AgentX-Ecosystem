/**
 * Setup Routes — First-run configuration wizard API
 * Lets new users configure Ollama host(s) and judge settings
 * via the /setup.html wizard page.
 */

const express = require('express');
const router = express.Router();
const logger = require('../config/logger');
const {
  saveConfigFile,
  readConfigFile,
  isConfigured,
  getConfiguredHosts
} = require('../src/helpers/ollamaHostConfig');
const {
  probeHostInventory,
  normalizeModelName,
  getExplicitGlobalJudgeSelection
} = require('../src/services/benchmark/judgeReadiness');
const { admitOllamaTargetResolved } = require('../src/helpers/ollamaTargetAdmission');
const { readBoundedJson } = require('../src/helpers/boundedJsonResponse');

function currentAdmissionTargets() {
  const savedHosts = readConfigFile()?.hosts;
  return [
    ...getConfiguredHosts(),
    ...(Array.isArray(savedHosts) ? savedHosts : [])
  ];
}

function admitTarget(raw) {
  return admitOllamaTargetResolved(raw, { configuredHosts: currentAdmissionTargets() });
}

function setupError(res, statusCode, code, error, { probe = false } = {}) {
  return res.status(statusCode).json({
    ...(probe ? { success: false } : {}),
    code,
    error
  });
}

async function fetchSetupInventory(cleanUrl, {
  fetchImpl = globalThis.fetch,
  readJson = readBoundedJson,
  timeoutMs = 8000,
  setTimer = setTimeout,
  clearTimer = clearTimeout
} = {}) {
  const controller = new AbortController();
  const timeoutId = setTimer(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(`${cleanUrl}/api/tags`, {
      signal: controller.signal,
      redirect: 'manual'
    });
    const payload = response.ok ? await readJson(response) : null;
    return { response, payload };
  } finally {
    // This deadline intentionally includes streamed body parsing, not only the
    // time until response headers arrive.
    clearTimer(timeoutId);
  }
}

/**
 * GET /api/setup/status
 * Returns whether the benchmark service is configured and the current config.
 */
router.get('/status', (req, res) => {
  const configured = isConfigured();
  const config = readConfigFile();
  const hosts = configured ? getConfiguredHosts() : [];
  const judge = getExplicitGlobalJudgeSelection({ config });
  res.json({
    configured,
    hosts,
    judge
  });
});

/**
 * POST /api/setup/test-host
 * Probe an Ollama host — returns available models with details.
 */
router.post('/test-host', async (req, res) => {
  const { url } = req.body || {};
  if (!url || typeof url !== 'string') {
    return setupError(res, 400, 'SETUP_URL_REQUIRED', 'URL is required', { probe: true });
  }

  let cleanUrl;
  try {
    cleanUrl = await admitTarget(url);
  } catch (err) {
    return setupError(
      res,
      err.statusCode || 400,
      err.code || 'OLLAMA_TARGET_REJECTED',
      err.message,
      { probe: true }
    );
  }

  try {
    const { response: resp, payload: data } = await fetchSetupInventory(cleanUrl);

    if (!resp.ok) {
      return setupError(
        res,
        200,
        'OLLAMA_PROBE_HTTP_ERROR',
        `Ollama returned HTTP ${resp.status}`,
        { probe: true }
      );
    }

    const models = (data.models || []).map(m => ({
      name: m.name,
      size: m.size || 0,
      parameterSize: m.details?.parameter_size || '',
      family: m.details?.family || '',
      quantization: m.details?.quantization_level || ''
    }));

    res.json({ success: true, url: cleanUrl, models });
  } catch (err) {
    const msg = err.name === 'AbortError'
      ? 'Connection timed out (8s). Check the IP and make sure Ollama is running.'
      : (err.code === 'ECONNREFUSED'
        ? 'Connection refused. Is Ollama running on that address?'
        : err.message || 'Connection failed');
    const code = err.name === 'AbortError'
      ? 'OLLAMA_PROBE_TIMEOUT'
      : (err.code === 'ECONNREFUSED'
        ? 'OLLAMA_CONNECTION_REFUSED'
        : (String(err.code || '').startsWith('OLLAMA_') ? err.code : 'OLLAMA_PROBE_FAILED'));
    return setupError(res, 200, code, msg, { probe: true });
  }
});

/**
 * POST /api/setup/save
 * Persist host + judge configuration to benchmark.config.json
 */
router.post('/save', async (req, res) => {
  const { hosts, judge } = req.body || {};

  if (!hosts || !Array.isArray(hosts) || hosts.length === 0) {
    return setupError(res, 400, 'SETUP_HOSTS_REQUIRED', 'At least one host is required');
  }

  const admittedHosts = [];
  for (const host of hosts) {
    if (!host.url || typeof host.url !== 'string') {
      return setupError(res, 400, 'SETUP_HOST_URL_REQUIRED', 'Each host needs a valid URL');
    }
    try {
      admittedHosts.push({ ...host, url: await admitTarget(host.url) });
    } catch (err) {
      return setupError(res, err.statusCode || 400, err.code || 'OLLAMA_TARGET_REJECTED', err.message);
    }
  }

  if (!judge?.host || !judge?.model) {
    return setupError(
      res,
      400,
      'SETUP_JUDGE_REQUIRED',
      'Choose a judge host and one already-installed judge model explicitly'
    );
  }

  let judgeHost;
  try {
    judgeHost = await admitTarget(judge.host);
  } catch (err) {
    return setupError(res, err.statusCode || 400, err.code || 'OLLAMA_TARGET_REJECTED', err.message);
  }
  const configuredHost = admittedHosts.find((host) => host.url === judgeHost);
  if (!configuredHost) {
    return setupError(
      res,
      400,
      'SETUP_JUDGE_HOST_NOT_CONFIGURED',
      'Judge host must be one of the configured hosts'
    );
  }

  const inventory = await probeHostInventory(judgeHost);
  const judgeModel = normalizeModelName(judge.model);
  if (!inventory.reachable) {
    return setupError(
      res,
      503,
      'SETUP_JUDGE_HOST_UNREACHABLE',
      `Judge host is not ready: ${inventory.error || 'host is unreachable'}`
    );
  }
  if (!inventory.models.some((model) => model.name === judgeModel)) {
    return setupError(
      res,
      422,
      'SETUP_JUDGE_MODEL_UNAVAILABLE',
      `Judge model ${judgeModel} is not installed on the selected host`
    );
  }

  const config = {
    hosts: admittedHosts.map((h, i) => ({
      name: h.name || `Host ${i + 1}`,
      url: h.url,
      vramMb: h.vramMb || 0
    })),
    judge: judge ? {
      model: judgeModel,
      host: judgeHost
    } : undefined
  };

  try {
    saveConfigFile(config);
    logger.info('Setup config saved', { hostCount: config.hosts.length, judgeModel: config.judge?.model });
    res.json({ success: true });
  } catch (err) {
    logger.error('Failed to save setup config', { error: err.message });
    return setupError(res, 500, 'SETUP_SAVE_FAILED', 'Failed to save configuration');
  }
});

router._internal = { fetchSetupInventory };

module.exports = router;
