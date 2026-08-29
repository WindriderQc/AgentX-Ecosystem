const express = require('express');
const router = express.Router();
const BenchmarkTemplate = require('../../models/BenchmarkTemplate');
const BenchmarkBatch = require('../../models/BenchmarkBatch');
const { validateObjectId } = require('../../src/helpers/objectIdValidator');
const { requireExactConfirmation } = require('../../src/helpers/exactConfirmation');
const logger = require('../../config/logger');

const CONFIG_FIELDS = ['host', 'models', 'levels', 'prompt_ids', 'judge_config', 'execution_config', 'execution_mode', 'depth_config'];

/**
 * GET /api/benchmark/templates
 */
router.get('/templates', async (_req, res) => {
    try {
        const templates = await BenchmarkTemplate.find()
            .sort({ updatedAt: -1 })
            .lean();
        res.json({ status: 'success', data: templates });
    } catch (err) {
        logger.error('Failed to list templates', { error: err.message });
        res.status(500).json({ status: 'error', error: err.message });
    }
});

/**
 * POST /api/benchmark/templates
 * Create a template from scratch or from a batch
 */
router.post('/templates', async (req, res) => {
    try {
        const { name, description, config, tags, source_batch_id } = req.body;
        if (!name || typeof name !== 'string' || name.length > 200) {
            return res.status(400).json({ status: 'error', error: 'name is required (max 200 chars)' });
        }

        let templateConfig = {};

        if (source_batch_id) {
            if (!validateObjectId(source_batch_id, res, 'source_batch_id')) return;
            const batch = await BenchmarkBatch.findById(source_batch_id).lean();
            if (!batch) return res.status(404).json({ status: 'error', error: 'Source batch not found' });
            for (const field of CONFIG_FIELDS) {
                if (batch[field] !== undefined) templateConfig[field] = batch[field];
            }
        }

        // Explicit config overrides batch-derived values
        if (config && typeof config === 'object') {
            for (const field of CONFIG_FIELDS) {
                if (config[field] !== undefined) templateConfig[field] = config[field];
            }
        }

        const template = await BenchmarkTemplate.create({
            name: name.trim(),
            description: (description || '').slice(0, 2000),
            config: templateConfig,
            tags: Array.isArray(tags) ? tags.slice(0, 20).map(t => String(t).slice(0, 50)) : [],
            source_batch_id: source_batch_id || null
        });

        res.status(201).json({ status: 'success', data: template });
    } catch (err) {
        logger.error('Failed to create template', { error: err.message });
        res.status(500).json({ status: 'error', error: err.message });
    }
});

/**
 * GET /api/benchmark/templates/:id
 */
router.get('/templates/:id', async (req, res) => {
    try {
        if (!validateObjectId(req.params.id, res, 'Template ID')) return;
        const template = await BenchmarkTemplate.findById(req.params.id).lean();
        if (!template) return res.status(404).json({ status: 'error', error: 'Template not found' });
        res.json({ status: 'success', data: template });
    } catch (err) {
        logger.error('Failed to get template', { error: err.message });
        res.status(500).json({ status: 'error', error: err.message });
    }
});

/**
 * PUT /api/benchmark/templates/:id
 */
router.put('/templates/:id', async (req, res) => {
    try {
        if (!validateObjectId(req.params.id, res, 'Template ID')) return;
        const { name, description, config, tags } = req.body;

        const update = {};
        if (name !== undefined) {
            if (typeof name !== 'string' || name.length > 200) {
                return res.status(400).json({ status: 'error', error: 'name max 200 chars' });
            }
            update.name = name.trim();
        }
        if (description !== undefined) update.description = String(description).slice(0, 2000);
        if (config && typeof config === 'object') {
            const sanitized = {};
            for (const field of CONFIG_FIELDS) {
                if (config[field] !== undefined) sanitized[field] = config[field];
            }
            update.config = sanitized;
        }
        if (Array.isArray(tags)) update.tags = tags.slice(0, 20).map(t => String(t).slice(0, 50));

        const template = await BenchmarkTemplate.findByIdAndUpdate(req.params.id, { $set: update }, { new: true });
        if (!template) return res.status(404).json({ status: 'error', error: 'Template not found' });
        res.json({ status: 'success', data: template });
    } catch (err) {
        logger.error('Failed to update template', { error: err.message });
        res.status(500).json({ status: 'error', error: err.message });
    }
});

/**
 * DELETE /api/benchmark/templates/:id
 */
router.delete('/templates/:id', async (req, res) => {
    try {
        if (!validateObjectId(req.params.id, res, 'Template ID')) return;
        const expectedConfirmation = `DELETE TEMPLATE ${req.params.id}`;
        if (!requireExactConfirmation(req, res, expectedConfirmation)) return;

        const template = await BenchmarkTemplate.findByIdAndDelete(req.params.id);
        if (!template) return res.status(404).json({ status: 'error', error: 'Template not found' });
        res.json({ status: 'success', message: 'Template deleted' });
    } catch (err) {
        logger.error('Failed to delete template', { error: err.message });
        res.status(500).json({ status: 'error', error: err.message });
    }
});

/**
 * POST /api/benchmark/templates/:id/use
 * Increment run_count when a template is used to launch a batch
 */
router.post('/templates/:id/use', async (req, res) => {
    try {
        if (!validateObjectId(req.params.id, res, 'Template ID')) return;
        const template = await BenchmarkTemplate.findByIdAndUpdate(
            req.params.id,
            { $inc: { run_count: 1 } },
            { new: true }
        );
        if (!template) return res.status(404).json({ status: 'error', error: 'Template not found' });
        res.json({ status: 'success', data: template.config });
    } catch (err) {
        logger.error('Failed to record template use', { error: err.message });
        res.status(500).json({ status: 'error', error: err.message });
    }
});

module.exports = router;
