'use strict';

const express = require('express');
const router = express.Router();
const performanceProfiles = require('../../src/services/profiler/modelPerformanceProfileService');

router.get('/roster', async (req, res) => {
  try {
    const data = await performanceProfiles.getRoster({
      hostId: req.query.hostId || undefined,
      modelName: req.query.modelName || undefined
    });
    res.json({ status: 'success', data });
  } catch (err) {
    res.status(500).json({ status: 'error', error: err.message });
  }
});

router.get('/:modelName/:hostId', async (req, res) => {
  try {
    const data = await performanceProfiles.getActiveProfile(req.params.modelName, req.params.hostId);
    if (!data) return res.status(404).json({ status: 'error', error: 'Profile evidence not found' });
    res.json({ status: 'success', data });
  } catch (err) {
    res.status(500).json({ status: 'error', error: err.message });
  }
});

module.exports = router;
