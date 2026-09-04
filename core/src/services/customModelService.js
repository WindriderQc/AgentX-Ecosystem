const CustomModel = require('../../models/CustomModel');
const logger = require('../../config/logger');
const crypto = require('crypto');
const { exec } = require('child_process');
const util = require('util');
const execPromise = util.promisify(exec);

class CustomModelService {
  /**
   * Register a new custom model
   */
  async registerModel(modelData) {
    try {
      // Generate hash for modelfile if provided
      if (modelData.modelfileContent) {
        modelData.modelfileHash = crypto
          .createHash('sha256')
          .update(modelData.modelfileContent)
          .digest('hex');
      }

      const model = new CustomModel(modelData);
      await model.save();

      logger.info('Custom model registered', {
        modelId: model.modelId,
        version: model.version
      });

      return model;
    } catch (error) {
      logger.error('Failed to register custom model', {
        error: error.message,
        modelData
      });
      throw error;
    }
  }

  /**
   * Update model status
   */
  async updateModelStatus(modelId, status, metadata = {}) {
    try {
      const model = await CustomModel.findOne({ modelId });

      if (!model) {
        throw new Error(`Model not found: ${modelId}`);
      }

      model.status = status;

      if (status === 'deployed' && metadata.host) {
        await model.markAsDeployed(metadata.host);
      }

      if (metadata.notes) {
        model.notes += `\n${new Date().toISOString()}: ${metadata.notes}`;
      }

      await model.save();

      logger.info('Model status updated', { modelId, status });

      return model;
    } catch (error) {
      logger.error('Failed to update model status', {
        error: error.message,
        modelId,
        status
      });
      throw error;
    }
  }

  /**
   * Deploy model to Ollama host
   */
  async deployToOllama() {
    // Model creation changes Ollama residency and may continue after a socket
    // disconnect. Keep this legacy path unavailable until it is implemented on
    // the fenced runtime-mutation primitive with an exact terminal receipt.
    const error = new Error('Custom model deployment is disabled until coordinated runtime mutation receipts are implemented');
    error.code = 'CUSTOM_MODEL_DEPLOY_DISABLED';
    error.statusCode = 409;
    throw error;
  }

  /**
   * Validate Modelfile syntax
   */
  async validateModelfile(modelfileContent) {
    try {
      // Basic validation rules
      const requiredCommands = ['FROM'];
      const validCommands = ['FROM', 'SYSTEM', 'TEMPLATE', 'PARAMETER', 'ADAPTER', 'LICENSE', 'MESSAGE'];

      const lines = modelfileContent.split('\n')
        .map(line => line.trim())
        .filter(line => line && !line.startsWith('#'));

      // Check for required commands
      const hasFrom = lines.some(line => line.toUpperCase().startsWith('FROM'));
      if (!hasFrom) {
        return {
          valid: false,
          error: 'Modelfile must contain a FROM command'
        };
      }

      // Check for invalid commands
      for (const line of lines) {
        const command = line.split(' ')[0].toUpperCase();
        if (!validCommands.includes(command)) {
          return {
            valid: false,
            error: `Invalid command: ${command}`
          };
        }
      }

      return {
        valid: true,
        commands: lines.length
      };
    } catch (error) {
      return {
        valid: false,
        error: error.message
      };
    }
  }

  /**
   * Rollback to previous version
   */
  async rollbackToVersion(modelId, targetVersion) {
    try {
      const currentModel = await CustomModel.findOne({ modelId });

      if (!currentModel) {
        throw new Error(`Model not found: ${modelId}`);
      }

      // Find target version in history
      const versions = await CustomModel.getVersionHistory(modelId);
      const targetModel = versions.find(v => v.version === targetVersion);

      if (!targetModel) {
        throw new Error(`Version not found: ${targetVersion}`);
      }

      // Create new version based on target
      const rollbackModel = new CustomModel({
        modelId: `${modelId}-rollback-${Date.now()}`,
        baseModel: targetModel.baseModel,
        displayName: `${targetModel.displayName} (Rollback)`,
        description: `Rolled back from ${currentModel.version} to ${targetVersion}`,
        version: targetModel.version,
        modelfileContent: targetModel.modelfileContent,
        previousVersion: currentModel._id,
        status: 'ready',
        tags: [...targetModel.tags, 'rollback'],
        notes: `Rollback from ${currentModel.version} to ${targetVersion}`
      });

      await rollbackModel.save();

      // Deprecate current version
      await currentModel.deprecate(`Rolled back to ${targetVersion}`);

      logger.info('Model rolled back', {
        from: currentModel.version,
        to: targetVersion,
        newModelId: rollbackModel.modelId
      });

      return rollbackModel;
    } catch (error) {
      logger.error('Failed to rollback model', {
        error: error.message,
        modelId,
        targetVersion
      });
      throw error;
    }
  }

  /**
   * Update aggregate inference stats (averages + counters) on a custom model document.
   * Distinct from the per-call InferenceLog writer in modelRouter.
   */
  async updateInferenceStats(modelId, responseTime, tokensPerSecond, feedback = null) {
    try {
      const model = await CustomModel.findOne({ modelId });

      if (!model) {
        logger.warn('Model not found for inference recording', { modelId });
        return null;
      }

      await model.updateInferenceStats(responseTime, tokensPerSecond, feedback);

      return model;
    } catch (error) {
      logger.error('Failed to record inference', {
        error: error.message,
        modelId
      });
      throw error;
    }
  }

  /**
   * Get model statistics
   */
  async getModelStats(modelId, period = '30d') {
    try {
      const model = await CustomModel.findOne({ modelId });

      if (!model) {
        throw new Error(`Model not found: ${modelId}`);
      }

      // Calculate period-specific stats (would need time-series data for accurate results)
      // For now, return current stats
      return {
        modelId: model.modelId,
        displayName: model.displayName,
        version: model.version,
        status: model.status,
        period,
        stats: model.stats,
        abTestConfig: model.abTestConfig
      };
    } catch (error) {
      logger.error('Failed to get model stats', {
        error: error.message,
        modelId
      });
      throw error;
    }
  }

  /**
   * Compare two model versions
   */
  async compareVersions(modelId1, modelId2) {
    try {
      return await CustomModel.compareModels(modelId1, modelId2);
    } catch (error) {
      logger.error('Failed to compare models', {
        error: error.message,
        modelId1,
        modelId2
      });
      throw error;
    }
  }

  /**
   * Archive model
   */
  async archiveModel(modelId, reason = 'Manual archive') {
    try {
      const model = await CustomModel.findOne({ modelId });

      if (!model) {
        throw new Error(`Model not found: ${modelId}`);
      }

      await model.archive(reason);

      logger.info('Model archived', { modelId, reason });

      return model;
    } catch (error) {
      logger.error('Failed to archive model', {
        error: error.message,
        modelId
      });
      throw error;
    }
  }

  /**
   * Deprecate version
   */
  async deprecateVersion(modelId, reason = 'Manual deprecation') {
    try {
      const model = await CustomModel.findOne({ modelId });

      if (!model) {
        throw new Error(`Model not found: ${modelId}`);
      }

      await model.deprecate(reason);

      logger.info('Model deprecated', { modelId, reason });

      return model;
    } catch (error) {
      logger.error('Failed to deprecate model', {
        error: error.message,
        modelId
      });
      throw error;
    }
  }

  /**
   * Get model for A/B testing
   */
  async selectModelForABTest() {
    try {
      const models = await CustomModel.getABTestModels();

      if (models.length === 0) {
        return null;
      }

      // Calculate total weight
      const totalWeight = models.reduce((sum, m) => sum + m.abTestConfig.trafficWeight, 0);

      if (totalWeight === 0) {
        return models[0]; // Return first if no weights set
      }

      // Random selection based on weights
      const random = Math.random() * totalWeight;
      let cumulative = 0;

      for (const model of models) {
        cumulative += model.abTestConfig.trafficWeight;
        if (random <= cumulative) {
          return model;
        }
      }

      return models[0]; // Fallback
    } catch (error) {
      logger.error('Failed to select A/B test model', {
        error: error.message
      });
      return null;
    }
  }

  /**
   * List all models
   */
  async listModels(filters = {}) {
    try {
      const query = { isActive: true };

      if (filters.status) {
        query.status = filters.status;
      }

      if (filters.baseModel) {
        query.baseModel = filters.baseModel;
      }

      // Fix: Use $in operator for array matching (tags is an array field)
      if (filters.tag) {
        query.tags = { $in: [filters.tag] };
      }

      const models = await CustomModel.find(query)
        .sort({ createdAt: -1 })
        .lean();

      return models;
    } catch (error) {
      logger.error('Failed to list models', {
        error: error.message,
        filters
      });
      throw error;
    }
  }
}

// Export singleton instance
const customModelService = new CustomModelService();
module.exports = customModelService;
