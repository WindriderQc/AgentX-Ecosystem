'use strict';

const ModelProfile = require('../../../models/ModelProfile');
const { isAdaptedModel } = require('./namingConvention');
const logger = require('../../../config/logger');
const { listModels } = require('../../clients/ollamaClient');

const SCAN_TIMEOUT_MS = 8000;

async function scanHost(hostUrl) {
  try {
    const data = await listModels(hostUrl, { timeoutMs: SCAN_TIMEOUT_MS });
    return (data.models || [])
      .filter(m => !isAdaptedModel(m.name))
      .map(m => ({
        name: m.name,
        size: m.size || 0,
        parameters: m.details?.parameter_size || '',
        family: m.details?.family || '',
        quantization: m.details?.quantization_level || ''
      }));
  } catch (err) {
    logger.warn(`Failed to scan ${hostUrl}`, { error: err.message });
    return [];
  }
}

async function syncHostModels(hostUrl, hostId) {
  const models = await scanHost(hostUrl);
  const results = { synced: 0, total: models.length };
  for (const model of models) {
    try {
      await ModelProfile.findOneAndUpdate(
        { name: model.name },
        {
          $set: {
            [`hosts.${hostId}.available`]: true,
            [`hosts.${hostId}.lastSeen`]: new Date(),
            family: model.family || undefined,
            parameters: model.parameters || undefined,
            quantization: model.quantization || undefined
          },
          $setOnInsert: {
            name: model.name,
            displayName: model.name.split(':')[0],
            tags: []
          }
        },
        { upsert: true, new: true }
      );
      results.synced++;
    } catch (err) {
      logger.warn(`Failed to sync model ${model.name}`, { error: err.message });
    }
  }
  return results;
}

async function syncAllHosts(hosts) {
  const results = {};
  for (const host of hosts) {
    results[host.hostId] = await syncHostModels(host.hostUrl, host.hostId);
  }
  return results;
}

module.exports = { scanHost, syncHostModels, syncAllHosts };
