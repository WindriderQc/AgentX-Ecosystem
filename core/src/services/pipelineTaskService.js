/**
 * Product-owned Mongo task queue. Environment-specific boards may consume the
 * bounded /api/pipeline contract from a separately deployed adapter.
 */
const PipelineTask = require('../../models/PipelineTask');
const Counter = require('../../models/Counter');
const { validateRequest, renderTodo } = require('./todoAuthoringService');

const VALID_RISKS = new Set(['', 'low', 'medium', 'high', 'critical']);
const PIPELINE_ID_RE = /^\d{3,4}$/;

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
  return candidates.find((task) => dependenciesAreDone(task, dependencyStatuses)) || null;
}

async function claimEligibleTask(pipelineId, assignee, now = new Date()) {
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

  const task = await PipelineTask.findOneAndUpdate(
    {
      pipelineId,
      assignee: null,
      status: 'queued',
      $or: [
        { notBefore: null },
        { notBefore: { $exists: false } },
        { notBefore: { $lte: now } },
      ],
    },
    { $set: { assignee, status: 'in_progress', heartbeatAt: now } },
    { new: true },
  );
  if (!task) {
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
};
