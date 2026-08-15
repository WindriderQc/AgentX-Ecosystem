/**
 * Ollama VRAM Routes
 * Returns explicitly configured VRAM totals for Ollama endpoints.
 * The product never probes operating systems or SSH identities.
 */

const express = require('express');
const router = express.Router();
const logger = require('../config/logger');
const ollamaVramService = require('../src/services/ollamaVramService');
const HostPreference = require('../models/HostPreference');
const { getConfiguredHosts } = require('../src/helpers/ollamaHostConfig');

/**
 * GET /api/ollama-vram
 * Returns VRAM usage per configured Ollama host (includes _source and actionRequired fields).
 */
router.get('/', async (req, res) => {
  try {
    const configuredHosts = getConfiguredHosts();
    const hosts = await ollamaVramService.getVramForHosts(configuredHosts);

    res.json({
      status: 'success',
      data: {
        hosts,
        total: hosts.length,
        ok: hosts.filter(h => h.ok).length
      }
    });
  } catch (err) {
    logger.error('Failed to fetch Ollama VRAM metrics', { error: err.message });
    res.status(500).json({
      status: 'error',
      message: 'Failed to fetch VRAM metrics',
      error: err.message
    });
  }
});

/**
 * POST /api/ollama-vram/override
 * Set a manual VRAM override for a host via HostPreference.vramTotalMiB.
 * Body: { hostUrl: string, vramMiB: number }
 */
router.post('/override', async (req, res) => {
  try {
    const { hostUrl, hostIp, vramMiB } = req.body || {};
    const target = (hostUrl || hostIp || '').trim();
    if (!target) {
      return res.status(400).json({ status: 'error', message: 'hostUrl is required' });
    }
    const vram = Number.parseInt(vramMiB, 10);
    if (!Number.isFinite(vram) || vram <= 0) {
      return res.status(400).json({ status: 'error', message: 'vramMiB must be a positive integer' });
    }

    const doc = await HostPreference.findOneAndUpdate(
      { hostUrl: target },
      { $set: { vramTotalMiB: vram } },
      { new: true }
    );

    if (!doc) {
      return res.status(404).json({ status: 'error', message: `No HostPreference found for ${target}` });
    }

    // Invalidate VRAM cache for this host so next sync picks up the override
    const hostKey = target.replace(/^https?:\/\//, '').split(':')[0].toLowerCase();
    ollamaVramService.cache.delete(hostKey);

    logger.info('VRAM override set via UI', { hostUrl: target, vramMiB: vram });

    res.json({ status: 'success', data: { hostUrl: doc.hostUrl, vramTotalMiB: doc.vramTotalMiB } });
  } catch (err) {
    logger.error('Failed to set VRAM override', { error: err.message });
    res.status(500).json({ status: 'error', message: err.message });
  }
});

/**
 * DELETE /api/ollama-vram/override/:hostIp
 * Clear a manual VRAM override for a host (reset vramTotalMiB to 0).
 */
router.delete('/override/:hostIp', async (req, res) => {
  try {
    const target = (req.params.hostIp || '').trim();
    if (!target) {
      return res.status(400).json({ status: 'error', message: 'hostIp is required' });
    }

    const doc = await HostPreference.findOneAndUpdate(
      { hostUrl: { $regex: target, $options: 'i' } },
      { $set: { vramTotalMiB: 0 } },
      { new: true }
    );

    // Invalidate cache
    const hostKey = target.replace(/^https?:\/\//, '').split(':')[0].toLowerCase();
    ollamaVramService.cache.delete(hostKey);

    logger.info('VRAM override cleared', { hostIp: target, found: !!doc });

    res.json({ status: 'success', deleted: !!doc });
  } catch (err) {
    logger.error('Failed to clear VRAM override', { error: err.message });
    res.status(500).json({ status: 'error', message: err.message });
  }
});

module.exports = router;
