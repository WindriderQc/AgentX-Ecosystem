const express = require('express');
const router = express.Router();
const envelope = require('../src/helpers/responseEnvelope');
const PipelineTask = require('../models/PipelineTask');
const {
  PIPELINE_AUTHORITY,
  requirePipelineWorkerAccess,
  requirePipelineStatusAccess,
} = require('../src/helpers/pipelineAccess');
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

async function aggregateTaskCounts(query) {
  const rows = await PipelineTask.aggregate([
    { $match: query },
    { $group: { _id: '$status', count: { $sum: 1 } } }
  ]);
  const byStatus = Object.fromEntries(STATUSES.map(status => [status, 0]));
  for (const row of rows) {
    if (STATUSES.includes(row?._id)) byStatus[row._id] = Number(row.count) || 0;
  }
  const matchedCount = Object.values(byStatus).reduce((sum, count) => sum + count, 0);
  const openCount = ACTIVE_STATUSES.reduce((sum, status) => sum + byStatus[status], 0);
  return { byStatus, matchedCount, openCount, doneCount: byStatus.done };
}

function taskListEvidence(query, limit, returnedCount, summary, observedAt) {
  const filteredStatuses = typeof query.status === 'string'
    ? [query.status]
    : (Array.isArray(query.status?.$in) ? query.status.$in : STATUSES);
  const filters = {};
  for (const key of ['assignee', 'service', 'source']) {
    if (query[key]) filters[key] = query[key];
  }
  return {
    authority: 'core.pipeline',
    source: {
      service: 'core',
      store: 'mongodb',
      collection: PipelineTask.collection?.collectionName || 'pipelinetasks'
    },
    scope: {
      statuses: filteredStatuses,
      includesDone: filteredStatuses.includes('done'),
      filters,
      timeWindow: {
        kind: 'all_time',
        label: 'All matching task records; no date filter',
        from: null,
        to: observedAt
      }
    },
    rows: {
      order: 'pipelineId ascending',
      limit,
      returnedCount,
      matchedCount: summary.matchedCount,
      truncated: returnedCount < summary.matchedCount
    },
    countBasis: 'Exact MongoDB status aggregation over the stated scope',
    consistency: 'Counts and rows are sampled during one request but are not a database transaction',
    observedAt
  };
}

function feedbackTextFromBody(body = {}) {
  return String(body.text ?? body.summary ?? '').trim().slice(0, 5000);
}

// List tasks (queryable). GET /api/pipeline/tasks?status=&assignee=&limit=&view=summary
router.get('/tasks', async (req, res) => {
  try {
    const q = buildTaskListQuery(req.query);
    const limit = Math.min(Number(req.query.limit) || 200, 1000);
    const observedAt = new Date().toISOString();
    let query = PipelineTask.find(q).sort({ pipelineId: 1 }).limit(limit);
    if (req.query.view === 'summary') {
      query = query.select(SUMMARY_FIELDS);
    }
    const [tasks, summary] = await Promise.all([
      query.lean(),
      aggregateTaskCounts(q)
    ]);
    const evidence = taskListEvidence(q, limit, tasks.length, summary, observedAt);
    return envelope.success(res, { count: tasks.length, tasks, summary, evidence });
  } catch (err) { return envelope.error(res, 500, err.message); }
});

// Next queued task for an agent to pick up.
router.get('/tasks/next', requirePipelineWorkerAccess, async (req, res) => {
  try {
    const task = await findNextEligibleTask(req.query);
    return envelope.success(res, {
      task: task || null,
      nextTaskId: task?.pipelineId || null,
      pipelineId: task?.pipelineId || null
    });
  } catch (err) { return envelope.error(res, 500, err.message); }
});

// Atomically claim a task — kills the multi-agent race. POST .../tasks/:id/claim { assignee }
router.post('/tasks/:id/claim', requirePipelineWorkerAccess, async (req, res) => {
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
// transition is available to the purpose-scoped pipeline worker credential.
// Rules for ->done: (1) reachable only from `review` (no skipping the review
// stage); (2) `by` is required and must differ from the task's `assignee` (the
// worker). The route-owned identity gate adds a cryptographic boundary: a
// remote worker token cannot reach any status=done variant, regardless of the
// caller-supplied `by`. An explicit operator token retains its human-force
// override, and every confirmation is recorded in the feedback audit trail.
router.post('/tasks/:id/status', requirePipelineStatusAccess, async (req, res) => {
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
      const operator = req.pipelineAuthority === PIPELINE_AUTHORITY.OPERATOR;
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
router.post('/tasks/:id/feedback', requirePipelineWorkerAccess, async (req, res) => {
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
router.post('/tasks/:id/heartbeat', requirePipelineWorkerAccess, async (req, res) => {
  try {
    const task = await PipelineTask.findOneAndUpdate(
      { pipelineId: req.params.id }, { $set: { heartbeatAt: new Date() } }, { new: true },
    );
    if (!task) return envelope.error(res, 404, 'Task not found', 'NOT_FOUND');
    return envelope.success(res, { pipelineId: task.pipelineId, heartbeatAt: task.heartbeatAt });
  } catch (err) { return envelope.error(res, 500, err.message); }
});

module.exports = router;
