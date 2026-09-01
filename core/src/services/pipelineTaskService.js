/**
 * Product-owned Mongo task queue. Environment-specific boards may consume the
 * bounded /api/pipeline contract from a separately deployed adapter.
 */
const crypto = require('crypto');
const PipelineTask = require('../../models/PipelineTask');
const PipelineAutomationSlot = require('../../models/PipelineAutomationSlot');
const Counter = require('../../models/Counter');
const { validateRequest, renderTodo } = require('./todoAuthoringService');
const {
  normalizePipelineAutomationIntent,
  automationAdmissionReasons,
} = require('../../../shared/pipelineAutomationContract');

const VALID_RISKS = new Set(['', 'low', 'medium', 'high', 'critical']);
const PIPELINE_ID_RE = /^\d{3,4}$/;
const AUTOMATION_SLOT_ID = 'coding-dispatcher-v1';

function pipelineInputError(message, code = 'INVALID_TASK_METADATA') {
  const err = new Error(message);
  err.status = 400;
  err.code = code;
  return err;
}

/**
 * Three-way result, because "leave it alone" and "clear it" are different
 * intents and collapsing them hides a gate. `undefined` means the caller did
 * not mention the field; `null` means the caller explicitly cleared it.
 */
function parseOptionalDate(value, field) {
  if (value === undefined) return undefined;
  if (value === null || value === '') return null;
  const date = value instanceof Date ? new Date(value.getTime()) : new Date(value);
  if (!Number.isFinite(date.getTime())) {
    throw pipelineInputError(`${field} must be an ISO date/time`, 'INVALID_TASK_DATE');
  }
  return date;
}

/** `notBefore` with its `surface_after` alias, without letting an explicit null fall through to the alias. */
function pickNotBeforeInput(input = {}) {
  if (input.notBefore !== undefined) return input.notBefore;
  if (input.surface_after !== undefined) return input.surface_after;
  return undefined;
}

function normalizeTaskRoutingMetadata(input = {}) {
  const metadata = {};

  if (input.priority !== undefined && input.priority !== null && input.priority !== '') {
    const priority = Number(input.priority);
    if (!Number.isInteger(priority) || priority < 1 || priority > 5) {
      throw pipelineInputError('priority must be an integer from 1 (highest) to 5', 'INVALID_TASK_PRIORITY');
    }
    metadata.priority = priority;
  }

  if (input.dependsOn !== undefined) {
    if (!Array.isArray(input.dependsOn)) {
      throw pipelineInputError('dependsOn must be an array of pipeline ids', 'INVALID_TASK_DEPENDENCIES');
    }
    const dependsOn = [...new Set(input.dependsOn.map((id) => String(id || '').trim()).filter(Boolean))];
    if (dependsOn.some((id) => !PIPELINE_ID_RE.test(id))) {
      throw pipelineInputError('dependsOn entries must be 3- or 4-digit pipeline ids', 'INVALID_TASK_DEPENDENCIES');
    }
    metadata.dependsOn = dependsOn;
  }

  const notBefore = parseOptionalDate(pickNotBeforeInput(input), 'notBefore');
  const dueAt = parseOptionalDate(input.dueAt, 'dueAt');
  if (notBefore !== undefined) metadata.notBefore = notBefore;
  if (dueAt !== undefined) metadata.dueAt = dueAt;

  if (input.risk !== undefined && input.risk !== null) {
    const risk = String(input.risk).trim().toLowerCase();
    if (!VALID_RISKS.has(risk)) {
      throw pipelineInputError(`risk must be one of ${[...VALID_RISKS].join('|')}`, 'INVALID_TASK_RISK');
    }
    metadata.risk = risk;
  }

  if (input.automation !== undefined && input.automation !== null) {
    metadata.automation = normalizePipelineAutomationIntent(input.automation);
  }

  return metadata;
}

async function assertDependenciesExist(dependsOn = []) {
  if (!dependsOn.length) return;
  const rows = await PipelineTask.find({ pipelineId: { $in: dependsOn } })
    .select('pipelineId')
    .lean();
  const found = new Set(rows.map((row) => row.pipelineId));
  const missing = dependsOn.filter((id) => !found.has(id));
  if (missing.length) {
    throw pipelineInputError(`unknown dependency pipeline id(s): ${missing.join(', ')}`, 'UNKNOWN_TASK_DEPENDENCY');
  }
}

/**
 * Reject a dependency set that would make `pipelineId` permanently unclaimable.
 *
 * `dependenciesAreDone` requires every dependency to be `done`, so a task that
 * reaches itself through the graph can never become eligible — and nothing
 * reports it. `findNextEligibleTask` just skips it forever, which reads as "no
 * work available" rather than "this card is stuck".
 *
 * The public API cannot currently produce a cycle: ids are minted after
 * validation and dependencies must already exist, so edges only ever point at
 * older tasks. This guards hand-edited Mongo rows and any future endpoint that
 * lets `dependsOn` be rewritten after creation.
 */
async function assertNoDependencyCycle(pipelineId, dependsOn = []) {
  if (!pipelineId || !dependsOn.length) return;
  if (dependsOn.includes(pipelineId)) {
    throw pipelineInputError(
      `task ${pipelineId} cannot depend on itself`,
      'TASK_DEPENDENCY_CYCLE'
    );
  }

  const visited = new Set(dependsOn);
  let frontier = [...dependsOn];
  while (frontier.length) {
    const rows = await PipelineTask.find({ pipelineId: { $in: frontier } })
      .select('pipelineId dependsOn')
      .lean();
    const nextFrontier = [];
    for (const row of rows) {
      for (const dependency of row.dependsOn || []) {
        if (dependency === pipelineId) {
          throw pipelineInputError(
            `dependency cycle: ${pipelineId} is reachable from its own dependencies via ${row.pipelineId}`,
            'TASK_DEPENDENCY_CYCLE'
          );
        }
        if (!visited.has(dependency)) {
          visited.add(dependency);
          nextFrontier.push(dependency);
        }
      }
    }
    frontier = nextFrontier;
  }
}

function buildEligibleQueueQuery(params = {}, now = new Date()) {
  const query = {
    status: 'queued',
    assignee: null,
    $or: [
      { notBefore: null },
      { notBefore: { $exists: false } },
      { notBefore: { $lte: now } },
    ],
  };
  const includePersonal = ['1', 'true', 'yes', 'on'].includes(String(params.includePersonal || '').toLowerCase());
  const includeIdeaDrop = ['1', 'true', 'yes', 'on'].includes(String(params.includeIdeaDrop || '').toLowerCase());
  if (!includePersonal && !includeIdeaDrop) {
    query.service = { $ne: 'personal' };
    query.source = { $ne: 'idea-drop' };
  }
  return query;
}

function compareEligibleTasks(left, right) {
  const leftPriority = Number.isInteger(left.priority) ? left.priority : 3;
  const rightPriority = Number.isInteger(right.priority) ? right.priority : 3;
  if (leftPriority !== rightPriority) return leftPriority - rightPriority;

  const leftDue = left.dueAt ? new Date(left.dueAt).getTime() : Number.POSITIVE_INFINITY;
  const rightDue = right.dueAt ? new Date(right.dueAt).getTime() : Number.POSITIVE_INFINITY;
  if (leftDue !== rightDue) return leftDue - rightDue;
  return String(left.pipelineId).localeCompare(String(right.pipelineId));
}

async function loadDependencyStatuses(tasks = []) {
  const ids = [...new Set(tasks.flatMap((task) => task.dependsOn || []))];
  if (!ids.length) return new Map();
  const rows = await PipelineTask.find({ pipelineId: { $in: ids } })
    .select('pipelineId status')
    .lean();
  return new Map(rows.map((row) => [row.pipelineId, row.status]));
}

function dependenciesAreDone(task, statuses) {
  return (task.dependsOn || []).every((id) => statuses.get(id) === 'done');
}

async function findNextEligibleTask(params = {}, now = new Date()) {
  const candidates = await PipelineTask.find(buildEligibleQueueQuery(params, now)).lean();
  candidates.sort(compareEligibleTasks);
  const dependencyStatuses = await loadDependencyStatuses(candidates);
  const automationRequested = ['1', 'true', 'yes', 'on', 'review_only']
    .includes(String(params.automation || '').toLowerCase());
  return candidates.find((task) => {
    if (!dependenciesAreDone(task, dependencyStatuses)) return false;
    if (!automationRequested) return true;
    return automationAdmissionReasons(task, { dependencyStatuses, now }).length === 0;
  }) || null;
}

function pipelineConflict(message, code) {
  const err = new Error(message);
  err.status = 409;
  err.code = code;
  return err;
}

async function acquireAutomationSlot({ leaseId, pipelineId, assignee, lockKeys, now, expiresAt }) {
  try {
    const slot = await PipelineAutomationSlot.findOneAndUpdate(
      {
        _id: AUTOMATION_SLOT_ID,
        $or: [
          { leaseId: null },
          { leaseId: { $exists: false } },
          { expiresAt: null },
          { expiresAt: { $exists: false } },
          { expiresAt: { $lte: now } },
        ],
      },
      {
        $set: {
          leaseId,
          pipelineId,
          assignee,
          lockKeys,
          acquiredAt: now,
          heartbeatAt: now,
          expiresAt,
        },
      },
      { new: true, upsert: true, setDefaultsOnInsert: true }
    );
    if (!slot || slot.leaseId !== leaseId) {
      throw pipelineConflict('the autonomous coding slot is already occupied', 'AUTOMATION_SLOT_OCCUPIED');
    }
    return slot;
  } catch (err) {
    if (err?.code === 11000) {
      throw pipelineConflict('the autonomous coding slot is already occupied', 'AUTOMATION_SLOT_OCCUPIED');
    }
    throw err;
  }
}

async function extendAutomationSlot({ leaseId, pipelineId, assignee, now, expiresAt }) {
  const slot = await PipelineAutomationSlot.findOneAndUpdate(
    {
      _id: AUTOMATION_SLOT_ID,
      leaseId,
      pipelineId,
      assignee,
      expiresAt: { $gt: now },
    },
    { $set: { heartbeatAt: now, expiresAt } },
    { new: true }
  );
  if (!slot) {
    throw pipelineConflict('the autonomous coding slot is missing, expired, or reassigned', 'AUTOMATION_SLOT_MISMATCH');
  }
  return slot;
}

async function releaseAutomationSlot({ leaseId, pipelineId, assignee } = {}) {
  if (!leaseId) return false;
  const result = await PipelineAutomationSlot.updateOne(
    {
      _id: AUTOMATION_SLOT_ID,
      leaseId,
      ...(pipelineId ? { pipelineId } : {}),
      ...(assignee ? { assignee } : {}),
    },
    {
      $set: {
        leaseId: null,
        pipelineId: null,
        assignee: null,
        lockKeys: [],
        acquiredAt: null,
        heartbeatAt: null,
        expiresAt: null,
      },
    }
  );
  return result.modifiedCount === 1;
}

function assertLeaseMutationAllowed(task, { assignee, leaseId, now = new Date() } = {}) {
  const lease = task?.automationLease;
  if (!lease?.leaseId) return null;
  if (task.status !== 'in_progress') {
    throw pipelineConflict('automation lease is no longer active', 'TASK_LEASE_INACTIVE');
  }
  const normalizedLeaseId = String(leaseId || '').trim();
  const normalizedAssignee = String(assignee || '').trim();
  if (!normalizedLeaseId || normalizedLeaseId !== String(lease.leaseId)) {
    throw pipelineConflict('automation lease identity is missing or stale', 'TASK_LEASE_MISMATCH');
  }
  if (!normalizedAssignee || normalizedAssignee !== String(lease.assignee || task.assignee || '')) {
    throw pipelineConflict('automation lease assignee does not match the active claim', 'TASK_LEASE_ASSIGNEE_MISMATCH');
  }
  if (!lease.expiresAt || new Date(lease.expiresAt).getTime() <= now.getTime()) {
    throw pipelineConflict('automation lease has expired', 'TASK_LEASE_EXPIRED');
  }
  return {
    leaseId: normalizedLeaseId,
    assignee: normalizedAssignee,
    attempt: Number(lease.attempt),
    durationMs: Number(lease.durationMs),
  };
}

async function heartbeatClaim(pipelineId, identity = {}, now = new Date()) {
  const current = await PipelineTask.findOne({ pipelineId }).lean();
  if (!current) {
    const err = new Error('Task not found');
    err.status = 404;
    err.code = 'NOT_FOUND';
    throw err;
  }
  const lease = assertLeaseMutationAllowed(current, { ...identity, now });
  if (!lease) {
    return PipelineTask.findOneAndUpdate(
      { pipelineId },
      { $set: { heartbeatAt: now } },
      { new: true }
    );
  }

  const expiresAt = new Date(now.getTime() + lease.durationMs);
  await extendAutomationSlot({
    leaseId: lease.leaseId,
    pipelineId,
    assignee: lease.assignee,
    now,
    expiresAt,
  });
  const task = await PipelineTask.findOneAndUpdate(
    {
      pipelineId,
      status: 'in_progress',
      assignee: lease.assignee,
      'automationLease.leaseId': lease.leaseId,
      'automationLease.expiresAt': { $gt: now },
    },
    {
      $set: {
        heartbeatAt: now,
        'automationLease.heartbeatAt': now,
        'automationLease.expiresAt': expiresAt,
        'automationAttempts.$[attempt].heartbeatAt': now,
        'automationAttempts.$[attempt].expiresAt': expiresAt,
      },
    },
    {
      new: true,
      arrayFilters: [{ 'attempt.leaseId': lease.leaseId }],
    }
  );
  if (!task) {
    await releaseAutomationSlot({
      leaseId: lease.leaseId,
      pipelineId,
      assignee: lease.assignee,
    });
    throw pipelineConflict('automation lease changed before heartbeat was recorded', 'TASK_LEASE_MISMATCH');
  }
  return task;
}

async function claimEligibleTask(pipelineId, assignee, now = new Date(), options = {}) {
  const current = await PipelineTask.findOne({ pipelineId }).lean();
  if (!current) {
    const err = new Error('Task not found');
    err.status = 404;
    err.code = 'NOT_FOUND';
    throw err;
  }
  if (current.status !== 'queued' || current.assignee) {
    const err = new Error('Task not available (already claimed or not queued)');
    err.status = 409;
    err.code = 'TASK_UNAVAILABLE';
    throw err;
  }
  if (current.notBefore && new Date(current.notBefore).getTime() > now.getTime()) {
    const err = new Error(`Task is not eligible before ${new Date(current.notBefore).toISOString()}`);
    err.status = 409;
    err.code = 'TASK_NOT_READY';
    throw err;
  }

  const dependencyStatuses = await loadDependencyStatuses([current]);
  if (!dependenciesAreDone(current, dependencyStatuses)) {
    const err = new Error('Task dependencies are not complete');
    err.status = 409;
    err.code = 'TASK_DEPENDENCIES_BLOCKED';
    throw err;
  }

  if (options.automated) {
    const reasons = automationAdmissionReasons(current, {
      dependencyStatuses,
      now,
      activeLockKeys: options.activeLockKeys,
      protectedPathPrefixes: options.protectedPathPrefixes,
    });
    if (reasons.length) {
      const err = new Error(`Task is not eligible for autonomous dispatch: ${reasons.map((reason) => reason.code).join(', ')}`);
      err.status = 409;
      err.code = 'AUTOMATION_INELIGIBLE';
      err.reasons = reasons;
      throw err;
    }
  }

  let automatedUpdate = null;
  if (options.automated) {
    const automation = normalizePipelineAutomationIntent(current.automation);
    const requestedDuration = Number(options.leaseDurationMs || Math.min(900_000, automation.budgets.maxDurationMs));
    if (!Number.isSafeInteger(requestedDuration) || requestedDuration < 10_000 || requestedDuration > automation.budgets.maxDurationMs) {
      throw pipelineInputError(
        'leaseDurationMs must be an integer from 10000 through automation.budgets.maxDurationMs',
        'INVALID_LEASE_DURATION'
      );
    }
    const attempt = Number(current.automationAttemptCount || 0) + 1;
    const leaseId = crypto.randomUUID();
    const expiresAt = new Date(now.getTime() + requestedDuration);
    const lease = {
      leaseId,
      assignee,
      acquiredAt: now,
      heartbeatAt: now,
      expiresAt,
      durationMs: requestedDuration,
      attempt,
    };
    automatedUpdate = {
      attempt,
      expectedAttemptCount: attempt - 1,
      lease,
      update: {
        $set: { assignee, status: 'in_progress', heartbeatAt: now, automationLease: lease },
        $inc: { automationAttemptCount: 1 },
        $push: { automationAttempts: { ...lease, finalState: 'active' } },
      },
    };
  }

  const claimQuery = {
    pipelineId,
    assignee: null,
    status: 'queued',
    $or: [
      { notBefore: null },
      { notBefore: { $exists: false } },
      { notBefore: { $lte: now } },
    ],
  };
  if (automatedUpdate) {
    claimQuery['automation.mode'] = 'review_only';
    if (automatedUpdate.expectedAttemptCount === 0) {
      claimQuery.$and = [{
        $or: [
          { automationAttemptCount: 0 },
          { automationAttemptCount: { $exists: false } },
        ],
      }];
    } else {
      claimQuery.automationAttemptCount = automatedUpdate.expectedAttemptCount;
    }
  }

  if (automatedUpdate) {
    await acquireAutomationSlot({
      leaseId: automatedUpdate.lease.leaseId,
      pipelineId,
      assignee,
      lockKeys: current.automation.lockKeys,
      now,
      expiresAt: automatedUpdate.lease.expiresAt,
    });
  }

  let task;
  try {
    task = await PipelineTask.findOneAndUpdate(
      claimQuery,
      automatedUpdate?.update || { $set: { assignee, status: 'in_progress', heartbeatAt: now } },
      { new: true },
    );
  } catch (err) {
    if (automatedUpdate) {
      await releaseAutomationSlot({
        leaseId: automatedUpdate.lease.leaseId,
        pipelineId,
        assignee,
      });
    }
    throw err;
  }
  if (!task) {
    if (automatedUpdate) {
      await releaseAutomationSlot({
        leaseId: automatedUpdate.lease.leaseId,
        pipelineId,
        assignee,
      });
    }
    const err = new Error('Task not available (eligibility changed or another worker claimed it)');
    err.status = 409;
    err.code = 'TASK_UNAVAILABLE';
    throw err;
  }
  return task;
}

/**
 * Create a task directly in Mongo (the membrane). Atomic id via Counter — no
 * git file, no ROADMAP append, no id race. If the full template fields are
 * present (the create_todo contract) the structured spec is rendered and
 * stored; otherwise a lightweight task (title required) is created.
 */
async function createTaskInMongo(input = {}) {
  const hasTemplate = input.steps && input.acceptance_criteria && input.source_files;
  let req;
  if (hasTemplate) {
    req = validateRequest(input); // throws TodoAuthoringError on a bad contract
  } else {
    const title = String(input.title || input.objective || '').trim();
    if (!title) { const e = new Error('title or objective is required'); e.status = 400; throw e; }
    req = { title: title.slice(0, 120), objective: input.objective || title, service: input.service || '' };
  }
  const source = String(input.source || 'api').slice(0, 80);
  const sourceKey = input.sourceKey == null ? null : String(input.sourceKey).trim().slice(0, 200);
  if (sourceKey) {
    const existing = await PipelineTask.findOne({ source, sourceKey }).lean();
    if (existing) {
      return {
        id: existing.pipelineId,
        pipelineId: existing.pipelineId,
        title: existing.title,
        service: existing.service || '',
        status: existing.status,
        alreadyExisting: true,
      };
    }
  }
  const routingMetadata = normalizeTaskRoutingMetadata(input);
  await assertDependenciesExist(routingMetadata.dependsOn || []);
  const seq = await Counter.next('pipelineTask');
  const pipelineId = String(seq).padStart(4, '0');
  await assertNoDependencyCycle(pipelineId, routingMetadata.dependsOn || []);
  const spec = hasTemplate ? renderTodo({ id: pipelineId, ...req }) : (input.spec || '');
  try {
    await PipelineTask.create({
      pipelineId, title: req.title, spec, service: req.service || '',
      status: 'queued', epic: input.epic || 'MCP Inbox', source, sourceKey,
      ...routingMetadata,
    });
  } catch (err) {
    if (sourceKey && err?.code === 11000) {
      const existing = await PipelineTask.findOne({ source, sourceKey }).lean();
      if (existing) {
        return {
          id: existing.pipelineId,
          pipelineId: existing.pipelineId,
          title: existing.title,
          service: existing.service || '',
          status: existing.status,
          alreadyExisting: true,
        };
      }
    }
    throw err;
  }
  return {
    id: pipelineId,
    pipelineId,
    title: req.title,
    service: req.service || '',
    status: 'queued',
    ...routingMetadata,
  };
}

module.exports = {
  createTaskInMongo,
  normalizeTaskRoutingMetadata,
  assertNoDependencyCycle,
  buildEligibleQueueQuery,
  compareEligibleTasks,
  findNextEligibleTask,
  claimEligibleTask,
  assertLeaseMutationAllowed,
  heartbeatClaim,
  releaseAutomationSlot,
};
