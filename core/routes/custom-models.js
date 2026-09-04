const express = require('express');
const router = express.Router();
const customModelService = require('../src/services/customModelService');
const CustomModel = require('../models/CustomModel');
const logger = require('../config/logger');
const { validateHostUrl } = require('../src/helpers/ollamaHostConfig');
const { requireTypedConfirmation } = require('../src/helpers/typedConfirmation');

/**
 * GET /api/custom-models
 * List all custom models with optional filters */
router.get('/', async (req, res) => {
  try {
    const { status, baseModel, tag } = req.query;

    const filters = {};
    if (status) filters.status = status;
    if (baseModel) filters.baseModel = baseModel;
    if (tag) filters.tag = tag;

    const models = await customModelService.listModels(filters);

    res.json({
      success: true,
      count: models.length,
      models
    });
  } catch (error) {
    logger.error('Failed to list custom models', { error: error.message });
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * GET /api/custom-models/:id
 * Get model details by modelId */
router.get('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const query = { modelId: id };

    const model = await CustomModel.findOne(query);

    if (!model) {
      return res.status(404).json({
        success: false,
        error: 'Model not found'
      });
    }

    res.json({
      success: true,
      model
    });
  } catch (error) {
    logger.error('Failed to get model', { error: error.message });
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * POST /api/custom-models
 * Register a new custom model */
router.post('/', async (req, res) => {
  try {
    const modelData = req.body;

    // Validate required fields
    if (!modelData.modelId || !modelData.baseModel || !modelData.displayName) {
      return res.status(400).json({
        success: false,
        error: 'Missing required fields: modelId, baseModel, displayName'
      });
    }

    const model = await customModelService.registerModel(modelData);

    res.status(201).json({
      success: true,
      model
    });
  } catch (error) {
    logger.error('Failed to register model', { error: error.message });

    if (error.code === 11000) {
      return res.status(409).json({
        success: false,
        error: 'Model ID already exists'
      });
    }

    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * PUT /api/custom-models/:id
 * Update model metadata */
router.put('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const updates = req.body;
    const query = { modelId: id };

    const model = await CustomModel.findOne(query);

    if (!model) {
      return res.status(404).json({
        success: false,
        error: 'Model not found'
      });
    }

    // Update allowed fields
    const allowedUpdates = ['displayName', 'description', 'tags', 'notes', 'modelfileContent', 'abTestConfig'];

    allowedUpdates.forEach(field => {
      if (updates[field] !== undefined) {
        model[field] = updates[field];
      }
    });

    // Recalculate modelfile hash if content changed
    if (updates.modelfileContent) {
      const crypto = require('crypto');
      model.modelfileHash = crypto
        .createHash('sha256')
        .update(updates.modelfileContent)
        .digest('hex');
    }

    await model.save();

    res.json({
      success: true,
      model
    });
  } catch (error) {
    logger.error('Failed to update model', { error: error.message });
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * DELETE /api/custom-models/:id
 * Archive a model (soft delete)
 */
router.delete('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    if (!requireTypedConfirmation(req, res, 'ARCHIVE CUSTOM MODEL', id)) return;
    const { reason } = req.body;

    const model = await customModelService.archiveModel(id, reason || 'User requested');

    res.json({
      success: true,
      message: 'Model archived successfully',
      model
    });
  } catch (error) {
    logger.error('Failed to archive model', { error: error.message });
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * POST /api/custom-models/:id/deploy
 * Deploy model to Ollama host
 */
router.post('/:id/deploy', async (req, res) => {
  try {
    const { id } = req.params;
    const { ollamaHost } = req.body;

    if (!ollamaHost) {
      return res.status(400).json({
        success: false,
        error: 'ollamaHost is required'
      });
    }

    const validation = validateHostUrl(ollamaHost);
    if (!validation.valid) {
      return res.status(400).json({
        success: false,
        error: validation.message
      });
    }

    const result = await customModelService.deployToOllama(id, validation.host || String(ollamaHost).trim());

    res.json({
      success: true,
      message: 'Model deployed successfully',
      ...result
    });
  } catch (error) {
    logger.error('Failed to deploy model', { error: error.message });
    res.status(error.statusCode || 500).json({
      success: false,
      code: error.code || 'CUSTOM_MODEL_DEPLOY_FAILED',
      error: error.message
    });
  }
});

/**
 * POST /api/custom-models/:id/rollback
 * Rollback to a previous version
 */
router.post('/:id/rollback', async (req, res) => {
  try {
    const { id } = req.params;
    const { targetVersion } = req.body;

    if (!targetVersion) {
      return res.status(400).json({
        success: false,
        error: 'targetVersion is required'
      });
    }

    if (!requireTypedConfirmation(req, res, 'ROLLBACK CUSTOM MODEL', id, 'TO', targetVersion)) return;

    const model = await customModelService.rollbackToVersion(id, targetVersion);

    res.json({
      success: true,
      message: 'Model rolled back successfully',
      model
    });
  } catch (error) {
    logger.error('Failed to rollback model', { error: error.message });
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * GET /api/custom-models/:id/stats
 * Get model performance statistics
 */
router.get('/:id/stats', async (req, res) => {
  try {
    const { id } = req.params;
    const { period } = req.query;

    const stats = await customModelService.getModelStats(id, period);

    res.json({
      success: true,
      stats
    });
  } catch (error) {
    logger.error('Failed to get model stats', { error: error.message });
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * GET /api/custom-models/compare
 * Compare two model versions
 */
router.get('/compare', async (req, res) => {
  try {
    const { model1, model2 } = req.query;

    if (!model1 || !model2) {
      return res.status(400).json({
        success: false,
        error: 'Both model1 and model2 query parameters are required'
      });
    }

    const comparison = await customModelService.compareVersions(model1, model2);

    res.json({
      success: true,
      comparison
    });
  } catch (error) {
    logger.error('Failed to compare models', { error: error.message });
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * POST /api/custom-models/:id/validate
 * Validate Modelfile syntax
 */
router.post('/:id/validate', async (req, res) => {
  try {
    const { id } = req.params;
    const { modelfileContent } = req.body;

    let content = modelfileContent;

    if (!content) {
      const model = await CustomModel.findOne({ modelId: id });
      if (!model || !model.modelfileContent) {
        return res.status(400).json({
          success: false,
          error: 'Modelfile content not provided and not found in model'
        });
      }
      content = model.modelfileContent;
    }

    const validation = await customModelService.validateModelfile(content);

    res.json({
      success: validation.valid,
      validation
    });
  } catch (error) {
    logger.error('Failed to validate modelfile', { error: error.message });
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * POST /api/custom-models/:id/inference
 * Record inference statistics
 */
router.post('/:id/inference', async (req, res) => {
  try {
    const { id } = req.params;
    const { responseTime, tokensPerSecond, feedback } = req.body;

    if (!responseTime || !tokensPerSecond) {
      return res.status(400).json({
        success: false,
        error: 'responseTime and tokensPerSecond are required'
      });
    }

    const model = await customModelService.updateInferenceStats(id, responseTime, tokensPerSecond, feedback);

    res.json({
      success: true,
      message: 'Inference recorded',
      stats: model.stats
    });
  } catch (error) {
    logger.error('Failed to record inference', { error: error.message });
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * POST /api/custom-models/:id/deprecate
 * Deprecate a model version
 */
router.post('/:id/deprecate', async (req, res) => {
  try {
    const { id } = req.params;
    if (!requireTypedConfirmation(req, res, 'DEPRECATE CUSTOM MODEL', id)) return;
    const { reason } = req.body;

    const model = await customModelService.deprecateVersion(id, reason || 'User requested');

    res.json({
      success: true,
      message: 'Model deprecated successfully',
      model
    });
  } catch (error) {
    logger.error('Failed to deprecate model', { error: error.message });
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * GET /api/custom-models/:id/history
 * Get version history for a model
 */
router.get('/:id/history', async (req, res) => {
  try {
    const { id } = req.params;

    const history = await CustomModel.getVersionHistory(id);

    res.json({
      success: true,
      count: history.length,
      history
    });
  } catch (error) {
    logger.error('Failed to get model history', { error: error.message });
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * GET /api/custom-models/ab-test/select
 * Select a model for A/B testing
 */
router.get('/ab-test/select', async (req, res) => {
  try {
    const model = await customModelService.selectModelForABTest();

    if (!model) {
      return res.json({
        success: true,
        model: null,
        message: 'No A/B test models available'
      });
    }

    res.json({
      success: true,
      model: {
        modelId: model.modelId,
        displayName: model.displayName,
        version: model.version,
        trafficWeight: model.abTestConfig.trafficWeight
      }
    });
  } catch (error) {
    logger.error('Failed to select A/B test model', { error: error.message });
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

module.exports = router;
