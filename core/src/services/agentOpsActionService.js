'use strict';

const ActivityLog = require('../../models/ActivityLog');
const PipelineTask = require('../../models/PipelineTask');
const { normalizeAgentId } = require('./agentOpsProjectionService');

const SUPPORTED_ACTIONS = ['work-claim'];

class AgentOpsActionError extends Error {
  constructor(message, status = 400, code = 'AGENT_OPS_ACTION_ERROR') {
    super(message);
    this.name = 'AgentOpsActionError';
    this.status = status;
    this.code = code;
  }
}

function confirmationKey(action, target) {
  return `${String(action || '').trim()}:${String(target || '').trim()}`;
}

async function recordAudit({ action, target, assignee, status, message, requestMeta = {} }) {
  try {
    await ActivityLog.logActivity({
      action: 'system_action',
      username: requestMeta.username || 'operator',
      target,
      status,
      errorMessage: status === 'failure' ? message : undefined,
      ipAddress: requestMeta.ipAddress,
      userAgent: requestMeta.userAgent,
      details: {
        namespace: 'agent-ops',
        action,
        target,
        assignee: assignee || null,
        label: `${action.replace(/-/g, ' ')} · ${target}`,
        message
      }
    });
  } catch {
    // The action result remains authoritative even if auxiliary audit storage is unavailable.
  }
}

async function executeWorkClaim({ target, assignee, projection, PipelineTaskModel = PipelineTask }) {
  const normalizedAssignee = normalizeAgentId(assignee);
  const agent = (projection.agents || []).find((item) => normalizeAgentId(item.registryId || item.id) === normalizedAssignee);
  if (!agent || agent.status === 'superseded') {
    throw new AgentOpsActionError('Assignee is not an active registered identity', 400, 'INVALID_ASSIGNEE');
  }
  const projectedTask = projection.work?.active?.find((task) => task.pipelineId === target);
  if (!projectedTask) throw new AgentOpsActionError('Work item not found in the current projection', 404, 'NOT_FOUND');
  const task = await PipelineTaskModel.findOneAndUpdate(
    { pipelineId: target, status: 'queued', assignee: null },
    { $set: { assignee: normalizedAssignee, status: 'in_progress', heartbeatAt: new Date() } },
    { new: true }
  );
  if (!task) {
    throw new AgentOpsActionError('Work item is no longer available for assignment', 409, 'TASK_UNAVAILABLE');
  }
  return {
    action: 'work-claim',
    target,
    assignee: normalizedAssignee,
    message: `#${target} assigned to ${agent.name}`,
    task
  };
}

async function executeAgentOpsAction(options) {
  const { action, target, assignee, requestMeta } = options;
  if (!SUPPORTED_ACTIONS.includes(action)) {
    throw new AgentOpsActionError('Unsupported Agent Ops action', 400, 'UNSUPPORTED_ACTION');
  }
  if (!target) throw new AgentOpsActionError('Action target is required', 400, 'TARGET_REQUIRED');

  try {
    const result = await executeWorkClaim(options);
    await recordAudit({ action, target, assignee: result.assignee || assignee, status: 'success', message: result.message, requestMeta });
    return result;
  } catch (error) {
    await recordAudit({ action, target, assignee, status: 'failure', message: error.message, requestMeta });
    throw error;
  }
}

module.exports = {
  SUPPORTED_ACTIONS,
  AgentOpsActionError,
  confirmationKey,
  executeAgentOpsAction
};
