/**
 * Setup Routes — First-run configuration wizard API
 * Lets new users configure Ollama host(s) and judge settings
 * via the /setup.html wizard page.
 */

const express = require('express');
const router = express.Router();
const logger = require('../config/logger');
const { saveConfigFile, readConfigFile, isConfigured } = require('../src/helpers/ollamaHostConfig');

/**
 * GET /api/setup/status
 * Returns whether the benchmark service is configured and the current config.
 */
router.get('/status', (req, res) => {
  const configured = isConfigured();
  const config = configured ? readConfigFile() : null;
  res.json({
    configured,
    hosts: config?.hosts || [],
    judge: config?.judge || null
  });
});

/**
 * POST /api/setup/test-host
 * Probe an Ollama host — returns available models with details.
 */
router.post('/test-host', async (req, res) => {
  const { url } = req.body;
  if (!url || typeof url !== 'string') {
    return res.status(400).json({ success: false, error: 'URL is required' });
  }

  let cleanUrl = url.trim();
  if (!/^https?:\/\//.test(cleanUrl)) cleanUrl = 'http://' + cleanUrl;
  cleanUrl = cleanUrl.replace(/\/+$/, '');

  try {
    const ctrl = new AbortController();
    const timeout = setTimeout(() => ctrl.abort(), 8000);

    const resp = await fetch(`${cleanUrl}/api/tags`, { signal: ctrl.signal });
    clearTimeout(timeout);

    if (!resp.ok) {
      return res.json({ success: false, error: `Ollama returned HTTP ${resp.status}` });
    }

    const data = await resp.json();
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
    res.json({ success: false, error: msg });
  }
});

/**
 * POST /api/setup/save
 * Persist host + judge configuration to benchmark.config.json
 */
router.post('/save', (req, res) => {
  const { hosts, judge } = req.body;

  if (!hosts || !Array.isArray(hosts) || hosts.length === 0) {
    return res.status(400).json({ error: 'At least one host is required' });
  }

  for (const host of hosts) {
    if (!host.url || typeof host.url !== 'string') {
      return res.status(400).json({ error: 'Each host needs a valid URL' });
    }
  }

  const config = {
    hosts: hosts.map((h, i) => ({
      name: h.name || `Host ${i + 1}`,
      url: h.url.trim().replace(/\/+$/, ''),
      vramMb: h.vramMb || 0
    })),
    judge: judge ? {
      model: judge.model || '',
      host: judge.host || hosts[0].url.trim().replace(/\/+$/, '')
    } : undefined
  };

  try {
    saveConfigFile(config);
    logger.info('Setup config saved', { hostCount: config.hosts.length, judgeModel: config.judge?.model });
    res.json({ success: true });
  } catch (err) {
    logger.error('Failed to save setup config', { error: err.message });
    res.status(500).json({ error: 'Failed to save configuration' });
  }
});

module.exports = router;
