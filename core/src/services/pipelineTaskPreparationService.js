'use strict';

const PipelineTask = require('../../models/PipelineTask');
const { editToken } = require('./pipelineTaskEditorService');
const { normalizePipelineAutomationIntent } = require('../../../shared/pipelineAutomationContract');

function conflict(message) { return Object.assign(new Error(message), { statusCode: 409, code: 'TASK_PREPARATION_CONFLICT' }); }

async function read(pipelineId) {
  const task = await PipelineTask.findOne({ pipelineId }).lean();
  if (!task) throw Object.assign(new Error('Task not found'), { statusCode: 404 });
  return { task, editToken: editToken(task) };
}

// The deployment owns planning; Core owns every write to the canonical task.
async function apply({ pipelineId, expectedUpdatedAt, automation, question, answer, plan }) {
  const { task } = await read(pipelineId);
  if (!['queued', 'blocked'].includes(task.status) || task.automationLease?.leaseId) throw conflict('The task is already running or awaiting review.');
  if (task.assignee && !(task.status === 'blocked' && task.automation?.mode === 'review_only')) throw conflict('Another worker owns this task.');
  if (String(new Date(task.updatedAt).toISOString()) !== expectedUpdatedAt) throw conflict('The task changed while the team prepared it. Your answer has not been discarded; try again.');
  if (['personal', 'family', 'household', 'secretary'].includes(String(task.service).toLowerCase())) throw conflict('This task belongs to its personal or household workflow.');
  const at = new Date();
  const feedback = [];
  const previous = (task.feedback || []).at(-1);
  if (answer && !(previous?.by === 'operator' && previous.text === String(answer))) feedback.push({ by: 'operator', text: String(answer).slice(0, 3000), at });
  if (question) feedback.push({ by: 'coding-team', text: String(question).slice(0, 3000), at });
  if (plan) feedback.push({ by: 'coding-team', text: `Execution plan: ${String(plan).slice(0, 2800)}`, at });
  const changes = question ? { status: 'blocked' } : { status: 'queued', assignee: null, heartbeatAt: null };
  if (automation) {
    if (task.automationAttemptCount > 0) throw conflict('An existing attempt must resume its original scope.');
    changes.automation = normalizePipelineAutomationIntent(automation);
    changes.risk = 'low';
  }
  const update = { $set: changes, ...(feedback.length && { $push: { feedback: { $each: feedback } } }) };
  const options = { new: true, runValidators: true };
  const latest = (task.automationAttempts || []).at(-1);
  if (!question && latest) {
    update.$set['automationAttempts.$[attempt].reviewOutcome'] = 'requeued';
    update.$set['automationAttempts.$[attempt].reviewedAt'] = at;
    options.arrayFilters = [{ 'attempt.attempt': latest.attempt }];
  }
  const updated = await PipelineTask.findOneAndUpdate({ pipelineId, updatedAt: task.updatedAt, status: task.status }, update, options).lean();
  if (!updated) throw conflict('The task changed while saving. Try again with the current ticket.');
  return updated;
}

module.exports = { read, apply };
