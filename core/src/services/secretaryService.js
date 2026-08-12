/**
 * Secretary lane — Nestor as "adjointe administrative" (task 0457).
 *
 * The pipeline already had a write path (create_todo) and a dispatch guard
 * (buildNextTaskQuery excludes service:'personal' so dev workers never pick
 * up "cancel Spotify"). What was missing is the other half of a secretary:
 * Nestor could WRITE a task but could never READ the list back or CLOSE
 * anything. A secretary who takes notes and can never tell you what's on
 * your list is not a secretary.
 *
 * This service adds add/list/complete over the `personal` lane, shaped for
 * voice use:
 *   - add     — one required field (title). No dev-task ceremony
 *               (source_files/steps/acceptance_criteria) for "call the plumber".
 *   - list    — compact, sorted by urgency, with overdue/dueToday flags so
 *               Nestor can lead with what actually matters.
 *   - complete— resolves by pipelineId OR natural title substring, because
 *               nobody says "mark task zero-three-one-nine done" out loud.
 *               Ambiguous matches return the candidates instead of guessing.
 *
 * Authority note: completing a PERSONAL task deliberately bypasses the
 * review->done governance gate on /api/pipeline/tasks/:id/status. That gate
 * exists to stop a dev worker self-certifying its own code. For a personal
 * errand the operator's word IS the authority, and there is no second party
 * to confirm it. Dev-lane tasks are refused by this service on purpose.
 */

const PipelineTask = require('../../models/PipelineTask');
const Counter = require('../../models/Counter');

const PERSONAL_SERVICE = 'personal';
const PERSONAL_EPIC = 'Personal';
const OPEN_STATUSES = ['queued', 'in_progress', 'review', 'blocked'];
const DEFAULT_LIST_LIMIT = 25;

class SecretaryError extends Error {
  constructor(message, { status = 400, code = 'SECRETARY_ERROR', details = null } = {}) {
    super(message);
    this.name = 'SecretaryError';
    this.status = status;
    this.code = code;
    if (details) this.details = details;
  }
}

/** Parse an ISO date/datetime. Returns null for empty, throws on garbage. */
function parseDueAt(value) {
  if (value === undefined || value === null || value === '') return null;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new SecretaryError(
      'dueAt must be an ISO date (YYYY-MM-DD) or datetime; resolve relative dates like "Friday" before calling',
      { code: 'SECRETARY_BAD_DUE_DATE' }
    );
  }
  return parsed;
}

function startOfTomorrow(now) {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() + 1);
  return d;
}

/** Compact, voice-friendly projection of a task. */
function serialize(task, now = new Date()) {
  const dueAt = task.dueAt ? new Date(task.dueAt) : null;
  const tomorrow = startOfTomorrow(now);
  return {
    id: task.pipelineId,
    title: task.title,
    status: task.status,
    priority: task.priority,
    note: task.spec || '',
    dueAt: dueAt ? dueAt.toISOString() : null,
    overdue: Boolean(dueAt && dueAt.getTime() < now.getTime() && task.status !== 'done'),
    dueToday: Boolean(dueAt && dueAt.getTime() < tomorrow.getTime() && dueAt.getTime() >= now.getTime() - 86_400_000
      && task.status !== 'done'),
    createdAt: task.createdAt ? new Date(task.createdAt).toISOString() : null,
    completedAt: task.status === 'done' && task.updatedAt ? new Date(task.updatedAt).toISOString() : null
  };
}

/**
 * Add a personal task. Only `title` is required — this is the whole point of
 * the lane: capturing an errand must be as cheap as saying it.
 */
async function addPersonalTask(input = {}) {
  const title = String(input.title || '').trim();
  if (!title) {
    throw new SecretaryError('title is required', { code: 'SECRETARY_TITLE_REQUIRED' });
  }
  const dueAt = parseDueAt(input.dueAt);
  const priorityRaw = Number(input.priority);
  const priority = Number.isFinite(priorityRaw)
    ? Math.max(1, Math.min(5, Math.floor(priorityRaw)))
    : 3;

  const seq = await Counter.next('pipelineTask');
  const pipelineId = String(seq).padStart(4, '0');

  const created = await PipelineTask.create({
    pipelineId,
    title: title.slice(0, 200),
    spec: String(input.note || '').slice(0, 2000),
    service: PERSONAL_SERVICE,
    status: 'queued',
    epic: PERSONAL_EPIC,
    priority,
    dueAt,
    source: input.source || 'nestor-secretary'
  });

  return serialize(created);
}

/**
 * List personal tasks, most urgent first: overdue, then soonest due, then
 * priority, then oldest. Done items are excluded unless asked for.
 */
async function listPersonalTasks(input = {}) {
  const limit = Math.max(1, Math.min(Number(input.limit) || DEFAULT_LIST_LIMIT, 100));
  const includeDone = input.includeDone === true;
  const query = { service: PERSONAL_SERVICE };
  if (!includeDone) query.status = { $in: OPEN_STATUSES };

  const tasks = await PipelineTask.find(query)
    .select('pipelineId title spec status priority dueAt createdAt updatedAt')
    .limit(limit)
    .lean();

  const now = new Date();
  const items = tasks.map((t) => serialize(t, now));
  items.sort((a, b) => {
    if (a.dueAt && b.dueAt) {
      const diff = new Date(a.dueAt) - new Date(b.dueAt);
      if (diff !== 0) return diff;
    } else if (a.dueAt) return -1;
    else if (b.dueAt) return 1;
    if (a.priority !== b.priority) return a.priority - b.priority;
    return a.id.localeCompare(b.id);
  });

  return {
    count: items.length,
    overdueCount: items.filter((i) => i.overdue).length,
    dueTodayCount: items.filter((i) => i.dueToday).length,
    tasks: items
  };
}

/**
 * Resolve a natural reference to exactly one OPEN personal task.
 * Accepts a 3-4 digit pipelineId, or a case-insensitive title substring.
 * Refuses to guess when several match — returns the candidates so the caller
 * (Nestor) can ask which one.
 */
async function resolvePersonalTask(ref) {
  const raw = String(ref || '').trim();
  if (!raw) throw new SecretaryError('ref is required', { code: 'SECRETARY_REF_REQUIRED' });

  if (/^\d{3,4}$/.test(raw)) {
    const byId = await PipelineTask.findOne({ pipelineId: raw.padStart(4, '0') });
    if (!byId) {
      throw new SecretaryError(`No task ${raw}`, { status: 404, code: 'SECRETARY_TASK_NOT_FOUND' });
    }
    if (byId.service !== PERSONAL_SERVICE) {
      throw new SecretaryError(
        `Task ${raw} is a ${byId.service || 'dev'}-lane task, not a personal one; use the pipeline API for dev work`,
        { status: 409, code: 'SECRETARY_NOT_PERSONAL' }
      );
    }
    return byId;
  }

  const open = await PipelineTask.find({ service: PERSONAL_SERVICE, status: { $in: OPEN_STATUSES } });
  const needle = raw.toLowerCase();
  const matches = open.filter((t) => String(t.title || '').toLowerCase().includes(needle));

  if (matches.length === 1) return matches[0];
  if (matches.length === 0) {
    throw new SecretaryError(`No open personal task matching "${raw}"`, {
      status: 404,
      code: 'SECRETARY_TASK_NOT_FOUND'
    });
  }
  throw new SecretaryError(
    `"${raw}" matches ${matches.length} open tasks; be more specific or use the id`,
    {
      status: 409,
      code: 'SECRETARY_AMBIGUOUS_REF',
      details: { candidates: matches.map((t) => ({ id: t.pipelineId, title: t.title })) }
    }
  );
}

/** Mark a personal task done, with an audit line. */
async function completePersonalTask(input = {}) {
  const task = await resolvePersonalTask(input.ref);
  if (task.status === 'done') {
    return { alreadyDone: true, task: serialize(task) };
  }
  task.status = 'done';
  task.assignee = null;
  task.heartbeatAt = null;
  task.feedback.push({
    by: String(input.by || 'nestor-secretary').slice(0, 120),
    text: String(input.note || 'Completed via the secretary lane.').slice(0, 2000)
  });
  await task.save();
  return { alreadyDone: false, task: serialize(task) };
}

module.exports = {
  SecretaryError,
  PERSONAL_SERVICE,
  PERSONAL_EPIC,
  addPersonalTask,
  listPersonalTasks,
  completePersonalTask,
  resolvePersonalTask,
  // exported for tests
  serialize,
  parseDueAt
};
