'use strict';

const express = require('express');
const router = express.Router();
const modelProfileService = require('../../src/services/profiler/modelProfileService');
const modelPerformanceProfileService = require('../../src/services/profiler/modelPerformanceProfileService');
const { getConfiguredHosts } = require('../../src/helpers/ollamaHostConfig');
const { admitOllamaTargetResolved } = require('../../src/helpers/ollamaTargetAdmission');

function validateHostId(hostId, res) {
  if (/^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,127}$/.test(String(hostId || ''))) return true;
  res.status(400).json({ status: 'error', error: 'Invalid Host ID format' });
  return false;
}

router.get('/', async (req, res) => {
  try {
    const filter = {};
    if (req.query.stage) filter.stage = req.query.stage;
    res.json({ status: 'success', data: await modelProfileService.getAll(filter) });
  } catch (err) { res.status(500).json({ status: 'error', error: err.message }); }
});

router.get('/:name', async (req, res) => {
  try {
    const model = await modelProfileService.getByName(req.params.name);
    if (!model) return res.status(404).json({ status: 'error', error: 'Model not found' });
    res.json({ status: 'success', data: model });
  } catch (err) { res.status(500).json({ status: 'error', error: err.message }); }
});

router.get('/:name/config', async (req, res) => {
  try {
    const hostId = req.query.host;
    if (!hostId) return res.status(400).json({ status: 'error', error: 'host query param required' });
    if (!validateHostId(hostId, res)) return;
    const evidence = await modelPerformanceProfileService.getActiveProfile(req.params.name, hostId);
    if (!evidence) return res.status(404).json({ status: 'error', error: 'No exact-artifact profile evidence found' });
    res.json({
      status: 'success',
      data: {
        modelName: req.params.name,
        hostId,
        artifact: evidence.artifact,
        config: evidence.profile?.recommendedConfig || {
          num_ctx: evidence.profile?.optimalNumCtx || null
        }
      }
    });
  } catch (err) { res.status(500).json({ status: 'error', error: err.message }); }
});

router.put('/:name', async (req, res) => {
  try {
    const allowed = ['stage', 'hostId', 'sourceHost', 'readiness', 'profile', 'notes'];
    const update = { name: req.params.name };
    for (const key of allowed) {
      if (req.body[key] !== undefined) update[key] = req.body[key];
    }
    if (update.sourceHost) {
      update.sourceHost = await admitOllamaTargetResolved(update.sourceHost, {
        configuredHosts: getConfiguredHosts()
      });
    }
    res.json({ status: 'success', data: await modelProfileService.upsert(update) });
  } catch (err) { res.status(err.statusCode || 500).json({ status: 'error', error: err.message }); }
});

module.exports = router;
