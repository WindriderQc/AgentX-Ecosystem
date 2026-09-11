'use strict';

const { createHash } = require('node:crypto');
const PipelineTask = require('../../models/PipelineTask');
const { validateSpec } = require('./todoAuthoringService');
const { normalizeTaskRoutingMetadata, assertDependenciesExist, assertNoDependencyCycle, assertPlanningLinksExist } = require('./pipelineTaskService');

const EDITABLE_FIELDS = ['title', 'spec', 'service', 'priority', 'epic', 'dependsOn', 'notBefore', 'dueAt', 'planningItemIds'];
let dependencyEdits = Promise.resolve();

function editError(message, status = 400, code = 'INVALID_TASK_EDIT') {
  return Object.assign(new Error(message), { status, code });
}

// Heartbeats and receipts do not change the content being edited.
function editToken(task) {
  return createHash('sha256').update(JSON.stringify(EDITABLE_FIELDS.map(key => task[key] ?? null))).digest('hex');
}

function normalizeEdits(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw editError('Task changes must be an object');
  if (Object.keys(input).some(key => !EDITABLE_FIELDS.includes(key))) throw editError('Only task content and planning fields can be edited');
  const edits = normalizeTaskRoutingMetadata(input);
  for (const [key, max] of [['title', 120], ['service', 120], ['epic', 200]]) {
    if (input[key] === undefined) continue;
    if (typeof input[key] !== 'string' || input[key].length > max || (key === 'title' && !input[key].trim())) {
      throw editError(`${key} must be ${key === 'title' ? 'non-empty ' : ''}text of at most ${max} characters`);
    }
    edits[key] = input[key].trim();
  }
  if (input.spec !== undefined) edits.spec = validateSpec(input.spec);
  return edits;
}

function editTask(pipelineId, input = {}) {
  // The single Core writer checks and changes graph edges together. Two tabs
  // editing different tasks must not both validate A -> B and B -> A as safe.
  if (input.changes?.dependsOn === undefined) return applyTaskEdit(pipelineId, input);
  const result = dependencyEdits.then(() => applyTaskEdit(pipelineId, input));
  dependencyEdits = result.catch(() => {});
  return result;
}

async function applyTaskEdit(pipelineId, { changes, editToken: expectedToken, by = 'operator' } = {}) {
  const edits = normalizeEdits(changes);
  const current = await PipelineTask.findOne({ pipelineId }).lean();
  if (!current) throw editError('Task not found', 404, 'NOT_FOUND');
  if (!expectedToken || expectedToken !== editToken(current)) {
    throw editError('This task was edited elsewhere. Your draft has been kept; compare it with the latest task before saving.', 409, 'TASK_EDIT_CONFLICT');
  }
  if (edits.dependsOn) {
    await assertDependenciesExist(edits.dependsOn);
    await assertNoDependencyCycle(pipelineId, edits.dependsOn);
  }
  if (edits.planningItemIds) await assertPlanningLinksExist(edits.planningItemIds, current.planningItemIds || []);
  const changed = Object.keys(edits).filter(key => JSON.stringify(current[key] ?? null) !== JSON.stringify(edits[key] ?? null));
  if (!changed.length) return current;
  const query = { pipelineId, $and: EDITABLE_FIELDS.map(key => ({
    [key]: current[key] === undefined ? { $exists: false } : { $eq: current[key] }
  })) };
  const updated = await PipelineTask.findOneAndUpdate(query, {
    $set: Object.fromEntries(changed.map(key => [key, edits[key]])),
    $push: { feedback: { by: String(by).trim().slice(0, 160) || 'operator', text: `Edited task: ${changed.join(', ')}.`, at: new Date() } }
  }, { new: true, runValidators: true }).lean();
  if (!updated) throw editError('This task changed while saving. Your draft has been kept.', 409, 'TASK_EDIT_CONFLICT');
  return updated;
}

module.exports = { EDITABLE_FIELDS, editToken, normalizeEdits, editTask };
