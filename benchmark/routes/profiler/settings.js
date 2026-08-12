const express = require('express');
const router = express.Router();
const logger = require('../../config/logger');
const settingsService = require('../../src/services/profiler/settingsService');

router.get('/', async (req, res) => {
  try {
    const settings = await settingsService.getAll();
    res.json({ status: 'success', data: settings });
  } catch (err) {
    logger.error('Failed to get profiler settings', { error: err.message });
    res.status(500).json({ status: 'error', error: err.message });
  }
});

router.put('/', async (req, res) => {
  try {
    const updated = await settingsService.save(req.body);
    res.json({ status: 'success', data: updated });
  } catch (err) {
    logger.error('Failed to save profiler settings', { error: err.message });
    res.status(500).json({ status: 'error', error: err.message });
  }
});

module.exports = router;
