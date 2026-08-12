/**
 * Live grounding for Nestor turns.
 *
 * Keep current operational truth out of durable model memory. Core reads the
 * Mongo-backed pipeline directly and supplies a compact, bounded snapshot to
 * whichever brain answers the turn.
 */

const PipelineTask = require('../../models/PipelineTask');

const PIPELINE_STATUSES = ['queued', 'in_progress', 'review', 'blocked', 'done'];
const ACTIVE_PIPELINE_STATUSES = ['queued', 'in_progress', 'review', 'blocked'];
const DEFAULT_MAX_ACTIVE_TASKS = 40;

function cleanText(value, maxChars = 180) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, maxChars);
}

function emptyCounts() {
  return Object.fromEntries(PIPELINE_STATUSES.map((status) => [status, 0]));
}

async function buildPipelineSnapshot({ maxActiveTasks = DEFAULT_MAX_ACTIVE_TASKS } = {}) {
  const limit = Math.max(1, Math.min(Number(maxActiveTasks) || DEFAULT_MAX_ACTIVE_TASKS, 100));
  const [groupedCounts, activeTasks] = await Promise.all([
    PipelineTask.aggregate([
      { $group: { _id: '$status', count: { $sum: 1 } } }
    ]),
    PipelineTask.find({ status: { $in: ACTIVE_PIPELINE_STATUSES } })
      .select('pipelineId title status assignee priority')
      .sort({ pipelineId: 1 })
      .limit(limit)
      .lean()
  ]);

  const counts = emptyCounts();
  for (const row of groupedCounts || []) {
    if (PIPELINE_STATUSES.includes(row?._id)) counts[row._id] = Number(row.count) || 0;
  }
  const total = PIPELINE_STATUSES.reduce((sum, status) => sum + counts[status], 0);
  const activeCount = ACTIVE_PIPELINE_STATUSES.reduce((sum, status) => sum + counts[status], 0);

  return {
    sourceOfTruth: 'mongodb:pipelinetasks',
    generatedAt: new Date().toISOString(),
    counts,
    total,
    activeCount,
    activeTasks: (activeTasks || []).map((task) => ({
      pipelineId: cleanText(task.pipelineId, 20),
      title: cleanText(task.title),
      status: cleanText(task.status, 24),
      assignee: task.assignee ? cleanText(task.assignee, 80) : null,
      priority: Number(task.priority) || null
    })),
    truncated: activeCount > (activeTasks || []).length
  };
}

function formatPipelineSnapshot(snapshot) {
  if (!snapshot) return '';
  const counts = PIPELINE_STATUSES
    .map((status) => `${status}=${Number(snapshot.counts?.[status]) || 0}`)
    .join(', ');
  const taskLines = (snapshot.activeTasks || []).map((task) => {
    const assignee = task.assignee ? `, assignee=${task.assignee}` : '';
    return `- #${task.pipelineId} [${task.status}${assignee}] ${task.title}`;
  });
  if (snapshot.truncated) taskLines.push('- (active task list truncated)');

  return [
    'AgentX live context (authoritative for current-state claims):',
    `Pipeline source=${snapshot.sourceOfTruth}; generatedAt=${snapshot.generatedAt}`,
    `Pipeline total=${snapshot.total}; active=${snapshot.activeCount}; ${counts}.`,
    'Active pipeline tasks:',
    ...(taskLines.length ? taskLines : ['- none'])
  ].join('\n');
}

module.exports = {
  PIPELINE_STATUSES,
  ACTIVE_PIPELINE_STATUSES,
  buildPipelineSnapshot,
  formatPipelineSnapshot
};
