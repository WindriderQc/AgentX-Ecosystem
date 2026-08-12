'use strict';

const ActivityLog = require('../../models/ActivityLog');
const PipelineTask = require('../../models/PipelineTask');
const logger = require('../../config/logger');

async function settledValue(promise, label) {
  try {
    return await promise;
  } catch (error) {
    logger.warn(`[AgentOps] ${label} unavailable`, { error: error.message });
    return [];
  }
}

async function loadAgentOpsHistoryInputs(options = {}) {
  const limit = Math.min(Math.max(Number(options.limit) || 30, 1), 100);
  const [auditEntries, recentTasks] = await Promise.all([
    settledValue(
      ActivityLog.find({
        action: 'system_action',
        'details.namespace': 'agent-ops'
      }).sort({ timestamp: -1 }).limit(limit).lean(),
      'operator audit history'
    ),
    settledValue(
      PipelineTask.find({})
        .sort({ updatedAt: -1 })
        .limit(limit)
        .select('pipelineId title service epic status assignee createdAt updatedAt')
        .lean(),
      'pipeline history'
    )
  ]);

  return { auditEntries, recentTasks };
}

module.exports = { loadAgentOpsHistoryInputs };
