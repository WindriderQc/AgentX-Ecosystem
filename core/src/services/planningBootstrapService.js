const PlanningItem = require('../../models/PlanningItem');
const PipelineTask = require('../../models/PipelineTask');

const RULES = [
  {
    key: 'nerve-center-alerting',
    title: 'Nerve Center & Alerting',
    summary: 'Make AgentX operational state legible, trustworthy, and actionable.',
    priority: 'critical',
    test: ({ text }) => /\bnerve center\b|\balerts?\b|failover|host-unreachable/.test(text)
  },
  {
    key: 'benchmark-capability',
    title: 'Benchmark Capability',
    summary: 'Improve model evaluation, profiling, grading, and agency qualification.',
    priority: 'high',
    test: ({ service, text }) =>
      service === 'benchmark'
      || /\bbenchmark\b|pass@k|agency suite|profiler|grading|judge/.test(text)
  },
  {
    key: 'knowledge-memory',
    title: 'Knowledge, RAG & Memory',
    summary: 'Keep retrieval, artifacts, embeddings, and durable agent memory healthy.',
    priority: 'high',
    test: ({ service, text }) =>
      service === 'rag'
      || /\brag\b|memory|artifact|embedding|qdrant|knowledge/.test(text)
  },
  {
    key: 'routing-qualification',
    title: 'Model Routing & Qualification',
    summary: 'Qualify safe model lanes and route work according to evidence and capacity.',
    priority: 'high',
    test: ({ text }) =>
      /routing|dispatch|qualification|swap-on-demand|context-headroom|model lane|re-qualify/.test(text)
  },
  {
    key: 'platform-reliability',
    title: 'Platform Reliability & Governance',
    summary: 'Harden AgentX services, governance, security, scheduling, and documentation.',
    priority: 'high',
    test: () => true
  }
];

function taskContext(task) {
  return {
    service: String(task.service || '').toLowerCase(),
    text: [task.title, task.service, task.epic, task.source]
      .join(' ')
      .toLowerCase()
  };
}

function chooseRule(task) {
  const context = taskContext(task);
  return RULES.find((rule) => rule.test(context)) || RULES[RULES.length - 1];
}

function groupTasks(tasks, { includeEmpty = false } = {}) {
  const groups = new Map();
  for (const task of tasks) {
    if (task.service === 'personal' || task.source === 'idea-drop') continue;
    const rule = chooseRule(task);
    if (!groups.has(rule.key)) groups.set(rule.key, { ...rule, tasks: [] });
    groups.get(rule.key).tasks.push(task);
  }
  if (includeEmpty) {
    for (const rule of RULES) {
      if (!groups.has(rule.key)) groups.set(rule.key, { ...rule, tasks: [] });
    }
  }
  return RULES
    .filter((rule) => groups.has(rule.key))
    .map((rule) => groups.get(rule.key));
}

async function previewBootstrap({ includeEmpty = false } = {}) {
  const activeItems = await PlanningItem.find({ status: { $ne: 'archived' } }).select('_id').lean();
  const activeItemIds = new Set(activeItems.map((item) => String(item._id)));
  const tasks = await PipelineTask.find({
    status: { $in: ['queued', 'in_progress', 'review', 'blocked'] }
  }).sort({ pipelineId: 1 }).lean();
  const unlinked = tasks.filter((task) =>
    !(task.planningItemIds || []).some((id) => activeItemIds.has(String(id)))
  );
  return groupTasks(unlinked, { includeEmpty }).map((group) => ({
    key: group.key,
    title: group.title,
    summary: group.summary,
    priority: group.priority,
    taskCount: group.tasks.length,
    tasks: group.tasks.map((task) => ({
      pipelineId: task.pipelineId,
      title: task.title,
      service: task.service,
      status: task.status
    }))
  }));
}

async function bootstrapFromPipeline({ by = 'operator', dryRun = false, includeEmpty = false } = {}) {
  const groups = await previewBootstrap({ includeEmpty });
  if (dryRun) {
    return {
      dryRun: true,
      groups,
      workstreamsCreated: 0,
      tasksLinked: 0
    };
  }

  let workstreamsCreated = 0;
  let workstreamsReused = 0;
  let tasksLinked = 0;
  const results = [];

  for (const group of groups) {
    const key = `agentx:${group.key}`;
    let workstream = await PlanningItem.findOne({ key });
    if (!workstream) {
      workstream = await PlanningItem.create({
        key,
        type: 'workstream',
        title: group.title,
        summary: group.summary,
        status: 'draft',
        priority: group.priority,
        progress: { mode: 'tasks' },
        tags: ['agentx', 'pipeline-bootstrap', group.key],
        history: [{
          action: 'created',
          by,
          note: 'Created by deterministic pipeline organizer',
          metadata: { bootstrapKey: group.key }
        }]
      });
      workstreamsCreated += 1;
    } else {
      workstreamsReused += 1;
    }

    const pipelineIds = group.tasks.map((task) => task.pipelineId);
    const update = await PipelineTask.updateMany(
      { pipelineId: { $in: pipelineIds } },
      { $addToSet: { planningItemIds: workstream._id } }
    );
    const linked = update.modifiedCount || 0;
    tasksLinked += linked;
    workstream.history.push({
      action: 'pipeline_organized',
      by,
      note: `Linked ${linked} open pipeline task(s)`,
      metadata: { pipelineIds }
    });
    if (workstream.history.length > 100) workstream.history = workstream.history.slice(-100);
    await workstream.save();
    results.push({
      key: group.key,
      workstreamId: String(workstream._id),
      title: workstream.title,
      taskCount: pipelineIds.length,
      tasksLinked: linked
    });
  }

  return {
    dryRun: false,
    groups: results,
    workstreamsCreated,
    workstreamsReused,
    tasksLinked
  };
}

module.exports = {
  RULES,
  chooseRule,
  groupTasks,
  previewBootstrap,
  bootstrapFromPipeline
};
