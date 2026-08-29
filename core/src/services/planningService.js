const mongoose = require('mongoose');
const PlanningItem = require('../../models/PlanningItem');
const PipelineTask = require('../../models/PipelineTask');
const ClusterScheduleEntry = require('../../models/ClusterScheduleEntry');
const clusterScheduleService = require('./clusterScheduleService');
const planningWorkflowService = require('./planningWorkflowService');
const planningTransitionService = require('./planningTransitionService');
const planningHealthService = require('./planningHealthService');
const planningMetricConfigService = require('./planningMetricConfigService');
const { isDateOnlyOverdue } = require('./planningDateService');
const {
  PLANNING_TYPES,
  PLANNING_STATUSES,
  PLANNING_STATUS_BY_TYPE,
  PLANNING_PRIORITIES,
  PROGRESS_MODES
} = PlanningItem;
const ACTIVE_TASK_STATUSES = ['queued', 'in_progress', 'review', 'blocked'];
const TASK_FIELDS = [
  'pipelineId', 'title', 'service', 'status', 'assignee', 'heartbeatAt',
  'epic', 'source', 'priority', 'dependsOn', 'notBefore', 'dueAt', 'risk',
  'planningItemIds', 'scheduleEntryIds', 'createdAt', 'updatedAt'
].join(' ');
const PLANNING_REFERENCE_SEMANTICS = Object.freeze({
  lifecycle: 'frozen',
  purpose: 'historical_strategy_and_evidence_reference',
  currentExecutionSource: '/pipeline',
  statusMeaning: 'Saved Planning record state; it is not a current execution signal.',
  completionMeaning: 'Completed or 100% describes the Planning record or its reference calculation; it does not mean work is currently executing.',
  linkageMeaning: 'Task and schedule links are references. Pipeline and Runtime Schedule remain their execution sources of truth.'
});
class PlanningError extends Error {
  constructor(message, { status = 400, code = 'PLANNING_ERROR' } = {}) {
    super(message);
    this.name = 'PlanningError';
    this.status = status;
    this.code = code;
  }
}
function cleanString(value, field, max = 8000, required = false) {
  const text = String(value == null ? '' : value).trim();
  if (required && !text) {
    throw new PlanningError(`${field} is required`, { code: 'INVALID_PLANNING_INPUT' });
  }
  if (text.length > max) {
    throw new PlanningError(`${field} exceeds ${max} characters`, { code: 'INVALID_PLANNING_INPUT' });
  }
  return text;
}
function cleanEnum(value, field, allowed, fallback) {
  if (value == null || value === '') return fallback;
  const normalized = String(value);
  if (!allowed.includes(normalized)) {
    throw new PlanningError(`${field} must be one of ${allowed.join('|')}`, {
      code: 'INVALID_PLANNING_INPUT'
    });
  }
  return normalized;
}
function assertStatusForType(type, status) {
  const allowed = PLANNING_STATUS_BY_TYPE[type] || [];
  if (!allowed.includes(status)) {
    throw new PlanningError(
      `status ${status} is not valid for ${type}; use ${allowed.join('|')}`,
      { code: 'INVALID_PLANNING_STATUS' }
    );
  }
}
function cleanDate(value, field) {
  if (value == null || value === '') return null;
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new PlanningError(`${field} must be a valid date`, { code: 'INVALID_PLANNING_INPUT' });
  }
  return date;
}
function cleanNumber(value, field, { min = null, max = null, nullable = true } = {}) {
  if (value == null || value === '') return nullable ? null : 0;
  const number = Number(value);
  if (!Number.isFinite(number)) {
    throw new PlanningError(`${field} must be a number`, { code: 'INVALID_PLANNING_INPUT' });
  }
  if (min != null && number < min) {
    throw new PlanningError(`${field} must be at least ${min}`, { code: 'INVALID_PLANNING_INPUT' });
  }
  if (max != null && number > max) {
    throw new PlanningError(`${field} must be at most ${max}`, { code: 'INVALID_PLANNING_INPUT' });
  }
  return number;
}
function cleanTags(value) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value
    .map((tag) => String(tag || '').trim().toLowerCase())
    .filter(Boolean)
    .slice(0, 30))]
    .map((tag) => tag.slice(0, 80));
}
function cleanUrl(value, field = 'url') {
  const text = cleanString(value, field, 2000);
  if (!text) return '';
  if (text.startsWith('/')) return text;
  let parsed;
  try {
    parsed = new URL(text);
  } catch {
    throw new PlanningError(`${field} must be an http(s) URL or an absolute app path`, {
      code: 'INVALID_PLANNING_INPUT'
    });
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new PlanningError(`${field} must use http or https`, { code: 'INVALID_PLANNING_INPUT' });
  }
  return parsed.toString();
}
function objectId(value, field, { nullable = true } = {}) {
  if (value == null || value === '') {
    if (nullable) return null;
    throw new PlanningError(`${field} is required`, { code: 'INVALID_PLANNING_INPUT' });
  }
  if (!mongoose.isValidObjectId(value)) {
    throw new PlanningError(`${field} is invalid`, { code: 'INVALID_PLANNING_INPUT' });
  }
  return new mongoose.Types.ObjectId(value);
}
function actor(input = {}) {
  return cleanString(input.by || input.actor || 'operator', 'by', 120) || 'operator';
}
function historyEvent(action, input = {}, note = '', metadata = {}) {
  return { action, by: actor(input), note, metadata, at: new Date() };
}
function trimHistory(doc) {
  if (doc.history.length > 100) doc.history = doc.history.slice(-100);
}
function computeMetricProgress(metric = {}) {
  const baseline = Number(metric.baseline);
  const current = Number(metric.current);
  const target = Number(metric.target);
  if (![baseline, current, target].every(Number.isFinite)) return 0;
  if (baseline === target) return current === target ? 100 : 0;
  const raw = metric.direction === 'decrease'
    ? (baseline - current) / (baseline - target)
    : (current - baseline) / (target - baseline);
  return Math.max(0, Math.min(100, Math.round(raw * 100)));
}
function computeTaskProgress(tasks = []) {
  if (!tasks.length) return 0;
  const weights = { queued: 0, blocked: 0.15, in_progress: 0.5, review: 0.85, done: 1 };
  const total = tasks.reduce((sum, task) => sum + (weights[task.status] ?? 0), 0);
  return Math.round((total / tasks.length) * 100);
}
function serialize(value) {
  if (!value) return value;
  const plain = typeof value.toObject === 'function' ? value.toObject() : { ...value };
  plain.id = String(plain._id || plain.id);
  delete plain.__v;
  return plain;
}
function planningIds(task) {
  return (task.planningItemIds || []).map((id) => String(id));
}

function referenceSemanticsFor(item, linkedTasks = []) {
  const mode = item.progress?.mode || 'tasks';
  const progressBasis = item.status === 'completed'
    ? 'recorded_completed_status'
    : ({
      tasks: 'current_state_of_referenced_pipeline_tasks',
      metric: 'recorded_metric_observation',
      manual: 'recorded_manual_value',
      children: 'derived_from_planning_child_records'
    }[mode] || 'recorded_planning_state');
  return {
    lifecycle: PLANNING_REFERENCE_SEMANTICS.lifecycle,
    currentExecution: false,
    statusMeaning: 'historical_record_state',
    progressBasis,
    progressImpliesCurrentExecution: false,
    linkageMeaning: 'reference_only',
    linkedOpenTaskCount: linkedTasks.filter((task) => ACTIVE_TASK_STATUSES.includes(task.status)).length,
    currentExecutionSource: PLANNING_REFERENCE_SEMANTICS.currentExecutionSource
  };
}

function enrichItems(items, tasks, now = new Date(), schedules = []) {
  const rows = items.map(serialize);
  const byId = new Map(rows.map((item) => [item.id, item]));
  const tasksByItem = new Map();
  const childrenByItem = new Map();
  const schedulesBySourceId = new Map(schedules.map((schedule) => [schedule.sourceId, schedule]));

  for (const task of tasks) {
    for (const id of planningIds(task)) {
      if (!tasksByItem.has(id)) tasksByItem.set(id, []);
      tasksByItem.get(id).push(task);
    }
  }
  for (const item of rows) {
    const parentId = item.parentId ? String(item.parentId) : '';
    if (!parentId) continue;
    if (!childrenByItem.has(parentId)) childrenByItem.set(parentId, []);
    childrenByItem.get(parentId).push(item);
  }

  const calculating = new Set();
  function calculate(item) {
    if (Number.isFinite(item.computedProgress)) return item.computedProgress;
    if (calculating.has(item.id)) return 0;
    calculating.add(item.id);
    const linkedTasks = tasksByItem.get(item.id) || [];
    const childItems = childrenByItem.get(item.id) || [];
    const mode = item.progress?.mode || 'tasks';
    let progress = 0;
    if (item.status === 'completed') {
      progress = 100;
    } else if (mode === 'metric') {
      progress = computeMetricProgress(item.progress?.metric || {});
    } else if (mode === 'manual') {
      progress = Math.round(Number(item.progress?.manual) || 0);
    } else if (mode === 'children' || (!linkedTasks.length && childItems.length)) {
      const childProgress = childItems.map(calculate);
      progress = childProgress.length
        ? Math.round(childProgress.reduce((sum, value) => sum + value, 0) / childProgress.length)
        : 0;
    } else {
      progress = computeTaskProgress(linkedTasks);
    }
    calculating.delete(item.id);
    item.computedProgress = Math.max(0, Math.min(100, progress));
    return item.computedProgress;
  }

  for (const item of rows) {
    const linkedTasks = tasksByItem.get(item.id) || [];
    const childItems = childrenByItem.get(item.id) || [];
    item.linkedTasks = linkedTasks.map(serialize);
    item.linkedTaskCount = linkedTasks.length;
    item.childCount = childItems.length;
    item.evidenceCount = (item.evidence || []).length;
    item.isOverdue = Boolean(
      item.type === 'milestone'
      && item.dates?.targetAt
      && !['completed', 'archived'].includes(item.status)
      && isDateOnlyOverdue(item.dates.targetAt, now)
    );
    item.workflowActions = planningWorkflowService.actionsFor(item.type, item.status);
    calculate(item);
    item.referenceSemantics = referenceSemanticsFor(item, linkedTasks);
    const linkedSchedules = (item.scheduleRefs || [])
      .map((ref) => schedulesBySourceId.get(ref.sourceId))
      .filter(Boolean);
    item.health = planningHealthService.derivePlanningHealth(item, { tasks: linkedTasks, schedules: linkedSchedules, now });
    item.progressBreakdown = item.health.progress;
    item.workstream = item.workstreamId ? byId.get(String(item.workstreamId)) || null : null;
  }
  return rows;
}

function buildItemPayload(input = {}, { partial = false } = {}) {
  const payload = {};
  if (!partial || input.type !== undefined) {
    payload.type = cleanEnum(input.type, 'type', PLANNING_TYPES, partial ? undefined : 'workstream');
  }
  if (!partial || input.title !== undefined) {
    payload.title = cleanString(input.title, 'title', 200, !partial);
  }
  if (!partial || input.summary !== undefined) {
    payload.summary = cleanString(input.summary, 'summary', 8000);
  }
  if (!partial || input.status !== undefined) {
    const defaultStatus = planningWorkflowService.initialStatusForType(payload.type);
    payload.status = cleanEnum(input.status, 'status', PLANNING_STATUSES, partial ? undefined : defaultStatus);
  }
  if (!partial || input.priority !== undefined) {
    payload.priority = cleanEnum(input.priority, 'priority', PLANNING_PRIORITIES, partial ? undefined : 'normal');
  }
  if (!partial || input.owner !== undefined) {
    payload.owner = cleanString(input.owner, 'owner', 120);
  }
  if (!partial || input.parentId !== undefined) payload.parentId = objectId(input.parentId, 'parentId');
  if (!partial || input.workstreamId !== undefined) payload.workstreamId = objectId(input.workstreamId, 'workstreamId');
  if (!partial || input.tags !== undefined) payload.tags = cleanTags(input.tags);
  if (!partial || input.dates !== undefined || input.startAt !== undefined || input.targetAt !== undefined) {
    const dates = input.dates || {};
    payload.dates = {};
    if (!partial || dates.startAt !== undefined || input.startAt !== undefined) {
      payload.dates.startAt = cleanDate(dates.startAt ?? input.startAt, 'dates.startAt');
    }
    if (!partial || dates.targetAt !== undefined || input.targetAt !== undefined) {
      payload.dates.targetAt = cleanDate(dates.targetAt ?? input.targetAt, 'dates.targetAt');
    }
    if (!partial || dates.completedAt !== undefined || input.completedAt !== undefined) {
      payload.dates.completedAt = cleanDate(dates.completedAt ?? input.completedAt, 'dates.completedAt');
    }
  }
  if (!partial || input.progress !== undefined) {
    const progress = input.progress || {};
    const metric = progress.metric || {};
    payload.progress = {};
    if (!partial || progress.mode !== undefined) {
      payload.progress.mode = cleanEnum(progress.mode, 'progress.mode', PROGRESS_MODES, 'tasks');
    }
    if (!partial || progress.manual !== undefined) {
      payload.progress.manual = cleanNumber(
        progress.manual,
        'progress.manual',
        { min: 0, max: 100, nullable: false }
      );
    }
    if (!partial || progress.metric !== undefined) {
      payload.progress.metric = {};
      if (!partial || metric.label !== undefined) {
        payload.progress.metric.label = cleanString(metric.label, 'progress.metric.label', 200);
      }
      if (!partial || metric.unit !== undefined) {
        payload.progress.metric.unit = cleanString(metric.unit, 'progress.metric.unit', 40);
      }
      if (!partial || metric.baseline !== undefined) {
        payload.progress.metric.baseline = cleanNumber(metric.baseline, 'progress.metric.baseline');
      }
      if (!partial || metric.current !== undefined) {
        payload.progress.metric.current = cleanNumber(metric.current, 'progress.metric.current');
      }
      if (!partial || metric.target !== undefined) {
        payload.progress.metric.target = cleanNumber(metric.target, 'progress.metric.target');
      }
      if (!partial || metric.direction !== undefined) {
        payload.progress.metric.direction = cleanEnum(
          metric.direction,
          'progress.metric.direction',
          ['increase', 'decrease'],
          'increase'
        );
      }
      if (!partial || metric.sourceRef !== undefined) {
        payload.progress.metric.sourceRef = cleanString(metric.sourceRef, 'progress.metric.sourceRef', 500);
      }
      Object.assign(payload.progress.metric, planningMetricConfigService.cleanMetricAutomation(metric, { partial }));
    }
  }
  if (!partial || input.decision !== undefined) {
    const decision = input.decision || {};
    payload.decision = {};
    if (!partial || decision.context !== undefined) {
      payload.decision.context = cleanString(decision.context, 'decision.context', 8000);
    }
    if (!partial || decision.choice !== undefined) {
      payload.decision.choice = cleanString(decision.choice, 'decision.choice', 8000);
    }
    if (!partial || decision.rationale !== undefined) {
      payload.decision.rationale = cleanString(decision.rationale, 'decision.rationale', 8000);
    }
    if (!partial || decision.alternatives !== undefined) {
      payload.decision.alternatives = Array.isArray(decision.alternatives)
        ? decision.alternatives
          .map((item) => cleanString(item, 'decision.alternatives[]', 1000))
          .filter(Boolean)
          .slice(0, 20)
        : [];
    }
    if (!partial || decision.decidedAt !== undefined) {
      payload.decision.decidedAt = cleanDate(decision.decidedAt, 'decision.decidedAt');
    }
  }
  return payload;
}

async function validateRelations(payload, currentItem = null) {
  if (payload.type === 'workstream') {
    payload.parentId = null;
    payload.workstreamId = null;
    return;
  }
  const currentId = currentItem?._id ? String(currentItem._id) : '';
  if (payload.parentId && String(payload.parentId) === currentId) {
    throw new PlanningError('An item cannot be its own parent', { code: 'INVALID_PLANNING_RELATION' });
  }
  let parent = null;
  if (payload.parentId) {
    parent = await PlanningItem.findOne({ _id: payload.parentId, status: { $ne: 'archived' } }).lean();
    if (!parent) {
      throw new PlanningError('Parent planning item not found', {
        status: 404,
        code: 'PLANNING_PARENT_NOT_FOUND'
      });
    }
  }
  if (payload.workstreamId) {
    const workstream = await PlanningItem.findOne({
      _id: payload.workstreamId,
      type: 'workstream',
      status: { $ne: 'archived' }
    }).lean();
    if (!workstream) {
      throw new PlanningError('Workstream not found', {
        status: 404,
        code: 'PLANNING_WORKSTREAM_NOT_FOUND'
      });
    }
  } else if (parent) {
    payload.workstreamId = parent.type === 'workstream'
      ? parent._id
      : (parent.workstreamId || null);
  }
}

function mergeNestedItemPatch(item, patch) {
  const dates = patch.dates;
  const progress = patch.progress;
  const decision = patch.decision;
  delete patch.dates;
  delete patch.progress;
  delete patch.decision;
  Object.assign(item, patch);
  if (dates) {
    const current = item.dates?.toObject ? item.dates.toObject() : (item.dates || {});
    item.dates = { ...current, ...dates };
  }
  if (progress) {
    const current = item.progress?.toObject ? item.progress.toObject() : (item.progress || {});
    const currentMetric = current.metric || {};
    item.progress = {
      ...current,
      ...progress,
      metric: progress.metric ? { ...currentMetric, ...progress.metric } : currentMetric
    };
  }
  if (decision) {
    const current = item.decision?.toObject ? item.decision.toObject() : (item.decision || {});
    item.decision = { ...current, ...decision };
  }
}

async function requireItem(id) {
  const itemId = objectId(id, 'id', { nullable: false });
  const item = await PlanningItem.findById(itemId);
  if (!item) {
    throw new PlanningError('Planning item not found', { status: 404, code: 'PLANNING_ITEM_NOT_FOUND' });
  }
  return item;
}

async function listItems(filters = {}) {
  const query = {};
  if (filters.type) query.type = cleanEnum(filters.type, 'type', PLANNING_TYPES);
  if (filters.status) query.status = cleanEnum(filters.status, 'status', PLANNING_STATUSES);
  if (filters.workstreamId) query.workstreamId = objectId(filters.workstreamId, 'workstreamId');
  if (!filters.includeArchived && !query.status) query.status = { $ne: 'archived' };
  const items = await PlanningItem.find(query).sort({ priority: 1, 'dates.targetAt': 1, updatedAt: -1 }).lean();
  const tasks = await PipelineTask.find({ planningItemIds: { $exists: true, $ne: [] } })
    .select(TASK_FIELDS).sort({ pipelineId: 1 }).lean();
  return enrichItems(items, tasks);
}

async function getDashboard() {
  const [items, tasks, schedules, upcoming] = await Promise.all([
    PlanningItem.find({ status: { $ne: 'archived' } })
      .sort({ priority: 1, 'dates.targetAt': 1, updatedAt: -1 }).lean(),
    PipelineTask.find({}).select(TASK_FIELDS).sort({ pipelineId: 1 }).lean(),
    ClusterScheduleEntry.find({ enabled: true }).sort({ priority: 1, name: 1 }).lean(),
    clusterScheduleService.getNextTasks(30).catch(() => [])
  ]);
  const enriched = enrichItems(items, tasks, new Date(), schedules);
  const activeTasks = tasks.filter((task) => ACTIVE_TASK_STATUSES.includes(task.status) && task.service !== 'personal' && task.source !== 'idea-drop');
  const visibleItemIds = new Set(enriched.map((item) => item.id));
  const unlinkedTasks = activeTasks
    .filter((task) => !planningIds(task).some((id) => visibleItemIds.has(id)))
    .map(serialize);
  const counts = Object.fromEntries(PLANNING_TYPES.map((type) => [
    type,
    enriched.filter((item) => item.type === type).length
  ]));
  const summary = {
    ...counts,
    active: enriched.filter((item) => ['active', 'planned'].includes(item.status)).length,
    atRisk: enriched.filter((item) => ['at_risk', 'blocked'].includes(item.status) || item.isOverdue).length,
    ideaInbox: enriched.filter((item) => item.type === 'idea' && item.status === 'inbox').length,
    overdueMilestones: enriched.filter((item) => item.isOverdue).length,
    unlinkedTasks: unlinkedTasks.length,
    activeTasks: activeTasks.length,
    schedules: schedules.length
  };
  return {
    referenceSemantics: PLANNING_REFERENCE_SEMANTICS,
    summary,
    items: enriched,
    tasks: activeTasks.map(serialize),
    unlinkedTasks,
    schedules: schedules.map(serialize),
    upcoming
  };
}

async function getItemDetail(id) {
  const item = await requireItem(id);
  const [tasks, schedules, workstream] = await Promise.all([
    PipelineTask.find({ planningItemIds: item._id }).select(TASK_FIELDS).sort({ pipelineId: 1 }).lean(),
    ClusterScheduleEntry.find({
      sourceId: { $in: (item.scheduleRefs || []).map((ref) => ref.sourceId) }
    }).sort({ priority: 1, name: 1 }).lean(),
    item.workstreamId ? PlanningItem.findById(item.workstreamId).lean() : Promise.resolve(null)
  ]);
  const enriched = enrichItems([item, workstream].filter(Boolean), tasks, new Date(), schedules);
  const detailItem = enriched.find((row) => row.id === String(item._id));
  return {
    item: detailItem,
    tasks: tasks.map(serialize),
    schedules: schedules.map(serialize)
  };
}

async function createItem(input = {}) {
  const payload = buildItemPayload(input);
  assertStatusForType(payload.type, payload.status);
  const initialStatus = planningWorkflowService.initialStatusForType(payload.type);
  if (payload.status !== initialStatus) {
    throw new PlanningError(
      `${payload.type} must be created in ${initialStatus}; use a workflow action to advance it`,
      { code: 'INVALID_PLANNING_INITIAL_STATUS' }
    );
  }
  await validateRelations(payload);
  payload.history = [historyEvent('created', input, 'Planning item created')];
  const item = await PlanningItem.create(payload);
  return serialize(item);
}

async function updateItem(id, input = {}) {
  const item = await requireItem(id);
  const patch = buildItemPayload(input, { partial: true });
  const requestedStatus = patch.status;
  delete patch.status;
  assertStatusForType(patch.type || item.type, requestedStatus || item.status);
  await validateRelations({ ...patch, type: patch.type || item.type }, item);
  const hasFieldUpdates = Object.keys(patch).length > 0;
  mergeNestedItemPatch(item, patch);
  if (requestedStatus && requestedStatus !== item.status) {
    const action = cleanString(input.action, 'action', 80)
      || planningWorkflowService.inferAction(item.type, item.status, requestedStatus);
    await planningTransitionService.applyWorkflowAction(
      item,
      action,
      input,
      { expectedStatus: requestedStatus }
    );
  } else if (hasFieldUpdates) {
    item.history.push(historyEvent('updated', input, cleanString(input.note, 'note', 1000)));
  }
  trimHistory(item);
  await item.save();
  return serialize(item);
}

async function archiveItem(id, input = {}) {
  const item = await requireItem(id);
  if (item.status !== 'archived') {
    const fromStatus = item.status;
    item.status = 'archived';
    item.archivedAt = new Date();
    item.history.push(historyEvent(
      'archived',
      input,
      input.note || 'Archived from Planning',
      { fromStatus, toStatus: 'archived' }
    ));
    trimHistory(item);
    await item.save();
  }
  return serialize(item);
}

async function transitionItem(id, action, input = {}) {
  const item = await requireItem(id);
  await planningTransitionService.applyWorkflowAction(
    item,
    cleanString(action, 'action', 80, true),
    input
  );
  trimHistory(item);
  await item.save();
  return serialize(item);
}

async function linkTask(id, pipelineId, input = {}) {
  const item = await requireItem(id);
  if (item.status === 'archived') {
    throw new PlanningError('Archived items cannot receive task links', {
      code: 'PLANNING_ITEM_ARCHIVED'
    });
  }
  const pid = cleanString(pipelineId, 'pipelineId', 20, true);
  const task = await PipelineTask.findOneAndUpdate(
    { pipelineId: pid },
    { $addToSet: { planningItemIds: item._id } },
    { new: true }
  );
  if (!task) {
    throw new PlanningError('Pipeline task not found', { status: 404, code: 'PIPELINE_TASK_NOT_FOUND' });
  }
  item.history.push(historyEvent('task_linked', input, `Linked pipeline task ${pid}`, { pipelineId: pid }));
  trimHistory(item);
  await item.save();
  return { item: serialize(item), task: serialize(task) };
}

async function unlinkTask(id, pipelineId, input = {}) {
  const item = await requireItem(id);
  const pid = cleanString(pipelineId, 'pipelineId', 20, true);
  const task = await PipelineTask.findOneAndUpdate(
    { pipelineId: pid },
    { $pull: { planningItemIds: item._id } },
    { new: true }
  );
  if (!task) {
    throw new PlanningError('Pipeline task not found', { status: 404, code: 'PIPELINE_TASK_NOT_FOUND' });
  }
  item.history.push(historyEvent('task_unlinked', input, `Unlinked pipeline task ${pid}`, { pipelineId: pid }));
  trimHistory(item);
  await item.save();
  return { item: serialize(item), task: serialize(task) };
}

async function linkSchedule(id, input = {}) {
  const item = await requireItem(id);
  const sourceId = cleanString(input.sourceId, 'sourceId', 300, true);
  const query = { sourceId };
  if (input.source) query.source = cleanString(input.source, 'source', 80);
  const schedule = await ClusterScheduleEntry.findOne(query).lean();
  if (!schedule) {
    throw new PlanningError('Schedule entry not found', { status: 404, code: 'SCHEDULE_ENTRY_NOT_FOUND' });
  }
  if (!item.scheduleRefs.some((ref) => ref.sourceId === sourceId)) {
    item.scheduleRefs.push({ source: schedule.source, sourceId, label: schedule.name });
    item.history.push(historyEvent('schedule_linked', input, `Linked schedule ${schedule.name}`, { sourceId }));
    trimHistory(item);
    await item.save();
  }
  return { item: serialize(item), schedule: serialize(schedule) };
}

async function unlinkSchedule(id, sourceId, input = {}) {
  const item = await requireItem(id);
  const sid = cleanString(sourceId, 'sourceId', 300, true);
  item.scheduleRefs = item.scheduleRefs.filter((ref) => ref.sourceId !== sid);
  item.history.push(historyEvent('schedule_unlinked', input, `Unlinked schedule ${sid}`, { sourceId: sid }));
  trimHistory(item);
  await item.save();
  return serialize(item);
}

async function addEvidence(id, input = {}) {
  const item = await requireItem(id);
  const evidence = {
    kind: cleanEnum(input.kind, 'kind', [
      'artifact', 'commit', 'task_feedback', 'benchmark', 'alert',
      'document', 'url', 'note', 'schedule_run'
    ], 'note'),
    label: cleanString(input.label, 'label', 200, true),
    ref: cleanString(input.ref, 'ref', 500),
    url: cleanUrl(input.url),
    note: cleanString(input.note, 'note', 4000),
    metadata: input.metadata && typeof input.metadata === 'object' ? input.metadata : {},
    addedBy: actor(input)
  };
  item.evidence.push(evidence);
  item.history.push(historyEvent('evidence_added', input, evidence.label, { kind: evidence.kind, ref: evidence.ref }));
  trimHistory(item);
  await item.save();
  return { item: serialize(item), evidence: serialize(item.evidence[item.evidence.length - 1]) };
}
async function removeEvidence(id, evidenceId, input = {}) {
  const item = await requireItem(id);
  const evidence = item.evidence.id(evidenceId);
  if (!evidence) {
    throw new PlanningError('Evidence not found', { status: 404, code: 'EVIDENCE_NOT_FOUND' });
  }
  const label = evidence.label;
  evidence.deleteOne();
  item.history.push(historyEvent('evidence_removed', input, label));
  trimHistory(item);
  await item.save();
  return serialize(item);
}
async function promoteIdea(id, input = {}) {
  const idea = await requireItem(id);
  if (idea.type !== 'idea') {
    throw new PlanningError('Only ideas can be promoted', { code: 'NOT_AN_IDEA' });
  }
  if (idea.status !== 'triaged') {
    throw new PlanningError('Shape the idea before promoting it',
      { status: 409, code: 'PLANNING_IDEA_NOT_SHAPED' });
  }
  const targetType = cleanEnum(input.targetType, 'targetType',
    ['workstream', 'outcome', 'milestone', 'decision'], 'workstream');
  const promoted = await createItem({
    ...input,
    type: targetType,
    title: input.title || idea.title,
    summary: input.summary || idea.summary,
    status: 'draft',
    priority: input.priority || idea.priority,
    owner: input.owner || idea.owner,
    tags: Array.isArray(input.tags) ? input.tags : idea.tags,
    by: actor(input)
  });
  idea.status = 'promoted';
  idea.promotedTo = promoted.id;
  idea.history.push(historyEvent('promoted', input, `Promoted to ${targetType}`, { promotedTo: promoted.id }));
  trimHistory(idea);
  await idea.save();
  return { idea: serialize(idea), promoted };
}
module.exports = {
  PLANNING_REFERENCE_SEMANTICS,
  PlanningError,
  computeMetricProgress,
  computeTaskProgress,
  referenceSemanticsFor,
  enrichItems,
  listItems,
  getDashboard,
  getItemDetail,
  createItem,
  updateItem,
  archiveItem,
  transitionItem,
  linkTask,
  unlinkTask,
  linkSchedule,
  unlinkSchedule,
  addEvidence,
  removeEvidence,
  promoteIdea
};
