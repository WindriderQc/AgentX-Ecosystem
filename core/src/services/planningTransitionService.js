const PlanningItem = require('../../models/PlanningItem');
const PipelineTask = require('../../models/PipelineTask');
const planningWorkflowService = require('./planningWorkflowService');

class PlanningTransitionError extends Error {
  constructor(message, { status = 400, code = 'PLANNING_ERROR' } = {}) {
    super(message);
    this.name = 'PlanningTransitionError';
    this.status = status;
    this.code = code;
  }
}

function text(value, max = 1000) {
  return String(value == null ? '' : value).trim().slice(0, max);
}

function actor(input = {}) {
  return text(input.by || input.actor || 'operator', 120) || 'operator';
}

async function transitionContext(item) {
  const [parent, linkedTaskCount, children] = await Promise.all([
    item.parentId
      ? PlanningItem.findById(item.parentId).select('type status').lean()
      : Promise.resolve(null),
    PipelineTask.countDocuments({ planningItemIds: item._id }),
    PlanningItem.find({
      parentId: item._id,
      status: { $ne: 'archived' }
    }).select('status').lean()
  ]);
  return {
    parentType: parent?.type || '',
    linkedTaskCount,
    childCount: children.length,
    incompleteChildCount: children.filter((child) => child.status !== 'completed').length
  };
}

async function applyWorkflowAction(item, action, input = {}, { expectedStatus = '' } = {}) {
  const transition = planningWorkflowService.resolveAction(item.type, item.status, action);
  if (!transition || (expectedStatus && transition.toStatus !== expectedStatus)) {
    throw new PlanningTransitionError(
      `${action || 'requested action'} is not valid for ${item.type} in ${item.status}`,
      { status: 409, code: 'INVALID_PLANNING_TRANSITION' }
    );
  }
  const issues = planningWorkflowService.transitionIssues(
    item,
    action,
    await transitionContext(item)
  );
  if (issues.length) {
    throw new PlanningTransitionError(`Cannot ${transition.label.toLowerCase()}: ${issues.join('; ')}`, {
      status: 422,
      code: 'PLANNING_TRANSITION_GATED'
    });
  }
  const fromStatus = item.status;
  item.status = transition.toStatus;
  if (action === 'complete' && !item.dates?.completedAt) item.dates.completedAt = new Date();
  if (action === 'reopen' && item.dates) item.dates.completedAt = null;
  if (action === 'accept' && !item.decision?.decidedAt) item.decision.decidedAt = new Date();
  item.archivedAt = null;
  item.history.push({
    action,
    at: new Date(),
    by: actor(input),
    note: text(input.note) || `${transition.label}: ${fromStatus} → ${transition.toStatus}`,
    metadata: { fromStatus, toStatus: transition.toStatus }
  });
  return transition;
}

module.exports = {
  PlanningTransitionError,
  transitionContext,
  applyWorkflowAction
};
