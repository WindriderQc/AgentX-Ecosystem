/**
 * Pipeline task service — Mongo is the SOURCE OF TRUTH for the agent task
 * pipeline. Leantime is a BIDIRECTIONAL view; git keeps the code.
 *
 *   Mongo  --push-->  Leantime   (agent created/changed a task)
 *   Mongo  <--pull--  Leantime   (human dragged a card / created one)
 *
 * Deterministic (no LLM) so any agent can trigger it via /api/pipeline/*.
 * Reconciliation uses a per-task watermark (the last status both sides agreed
 * on) to tell which side changed since the previous run. Cards are matched to
 * tasks by their "[NNNN]" pipelineId prefix — no dependence on Leantime ids.
 */
const PipelineTask = require('../../models/PipelineTask');
const Counter = require('../../models/Counter');
const { validateRequest, renderTodo } = require('./todoAuthoringService');

// canonical status <-> Leantime numeric column:
// 3 New(queued) · 4 In Progress · 2 Waiting-for-approval(review) · 1 Blocked · 0 Done
const STATUS_TO_LT = { queued: 3, in_progress: 4, review: 2, blocked: 1, done: 0 };
const LT_TO_STATUS = { 3: 'queued', 4: 'in_progress', 2: 'review', 1: 'blocked', 0: 'done' };
const ACTIVE = new Set([3, 4, 2, 1]); // anything not Done gets a card
const VALID_RISKS = new Set(['', 'low', 'medium', 'high', 'critical']);
const PIPELINE_ID_RE = /^\d{3,4}$/;

const leantimeBaseUrl = () => String(process.env.LEANTIME_BASE_URL || '').replace(/\/+$/, '');
const leantimeUrl = () => `${leantimeBaseUrl()}/api/jsonrpc`;
const projectId = () => Number(process.env.AGENTX_PIPELINE_PROJECT_ID) || null;
const apiKey = () => process.env.LEANTIME_API_KEY || '';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
 * Pure reconciliation decision for one task. All statuses are Leantime numeric
 * (or null for "no card"). want = Mongo task status mapped to LT; card = the
 * Leantime card status; watermark = last agreed LT status.
 */
function reconcile(want, card, watermark) {
  if (card === null || card === undefined) return 'create';
  if (card === want) return 'aligned';
  const mongoChanged = watermark !== null && watermark !== undefined && want !== watermark;
  const leantimeChanged = watermark !== null && watermark !== undefined && card !== watermark;
  if (leantimeChanged && !mongoChanged) return 'pull';        // human dragged the card
  if (mongoChanged && !leantimeChanged) return 'pushStatus';  // agent changed Mongo
  return 'conflict';                                          // both, or no watermark -> human wins
}

async function rpc(method, params, _try = 0) {
  const res = await fetch(leantimeUrl(), {
    method: 'POST',
    headers: { 'x-api-key': apiKey(), 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', method, id: 1, params }),
  });
  if (res.status === 429 && _try < 7) { await sleep(2000 + 2000 * _try); return rpc(method, params, _try + 1); }
  if (!res.ok) throw new Error(`Leantime RPC ${method} -> HTTP ${res.status}`);
  const body = await res.json();
  // Leantime returns HTTP 200 even on JSON-RPC errors — treat them as failures
  // so sync stats and cron reports never claim success on a rejected op.
  if (body && body.error) {
    const msg = body.error.message || JSON.stringify(body.error);
    throw new Error(`Leantime RPC ${method} -> ${msg}`);
  }
  return body;
}

/** Bidirectional reconcile between Mongo (truth) and the Leantime board. */
async function syncWithLeantime(opts = {}) {
  if (!apiKey()) throw new Error('LEANTIME_API_KEY is not configured');
  if (!leantimeBaseUrl()) throw new Error('LEANTIME_BASE_URL is not configured');
  const proj = Number(opts.projectId || projectId());
  if (!Number.isInteger(proj) || proj <= 0) {
    throw new Error('AGENTX_PIPELINE_PROJECT_ID is not configured');
  }
  const dryRun = !!opts.dryRun;
  const syncDone = !!opts.syncDone;

  // index Leantime cards by their [NNNN] prefix; collect human-created orphans
  const resp = await rpc('leantime.rpc.Tickets.getAll', { searchCriteria: { currentProject: proj, status: '' } });
  const cards = new Map();
  const orphans = [];
  for (const t of resp.result || []) {
    if (!t || typeof t !== 'object' || Number(t.projectId) !== proj) continue;
    const mm = /^\[(\d{3,4})\]/.exec(String(t.headline || ''));
    if (mm) cards.set(mm[1], { id: t.id, status: Number(t.status) });
    else if (String(t.headline || '').trim()) orphans.push(t);
  }

  const tasks = await PipelineTask.find({});
  const stats = { tasks: tasks.length, cards: cards.size, orphans: orphans.length,
    created: 0, pushedStatus: 0, pulled: 0, conflicts: 0, intake: 0, ideaIntake: 0, aligned: 0 };

  for (const task of tasks) {
    const want = STATUS_TO_LT[task.status];
    const card = cards.get(task.pipelineId);
    const decision = reconcile(want, card ? card.status : null, task.leantimeStatusWatermark);

    if (decision === 'create') {
      if (task.status === 'done' && !syncDone) { stats.aligned += 1; continue; }
      stats.created += 1;
      if (!dryRun) {
        await rpc('leantime.rpc.Tickets.quickAddTicket', { params: {
          projectId: proj, type: 'task', status: want, tags: 'agentx,pipeline',
          headline: `[${task.pipelineId}] ${task.title}`,
          description: `Mongo-backed pipeline task ${task.pipelineId}. Status edits on this board sync back to Mongo (the source of truth).`,
        } });
        task.leantimeStatusWatermark = want; await task.save();
      }
    } else if (decision === 'aligned') {
      if (task.leantimeStatusWatermark !== want && !dryRun) { task.leantimeStatusWatermark = want; await task.save(); }
      stats.aligned += 1;
    } else if (decision === 'pull' || decision === 'conflict') {
      const newStatus = LT_TO_STATUS[card.status] || task.status;
      task.status = newStatus; task.leantimeStatusWatermark = card.status; task.source = 'leantime';
      // A human dragging a card back to "New" un-claims it — don't leave a
      // zombie queued-but-still-assigned task the worker thinks it owns.
      if (newStatus === 'queued') { task.assignee = null; task.heartbeatAt = null; }
      if (!dryRun) await task.save();
      stats[decision === 'pull' ? 'pulled' : 'conflicts'] += 1;
    } else if (decision === 'pushStatus') {
      if (!dryRun) await rpc('leantime.rpc.Tickets.patch', { id: card.id, params: { status: want } });
      task.leantimeStatusWatermark = want;
      if (!dryRun) await task.save();
      stats.pushedStatus += 1;
    }
  }

  // intake: human-created cards with no pipelineId -> new Mongo tasks (then tag the card)
  for (const oc of orphans) {
    stats.intake += 1;
    if (dryRun) continue;
    const seq = await Counter.next('pipelineTask');
    const pid = String(seq).padStart(4, '0');
    const status = LT_TO_STATUS[Number(oc.status)] || 'queued';
    await PipelineTask.create({
      pipelineId: pid, title: String(oc.headline).slice(0, 200), status,
      leantimeStatusWatermark: Number(oc.status), source: 'leantime', epic: 'Leantime intake',
    });
    await rpc('leantime.rpc.Tickets.patch', { id: oc.id, params: { headline: `[${pid}] ${oc.headline}` } });
  }

  // intake: Leantime Idea-board items -> new Mongo tasks (idempotent by leantimeIdeaId).
  // Closes the funnel: drop an Idea on the board -> it becomes a pipeline task.
  let ideas = [];
  try {
    const ir = await rpc('leantime.rpc.Ideas.pollForNewIdeas', { projectId: proj });
    if (Array.isArray(ir.result)) ideas = ir.result;
  } catch (err) { /* no idea board / API off — skip */ }
  const seenIdeas = new Set(tasks.filter((t) => t.leantimeIdeaId != null).map((t) => Number(t.leantimeIdeaId)));
  for (const idea of ideas) {
    const ideaId = Number(idea && idea.id);
    if (!Number.isFinite(ideaId) || seenIdeas.has(ideaId)) continue;
    const title = String((idea && (idea.title || idea.description)) || '').trim();
    if (!title) continue;
    seenIdeas.add(ideaId);
    stats.ideaIntake += 1;
    if (dryRun) continue;
    const seq = await Counter.next('pipelineTask');
    const pid = String(seq).padStart(4, '0');
    await PipelineTask.create({
      pipelineId: pid, title: title.slice(0, 200), status: 'queued',
      source: 'leantime-idea', leantimeIdeaId: ideaId, epic: 'Idea intake',
    });
  }

  return { projectId: proj, dryRun, ...stats };
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
  reconcile,
  syncWithLeantime,
  createTaskInMongo,
  normalizeTaskRoutingMetadata,
  assertNoDependencyCycle,
  buildEligibleQueueQuery,
  compareEligibleTasks,
  findNextEligibleTask,
  claimEligibleTask,
  STATUS_TO_LT,
  LT_TO_STATUS,
};
