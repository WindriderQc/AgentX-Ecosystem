/**
 * Ollama Watchdog Routes
 *
 * Exposes the inference jam watchdog status and manual controls.
 *   GET  /            — watchdog stats + history
 *   POST /probe       — trigger an immediate probe cycle
 *   POST /unjam       — force-unjam a specific host (body: { host })
 *   POST /unjam-all   — force-unjam all hosts
 */
const express = require('express');
const router = express.Router();
const watchdog = require('../src/services/ollamaWatchdogService');
const { getConfiguredHosts } = require('../src/helpers/ollamaHostConfig');

// GET / — current stats and event history
router.get('/', (_req, res) => {
  res.json(watchdog.getStats());
});

// POST /probe — trigger immediate probe cycle
router.post('/probe', async (_req, res) => {
  try {
    const stats = await watchdog.runNow();
    res.json({ message: 'Probe cycle completed', stats });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /unjam — force-unjam a specific host
router.post('/unjam', async (req, res) => {
  const { host } = req.body || {};
  if (!host) {
    return res.status(400).json({ error: 'host is required (id, name, or url)' });
  }
  try {
    const result = await watchdog.forceUnjam(host);
    res.json({ message: 'Unjam completed', ...result });
  } catch (err) {
    res.status(err.message.includes('not found') ? 404 : 500).json({ error: err.message });
  }
});

// POST /unjam-all — force-unjam all configured hosts
router.post('/unjam-all', async (_req, res) => {
  const hosts = getConfiguredHosts();
  const results = [];
  for (const host of hosts) {
    try {
      const result = await watchdog.forceUnjam(host.id);
      results.push({ host: host.name, ...result });
    } catch (err) {
      results.push({ host: host.name, error: err.message });
    }
  }
  res.json({ message: 'Unjam-all completed', results });
});

module.exports = router;
