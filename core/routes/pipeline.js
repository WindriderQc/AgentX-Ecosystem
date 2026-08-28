const express = require('express');
const router = express.Router();
const envelope = require('../src/helpers/responseEnvelope');
const PipelineTask = require('../models/PipelineTask');
const { operatorAccessAllowed } = require('../src/middleware/operatorAccess');
const {
  createTaskInMongo,
  findNextEligibleTask,
  claimEligibleTask,
} = require('../src/services/pipelineTaskService');
const STATUSES = ['queued', 'in_progress', 'review', 'blocked', 'done'];

// A worker's feedback verdict maps to a task status. "done" goes to REVIEW (the
// overseer confirms it to `done` via /status) — workers don't self-certify done.
const FEEDBACK_STATUS = { done: 'review', blocked: 'blocked', partial: 'in_progress' };
const ACTIVE_STATUSES = ['queued', 'in_progress', 'review', 'blocked'];

// One-release compatibility shim. Board integrations are separately deployed
// adapters and consume the product-owned task API instead of running in Core.
router.post('/leantime-sync', (_req, res) => {
  return envelope.error(
    res,
    410,
    'The embedded Leantime adapter was removed. Install a separately operated adapter that consumes /api/pipeline/tasks.',
    'ADAPTER_REQUIRED'
  );
});

// Create a task directly in Mongo (the membrane). POST .../tasks { title|objective, ... }
router.post('/tasks', async (req, res) => {
  try {
    const task = await createTaskInMongo(req.body || {});
    return envelope.success(res, { task }, null, 201);
  } catch (err) { return envelope.error(res, err.status || 400, err.message, err.code || 'TASK_CREATE_ERROR'); }
});

const SUMMARY_FIELDS = [
  'pipelineId', 'title', 'service', 'status', 'assignee', 'heartbeatAt',
  'epic', 'source', 'priority', 'dependsOn', 'notBefore', 'dueAt', 'risk',
  'planningItemIds', 'scheduleEntryIds', 'createdAt', 'updatedAt'
].join(' ');

function truthy(value) {
  return ['1', 'true', 'yes', 'on'].includes(String(value || '').toLowerCase());
}

function buildTaskListQuery(params = {}) {
  const q = {};
  if (params.status) {
    q.status = params.status;
  } else if (!truthy(params.includeDone)) {
    q.status = { $in: ACTIVE_STATUSES };
  }
  if (params.assignee) q.assignee = params.assignee;
  if (params.service) q.service = params.service;
  if (params.source) q.source = params.source;
  return q;
}

function feedbackTextFromBody(body = {}) {
  return String(body.text ?? body.summary ?? '').trim().slice(0, 5000);
}

// List tasks (queryable). GET /api/pipeline/tasks?status=&assignee=&limit=&view=summary
router.get('/tasks', async (req, res) => {
  try {
    const q = buildTaskListQuery(req.query);
    const limit = Math.min(Number(req.query.limit) || 200, 1000);
    let query = PipelineTask.find(q).sort({ pipelineId: 1 }).limit(limit);
    if (req.query.view === 'summary') {
      query = query.select(SUMMARY_FIELDS);
    }
    const tasks = await query.lean();
    return envelope.success(res, { count: tasks.length, tasks });
  } catch (err) { return envelope.error(res, 500, err.message); }
});

// Next queued task for an agent to pick up.
router.get('/tasks/next', async (req, res) => {
  try {
    const task = await findNextEligibleTask(req.query);
    return envelope.success(res, {
      task: task || null,
      nextTaskId: task?.pipelineId || null,
      pipelineId: task?.pipelineId || null
    });
  } catch (err) { return envelope.error(res, 500, err.message); }
});

// Full task detail (spec + feedback audit trail) for the human Pipeline UI.
// Registered after /tasks/next so the literal segment keeps priority.
// GET /api/pipeline/tasks/:id
router.get('/tasks/:id', async (req, res) => {
  try {
    const task = await PipelineTask.findOne({ pipelineId: req.params.id }).lean();
    if (!task) return envelope.error(res, 404, 'Task not found', 'NOT_FOUND');
    return envelope.success(res, { task });
  } catch (err) { return envelope.error(res, 500, err.message); }
});

// Atomically claim a task — kills the multi-agent race. POST .../tasks/:id/claim { assignee }
router.post('/tasks/:id/claim', async (req, res) => {
  const assignee = (req.body && req.body.assignee) || 'unknown-agent';
  try {
    const task = await claimEligibleTask(req.params.id, assignee);
    return envelope.success(res, { task });
  } catch (err) { return envelope.error(res, err.status || 500, err.message, err.code); }
});

// Update status (the overseer confirms review -> done here). POST .../tasks/:id/status { status, by? }
//
// Governance gate (task 0354): confirming a task to `done` is overseer work, not
// worker self-certification. Enforced ONLY for the ->done transition; every other
// transition stays open per the token-free multi-agent design (see file header).
// Rules for ->done: (1) reachable only from `review` (no skipping the review
// stage); (2) `by` is required and must differ from the task's `assignee` (the
// worker). This is an auditable honesty gate for cooperating LAN agents, not a
// cryptographic boundary; an explicit operator-token caller bypasses it (human
// force), and every confirmation is recorded in the feedback audit trail.
router.post('/tasks/:id/status', async (req, res) => {
  const b = req.body || {};
  const status = b.status;
  if (!STATUSES.includes(status)) return envelope.error(res, 400, `status must be one of ${STATUSES.join('|')}`, 'INVALID_STATUS');
  try {
    const current = await PipelineTask.findOne({ pipelineId: req.params.id });
    if (!current) return envelope.error(res, 404, 'Task not found', 'NOT_FOUND');

    const update = { $set: { status } };
    // Re-queue means release. Keeping the previous worker and heartbeat here
    // creates a queued-but-unclaimable zombie because both /next and /claim
    // intentionally require assignee:null.
    if (status === 'queued') {
      update.$set.assignee = null;
      update.$set.heartbeatAt = null;
    }

    if (status === 'done' && current.status !== 'done') {
      const by = String(b.by || '').trim();
      const operator = operatorAccessAllowed(req, { allowLoopback: false });
      if (!operator) {
        if (current.status !== 'review') {
          return envelope.error(res, 409, `Task ${current.pipelineId} is '${current.status}', not 'review' — it must pass review before being confirmed done.`, 'DONE_REQUIRES_REVIEW');
        }
        if (!by) {
          return envelope.error(res, 400, "confirming 'done' requires 'by' (the confirming overseer identity)", 'CONFIRM_REQUIRES_BY');
        }
        if (current.assignee && by === current.assignee) {
          return envelope.error(res, 403, `worker '${by}' cannot self-certify its own task done — a different overseer must confirm (task 0354 separation of duties)`, 'SELF_CERTIFY_FORBIDDEN');
        }
      }
      update.$push = { feedback: { by: by || 'operator', text: `Confirmed review -> done${by ? ` by ${by}` : ' (operator override)'}.`, at: new Date() } };
    }

    const task = await PipelineTask.findOneAndUpdate({ pipelineId: req.params.id }, update, { new: true });
    if (!task) return envelope.error(res, 404, 'Task not found', 'NOT_FOUND');
    return envelope.success(res, { task });
  } catch (err) { return envelope.error(res, 500, err.message); }
});

// Submit feedback. "done" sends it to REVIEW (overseer-gated). POST .../tasks/:id/feedback { text, status?, by? }
router.post('/tasks/:id/feedback', async (req, res) => {
  const b = req.body || {};
  const text = feedbackTextFromBody(b);
  if (!text) return envelope.error(res, 400, 'feedback text is required', 'EMPTY_FEEDBACK');
  const entry = { by: String(b.by || b.assignee || 'agent').trim() || 'agent', text, at: new Date() };
  const update = { $push: { feedback: entry } };
  if (FEEDBACK_STATUS[b.status]) update.$set = { status: FEEDBACK_STATUS[b.status] };
  try {
    const task = await PipelineTask.findOneAndUpdate({ pipelineId: req.params.id }, update, { new: true });
    if (!task) return envelope.error(res, 404, 'Task not found', 'NOT_FOUND');
    return envelope.success(res, { task });
  } catch (err) { return envelope.error(res, 500, err.message); }
});

// Heartbeat a claimed task. POST .../tasks/:id/heartbeat
router.post('/tasks/:id/heartbeat', async (req, res) => {
  try {
    const task = await PipelineTask.findOneAndUpdate(
      { pipelineId: req.params.id }, { $set: { heartbeatAt: new Date() } }, { new: true },
    );
    if (!task) return envelope.error(res, 404, 'Task not found', 'NOT_FOUND');
    return envelope.success(res, { pipelineId: task.pipelineId, heartbeatAt: task.heartbeatAt });
  } catch (err) { return envelope.error(res, 500, err.message); }
});

module.exports = router;
