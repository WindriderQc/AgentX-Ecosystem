'use strict';

const express = require('express');
const logger = require('../config/logger');
const { buildNestorFastlaneConfig } = require('../src/services/nestorFastlaneConfigService');

const router = express.Router();

router.get('/', async (_req, res) => {
  try {
    const data = await buildNestorFastlaneConfig();
    res.json({ status: 'success', data });
  } catch (err) {
    logger.error('[NerveCenter] fastlane config fetch failed', { error: err.message });
    res.status(500).json({ status: 'error', message: err.message });
  }
});

module.exports = router;
