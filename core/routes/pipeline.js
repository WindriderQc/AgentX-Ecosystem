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
  assertLeaseMutationAllowed,
  heartbeatClaim,
  releaseAutomationSlot,
} = require('../src/services/pipelineTaskService');
const {
  PIPELINE_AUTOMATION_EVIDENCE_SCHEMA,
  normalizePipelineAutomationEvidence,
} = require('../../shared/pipelineAutomationContract');
const {
  buildPipelineAutomationPerformance,
} = require('../src/services/pipelineAutomationPerformanceService');
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
  'automation', 'automationAttemptCount',
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

function performanceWindow(value) {
  const match = String(value || '30d').trim().match(/^(7|30|90)d$/);
  return match ? Number(match[1]) : null;
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

// Privacy-safe team performance over persisted autonomous attempts. Missing
// evidence remains null and is reported through coverage rather than becoming
// a false zero. GET /api/pipeline/performance?window=7d|30d|90d
router.get('/performance', async (req, res) => {
  const windowDays = performanceWindow(req.query.window);
  if (!windowDays) {
    return envelope.error(res, 400, 'window must be one of 7d, 30d, or 90d', 'INVALID_PERFORMANCE_WINDOW');
  }
  try {
    const now = new Date();
    const from = new Date(now.getTime() - windowDays * 86_400_000);
    const tasks = await PipelineTask.find({
      'automationAttempts.acquiredAt': { $gte: from, $lte: now },
    }).select('pipelineId createdAt automation automationAttempts').lean();
    return envelope.success(res, {
      performance: buildPipelineAutomationPerformance(tasks, { now, windowDays }),
    });
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

// Bounded exact-task read for a guarded worker. It deliberately excludes the
// personal/idea-drop lanes and never changes eligibility or claim state.
// Registered before /tasks/:id so the literal worker suffix keeps priority.
router.get('/tasks/:id/worker', requirePipelineWorkerAccess, async (req, res) => {
  try {
    const agent = String(req.query.agent || '').trim();
    const task = await PipelineTask.findOne({
      pipelineId: req.params.id,
      service: { $ne: 'personal' },
      source: { $ne: 'idea-drop' },
      $or: [
        { status: 'queued', assignee: null },
        ...(agent ? [{ status: { $in: ['in_progress', 'review', 'blocked'] }, assignee: agent }] : []),
      ],
    }).lean();
    if (!task) {
      return envelope.error(res, 404, 'Task is unavailable to this worker identity', 'WORKER_TASK_UNAVAILABLE');
    }
    return envelope.success(res, { task });
  } catch (err) { return envelope.error(res, err.status || 500, err.message, err.code); }
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

// Reconcile one previously unknown completed-attempt cost from a bounded
// operator-reviewed provider/runtime receipt. This is write-once: an existing
// cost may be confirmed idempotently but never replaced or contradicted.
router.post(
  '/tasks/:id/automation-attempts/:attempt/cost',
  requirePipelineWorkerAccess,
  async (req, res) => {
    if (req.pipelineAuthority !== PIPELINE_AUTHORITY.OPERATOR) {
      return envelope.error(
        res,
        403,
        'Attempt cost reconciliation requires the operator token.',
        'PIPELINE_COST_RECONCILIATION_REQUIRES_OPERATOR'
      );
    }
    const attemptNumber = Number(req.params.attempt);
    const body = req.body || {};
    const by = String(body.by || '').trim();
    if (!Number.isInteger(attemptNumber) || attemptNumber < 1 || attemptNumber > 10) {
      return envelope.error(res, 400, 'attempt must be an integer from 1 through 10', 'INVALID_ATTEMPT');
    }
    if (!by || by.length > 160) {
      return envelope.error(res, 400, 'by is required and must be at most 160 characters', 'INVALID_RECONCILER');
    }
    try {
      const current = await PipelineTask.findOne({ pipelineId: req.params.id });
      if (!current) return envelope.error(res, 404, 'Task not found', 'NOT_FOUND');
      const attempts = Array.isArray(current.automationAttempts) ? current.automationAttempts : [];
      const attempt = attempts.find((item) => Number(item?.attempt) === attemptNumber);
      if (!attempt) return envelope.error(res, 404, 'Automation attempt not found', 'ATTEMPT_NOT_FOUND');
      if (!attempt.completedAt || attempt.finalState === 'active') {
        return envelope.error(res, 409, 'Only a completed automation attempt may be reconciled', 'ATTEMPT_NOT_COMPLETED');
      }

      const existing = attempt.evidence?.toObject
        ? attempt.evidence.toObject({ depopulate: true })
        : (attempt.evidence || null);
      const normalized = normalizePipelineAutomationEvidence({
        schema: PIPELINE_AUTOMATION_EVIDENCE_SCHEMA,
        verification: existing?.verification || { status: 'unknown' },
        changes: existing?.changes || {},
        usage: {
          ...(existing?.usage || {}),
          costNanodollars: body.costNanodollars,
          costKind: body.costKind,
          costSource: body.costSource,
          costEvidenceFingerprint: body.costEvidenceFingerprint,
        },
        failureCodes: existing?.failureCodes || [],
        workerReceiptFingerprint: existing?.workerReceiptFingerprint || null,
        source: existing?.source || 'cost-reconciliation/v1',
      });
      if (normalized.usage.costNanodollars == null
        || !normalized.usage.costKind
        || !normalized.usage.costSource
        || !normalized.usage.costEvidenceFingerprint) {
        return envelope.error(
          res,
          400,
          'costNanodollars, costKind, costSource, and costEvidenceFingerprint are required',
          'INCOMPLETE_COST_EVIDENCE'
        );
      }

      const priorUsage = existing?.usage || {};
      if (priorUsage.costNanodollars != null) {
        const idempotent = Number(priorUsage.costNanodollars) === normalized.usage.costNanodollars
          && String(priorUsage.costKind || '') === normalized.usage.costKind
          && String(priorUsage.costSource || '') === normalized.usage.costSource
          && String(priorUsage.costEvidenceFingerprint || '') === normalized.usage.costEvidenceFingerprint;
        if (!idempotent) {
          return envelope.error(
            res,
            409,
            'Existing attempt cost evidence cannot be replaced or contradicted',
            'COST_EVIDENCE_CONFLICT'
          );
        }
        return envelope.success(res, {
          task: current,
          costReconciliation: { attempt: attemptNumber, reconciled: false, idempotent: true },
        });
      }

      const audit = {
        by,
        at: new Date(),
        text: `Reconciled automation attempt ${attemptNumber} ${normalized.usage.costKind} as ${normalized.usage.costNanodollars} nanodollars from ${normalized.usage.costSource}.`,
      };
      const task = await PipelineTask.findOneAndUpdate(
        {
          pipelineId: req.params.id,
          automationAttempts: {
            $elemMatch: {
              attempt: attemptNumber,
              completedAt: { $ne: null },
              'evidence.usage.costNanodollars': null,
            },
          },
        },
        {
          $set: { 'automationAttempts.$[attempt].evidence': normalized },
          $push: { feedback: audit },
        },
        { new: true, arrayFilters: [{ 'attempt.attempt': attemptNumber }] }
      );
      if (!task) {
        return envelope.error(res, 409, 'Attempt cost evidence changed before reconciliation', 'COST_EVIDENCE_CONFLICT');
      }
      return envelope.success(res, {
        task,
        costReconciliation: {
          attempt: attemptNumber,
          reconciled: true,
          idempotent: false,
          costNanodollars: normalized.usage.costNanodollars,
          costKind: normalized.usage.costKind,
          costSource: normalized.usage.costSource,
          costEvidenceFingerprint: normalized.usage.costEvidenceFingerprint,
        },
      });
    } catch (err) {
      return envelope.error(res, err.status || 400, err.message, err.code || 'COST_RECONCILIATION_ERROR');
    }
  }
);

// Atomically claim a task — kills the multi-agent race. POST .../tasks/:id/claim { assignee }
router.post('/tasks/:id/claim', requirePipelineWorkerAccess, async (req, res) => {
  const body = req.body || {};
  const assignee = body.assignee || 'unknown-agent';
  try {
    const task = body.automated === true
      ? await claimEligibleTask(req.params.id, assignee, new Date(), {
        automated: true,
        leaseDurationMs: body.leaseDurationMs,
      })
      : await claimEligibleTask(req.params.id, assignee);
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

    let workerLease = null;
    if (current.automationLease?.leaseId && req.pipelineAuthority === PIPELINE_AUTHORITY.WORKER) {
      try {
        workerLease = assertLeaseMutationAllowed(current, {
          assignee: b.leaseAssignee || b.assignee || b.by,
          leaseId: b.leaseId,
        });
      } catch (err) {
        return envelope.error(res, 409, err.message, err.code);
      }
    }

    const terminalAutomationLease = current.automationLease?.leaseId && status !== 'in_progress'
      ? {
        leaseId: String(current.automationLease.leaseId),
        pipelineId: current.pipelineId,
        assignee: String(current.automationLease.assignee || current.assignee || ''),
      }
      : null;
    if (terminalAutomationLease) {
      update.$set['automationAttempts.$[attempt].finalState'] = status === 'queued' ? 'released' : status;
      update.$set['automationAttempts.$[attempt].completedAt'] = new Date();
      update.$unset = { automationLease: 1 };
    }

    const latestAttempt = Array.isArray(current.automationAttempts)
      ? current.automationAttempts.slice().reverse().find((attempt) => attempt?.leaseId)
      : null;
    const reviewOutcome = !terminalAutomationLease && latestAttempt
      ? (
        status === 'done' && current.status === 'review' ? 'accepted'
          : status === 'queued' && ['review', 'blocked'].includes(current.status) ? 'requeued'
            : status === 'blocked' && current.status === 'review' ? 'rejected'
              : null
      )
      : null;
    if (reviewOutcome) {
      update.$set['automationAttempts.$[reviewAttempt].reviewOutcome'] = reviewOutcome;
      update.$set['automationAttempts.$[reviewAttempt].reviewedAt'] = new Date();
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

    const mutationQuery = { pipelineId: req.params.id };
    if (workerLease) {
      mutationQuery.status = 'in_progress';
      mutationQuery.assignee = workerLease.assignee;
      mutationQuery['automationLease.leaseId'] = workerLease.leaseId;
      mutationQuery['automationLease.expiresAt'] = { $gt: new Date() };
    }
    const options = { new: true };
    if (terminalAutomationLease) {
      options.arrayFilters = [{ 'attempt.leaseId': current.automationLease.leaseId }];
    } else if (reviewOutcome) {
      options.arrayFilters = [{ 'reviewAttempt.leaseId': latestAttempt.leaseId }];
    }
    const task = await PipelineTask.findOneAndUpdate(mutationQuery, update, options);
    if (!task && workerLease) {
      return envelope.error(res, 409, 'automation lease changed before status was recorded', 'TASK_LEASE_MISMATCH');
    }
    if (!task) return envelope.error(res, 404, 'Task not found', 'NOT_FOUND');
    if (terminalAutomationLease) await releaseAutomationSlot(terminalAutomationLease);
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
  try {
    const current = await PipelineTask.findOne({ pipelineId: req.params.id });
    if (!current) return envelope.error(res, 404, 'Task not found', 'NOT_FOUND');
    let lease = null;
    try {
      lease = assertLeaseMutationAllowed(current, {
        assignee: b.leaseAssignee || b.assignee || b.by,
        leaseId: b.leaseId,
      });
    } catch (err) {
      return envelope.error(res, 409, err.message, err.code);
    }
    if (b.attemptEvidence && !lease) {
      return envelope.error(
        res,
        400,
        'attemptEvidence requires an active automation lease',
        'AUTOMATION_EVIDENCE_REQUIRES_LEASE'
      );
    }
    if (b.attemptEvidence && !['done', 'blocked'].includes(b.status)) {
      return envelope.error(
        res,
        400,
        'attemptEvidence may be recorded only with a terminal worker verdict',
        'AUTOMATION_EVIDENCE_REQUIRES_TERMINAL_VERDICT'
      );
    }

    let terminalVerdict = b.status;
    let normalizedEvidence = null;
    if (b.attemptEvidence) {
      try {
        normalizedEvidence = normalizePipelineAutomationEvidence(b.attemptEvidence);
      } catch (err) {
        return envelope.error(res, err.status || 400, err.message, err.code || 'INVALID_AUTOMATION_EVIDENCE');
      }
    }
    const rawAllowedCost = current.automation?.budgets?.maxCostNanodollars;
    const allowedCost = Number(rawAllowedCost);
    if (lease && b.status === 'done') {
      if (!normalizedEvidence) {
        normalizedEvidence = normalizePipelineAutomationEvidence({
          schema: PIPELINE_AUTOMATION_EVIDENCE_SCHEMA,
          verification: { status: 'unknown' },
          changes: {},
          usage: {},
          failureCodes: [],
          source: 'core-cost-gate/v1',
        });
      }
      const observedCost = normalizedEvidence.usage.costNanodollars;
      const costBudgetValid = rawAllowedCost != null
        && Number.isSafeInteger(allowedCost)
        && allowedCost >= 0;
      const costFailure = !costBudgetValid
        ? 'cost_budget_invalid'
        : (observedCost == null
          ? 'cost_evidence_required'
          : (observedCost > allowedCost ? 'cost_budget_exceeded' : null));
      if (costFailure) {
        terminalVerdict = 'blocked';
        normalizedEvidence.failureCodes = Array.from(new Set([
          ...normalizedEvidence.failureCodes,
          costFailure,
        ])).sort();
      }
    }
    if (FEEDBACK_STATUS[terminalVerdict]) update.$set = { status: FEEDBACK_STATUS[terminalVerdict] };

    const query = { pipelineId: req.params.id };
    const options = { new: true };
    if (lease) {
      query.status = 'in_progress';
      query.assignee = lease.assignee;
      query['automationLease.leaseId'] = lease.leaseId;
      query['automationLease.expiresAt'] = { $gt: entry.at };
      if (terminalVerdict === 'done' || terminalVerdict === 'blocked') {
        update.$set['automationAttempts.$[attempt].finalState'] = FEEDBACK_STATUS[terminalVerdict];
        update.$set['automationAttempts.$[attempt].completedAt'] = entry.at;
        if (normalizedEvidence) update.$set['automationAttempts.$[attempt].evidence'] = normalizedEvidence;
        update.$unset = { automationLease: 1 };
        options.arrayFilters = [{ 'attempt.leaseId': lease.leaseId }];
      }
    }

    const task = await PipelineTask.findOneAndUpdate(query, update, options);
    if (!task && lease) {
      return envelope.error(res, 409, 'automation lease changed before feedback was recorded', 'TASK_LEASE_MISMATCH');
    }
    if (!task) return envelope.error(res, 404, 'Task not found', 'NOT_FOUND');
    if (lease && (terminalVerdict === 'done' || terminalVerdict === 'blocked')) {
      await releaseAutomationSlot({
        leaseId: lease.leaseId,
        pipelineId: current.pipelineId,
        assignee: lease.assignee,
      });
    }
    return envelope.success(res, { task });
  } catch (err) { return envelope.error(res, 500, err.message); }
});

// Heartbeat a claimed task. POST .../tasks/:id/heartbeat
router.post('/tasks/:id/heartbeat', requirePipelineWorkerAccess, async (req, res) => {
  try {
    const body = req.body || {};
    const task = await heartbeatClaim(req.params.id, {
      assignee: body.leaseAssignee || body.assignee,
      leaseId: body.leaseId,
    });
    if (!task) return envelope.error(res, 404, 'Task not found', 'NOT_FOUND');
    return envelope.success(res, { pipelineId: task.pipelineId, heartbeatAt: task.heartbeatAt });
  } catch (err) { return envelope.error(res, err.status || 500, err.message, err.code); }
});

module.exports = router;
