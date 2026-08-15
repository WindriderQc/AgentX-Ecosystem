const PlanningItem = require('../../models/PlanningItem');
const PipelineTask = require('../../models/PipelineTask');
const ClusterScheduleEntry = require('../../models/ClusterScheduleEntry');

const NERVE_CENTER_PLAN = {
  key: 'nerve-center-alerting',
  title: 'Nerve Center & Alerting',
  workstream: {
    key: 'agentx:nerve-center-alerting',
    type: 'workstream',
    title: 'Nerve Center & Alerting',
    summary: 'Make AgentX operational state legible, trustworthy, and actionable by joining host/runtime health, routing, alert detection/lifecycle/delivery, and scheduled review in one evidence-backed control plane.',
    priority: 'critical',
    status: 'draft',
    progress: { mode: 'children' },
    tags: ['agentx', 'reference-plan', 'nerve-center-alerting']
  },
  goals: [
    {
      key: 'agentx:nerve-center-alerting:alert-legibility',
      title: 'Alerts explain what happened, where, and how often',
      summary: 'Reach 100% useful active-alert titles/messages with component, last occurrence, and occurrence count.',
      priority: 'critical',
      owner: '',
      status: 'draft',
      progress: {
        mode: 'metric',
        metric: {
          label: 'Legible active alerts',
          unit: '%',
          baseline: 6.7,
          current: 6.7,
          target: 100,
          direction: 'increase',
          sourceRef: '/api/alerts?status=active&limit=100'
        }
      },
      taskRefs: ['0374'],
      evidenceBindings: [{ source: 'pipeline', params: { events: ['feedback', 'review', 'done', 'blocked'] } }],
      evidence: [
        { kind: 'task_feedback', label: 'Alert legibility delivery task', ref: '0374' },
        { kind: 'document', label: 'Default alert rules', ref: 'core/config/default-alert-rules.json' }
      ],
      milestones: [
        'Rule templates and producer context include host/model fingerprints',
        'Nerve Center exposes Where, Count, and Last Seen',
        'Built-ins are deployed/backfilled and new production alerts are verified'
      ]
    },
    {
      key: 'agentx:nerve-center-alerting:lifecycle-delivery',
      title: 'Alert lifecycle and delivery are trustworthy',
      summary: 'Reduce stale active alerts to zero through explicit incident, recurrence, recovery, staleness, and operator-delivery contracts.',
      priority: 'critical',
      owner: '',
      status: 'draft',
      progress: {
        mode: 'metric',
        metric: {
          label: 'Stale active alerts',
          unit: 'count',
          baseline: 7,
          current: 7,
          target: 0,
          direction: 'decrease',
          sourceRef: '/api/alerts?status=active&limit=100',
          adapter: 'alerts.active_count',
          params: { status: 'active', olderThanMs: 86400000 },
          refreshEveryMs: 900000,
          staleAfterMs: 3600000
        }
      },
      taskRefs: ['0361', '0375'],
      scheduleRefs: ['oc-planning-reconcile'],
      evidenceBindings: [
        { source: 'pipeline', params: { events: ['feedback', 'review', 'done', 'blocked'] } },
        { source: 'alerts', params: { events: ['resolved', 'acknowledged'] } },
        { source: 'schedule', params: { events: ['run'] } }
      ],
      evidence: [
        { kind: 'task_feedback', label: 'Alert foundation task', ref: '0327' }
      ],
      milestones: [
        'Define continuous-incident, recurrence, recovery, and staleness semantics',
        'Stop five-minute incident-document churn',
        'Auto-resolve inference host, error, and latency alerts on verified recovery',
        'Configure and prove one operator-facing delivery path',
        'Audit and close stale historical active alerts'
      ]
    },
    {
      key: 'agentx:nerve-center-alerting:real-failover',
      title: 'Primary-route failure produces a real visible fallback',
      summary: 'Make actual request fallback and displayed routing state agree, then prove outage, fallback, recovery, and alert resolution in a supervised drill.',
      priority: 'critical',
      owner: '',
      status: 'draft',
      progress: {
        mode: 'metric',
        metric: {
          label: 'Failover contradictions',
          unit: 'count',
          baseline: 1,
          current: 1,
          target: 0,
          direction: 'decrease',
          sourceRef: '/api/nerve-center/intelligence'
        }
      },
      taskRefs: ['0375'],
      evidenceBindings: [{ source: 'pipeline', params: { events: ['feedback', 'review', 'done', 'blocked'] } }],
      evidence: [
        { kind: 'task_feedback', label: 'Failover foundation', ref: '0328' },
        { kind: 'task_feedback', label: 'Routing-state foundation', ref: '0371' }
      ],
      milestones: [
        'Accept the failover authority/state decision',
        'Make real request fallback and displayed state agree',
        'Auto-resolve related alerts after recovery',
        'Run a supervised primary outage → fallback → recovery drill with evidence'
      ]
    },
    {
      key: 'agentx:nerve-center-alerting:telemetry-coverage',
      title: 'Nerve Center telemetry covers the traffic it displays',
      summary: 'Reach 100% routing analytics coverage for explicitly in-scope routed caller types and surface degraded sources without contradictory healthy summaries.',
      priority: 'high',
      owner: '',
      status: 'draft',
      progress: {
        mode: 'metric',
        metric: {
          label: 'Routing analytics coverage',
          unit: '%',
          baseline: 0,
          current: 0,
          target: 100,
          direction: 'increase',
          sourceRef: '/api/nerve-center/routing/analytics?hours=24'
        }
      },
      taskRefs: ['0376'],
      evidenceBindings: [{ source: 'pipeline', params: { events: ['feedback', 'review', 'done', 'blocked'] } }],
      evidence: [
        { kind: 'task_feedback', label: 'Routing analytics task', ref: '0376' }
      ],
      milestones: [
        'Remove or label the chat-only analytics filter and add caller filtering',
        'Consolidate section polling and performance feeds',
        'Define routing-trace preview/privacy policy',
        'Surface degraded sources instead of contradictory healthy summaries'
      ]
    },
    {
      key: 'agentx:nerve-center-alerting:review-loop',
      title: 'Incidents drive a daily and weekly review loop',
      summary: 'All three operator reports include alerts, health/failover, planning/pipeline risks, metric deltas, evidence, decisions, and next actions.',
      priority: 'high',
      owner: 'leadx',
      status: 'draft',
      progress: {
        mode: 'metric',
        metric: {
          label: 'Scheduled report payload coverage',
          unit: 'reports',
          baseline: 1,
          current: 1,
          target: 3,
          direction: 'increase',
          sourceRef: '/api/reports'
        }
      },
      scheduleRefs: [
        'agentx-morning-briefing',
        'agentx-daily-digest',
        'agentx-weekly-review'
      ],
      evidenceBindings: [{ source: 'schedule', params: { events: ['run'] } }],
      evidence: [
        { kind: 'task_feedback', label: 'Historical report foundation', ref: '0329' }
      ],
      milestones: []
    }
  ],
  decisions: [
    {
      key: 'agentx:nerve-center-alerting:decision:core-control-plane',
      title: 'Keep Nerve Center and the control plane in Core',
      status: 'accepted',
      context: 'The operational control plane needs one service authority.',
      choice: 'Nerve Center/control plane stays in Core; no ControlTower service.',
      rationale: 'This preserves service ownership and avoids a duplicate control plane.'
    },
    {
      key: 'agentx:nerve-center-alerting:decision:plane-ownership',
      title: 'Keep Planning, Pipeline, and Schedule ownership separate',
      status: 'accepted',
      context: 'Intent, delivery state, and runtime cadence are different authorities.',
      choice: 'Planning owns intent/evidence, Pipeline owns delivery, and Cluster Schedule owns cadence and placement.',
      rationale: 'Cross-plane linkage must not duplicate or silently overwrite source records.'
    },
    {
      key: 'agentx:nerve-center-alerting:decision:continuous-incidents',
      title: 'Use one continuous incident per stable fingerprint',
      status: 'accepted',
      context: 'Repeated producer signals currently create incident-document churn.',
      choice: 'One continuous incident per stable fingerprint; recurrence increments it; verified recovery resolves it.',
      rationale: 'A durable incident identity makes occurrence, recovery, and staleness measurable.'
    },
    {
      key: 'agentx:nerve-center-alerting:decision:failover-authority',
      title: 'Derive failover state from actual routing behavior',
      status: 'accepted',
      context: 'Displayed failover state can contradict the path requests actually take.',
      choice: 'Failover state derives from actual routing behavior and persists across process restarts.',
      rationale: 'The control plane must report the real route, not process-local intent.'
    },
    {
      key: 'agentx:nerve-center-alerting:decision:routing-trace-policy',
      title: 'Define routing-trace retention and redaction',
      status: 'accepted',
      context: 'Routing trace previews may include sensitive prompt material.',
      choice: 'Define a retention/redaction policy for routing-trace prompt previews.',
      rationale: 'Operational evidence must remain useful without retaining unnecessary prompt content.'
    }
  ]
};

const REFERENCE_PLANS = {
  [NERVE_CENTER_PLAN.key]: NERVE_CENTER_PLAN
};

function milestoneKey(goal, index) {
  return `${goal.key}:milestone:${String(index + 1).padStart(2, '0')}`;
}

function flattenPlan(plan) {
  const rows = [{ ...plan.workstream }];
  for (const goal of plan.goals) {
    rows.push({
      ...goal,
      type: 'outcome',
      workstreamKey: plan.workstream.key,
      parentKey: plan.workstream.key
    });
    goal.milestones.forEach((title, index) => rows.push({
      key: milestoneKey(goal, index),
      type: 'milestone',
      title,
      summary: title,
      priority: goal.priority,
      owner: '',
      status: 'draft',
      progress: { mode: 'tasks' },
      workstreamKey: plan.workstream.key,
      parentKey: goal.key,
      taskRefs: goal.taskRefs || [],
      scheduleRefs: [],
      evidence: []
    }));
  }
  for (const decision of plan.decisions) {
    rows.push({
      key: decision.key,
      type: 'decision',
      title: decision.title,
      summary: '',
      status: decision.status,
      priority: 'normal',
      workstreamKey: plan.workstream.key,
      parentKey: plan.workstream.key,
      decision: {
        context: decision.context,
        choice: decision.choice,
        rationale: decision.rationale
      },
      tags: ['agentx', 'reference-plan', 'nerve-center-alerting']
    });
  }
  return rows;
}

function catalog() {
  return Object.values(REFERENCE_PLANS).map((plan) => ({
    key: plan.key,
    title: plan.title,
    itemCount: flattenPlan(plan).length
  }));
}

async function inspectPlan(plan) {
  const rows = flattenPlan(plan);
  const keys = rows.map((row) => row.key);
  const taskRefs = [...new Set(rows.flatMap((row) => row.taskRefs || []))];
  const scheduleRefs = [...new Set(rows.flatMap((row) => row.scheduleRefs || []))];
  const [existing, tasks, schedules] = await Promise.all([
    PlanningItem.find({ key: { $in: keys } }).select('key').lean(),
    PipelineTask.find({ pipelineId: { $in: taskRefs } }).select('pipelineId').lean(),
    ClusterScheduleEntry.find({ sourceId: { $in: scheduleRefs } }).select('sourceId').lean()
  ]);
  const existingKeys = new Set(existing.map((row) => row.key));
  const foundTasks = new Set(tasks.map((row) => row.pipelineId));
  const foundSchedules = new Set(schedules.map((row) => row.sourceId));
  return {
    rows,
    existingKeys,
    foundTasks,
    foundSchedules,
    summary: {
      items: rows.length,
      create: rows.filter((row) => !existingKeys.has(row.key)).length,
      reuse: rows.filter((row) => existingKeys.has(row.key)).length,
      availableTasks: taskRefs.filter((ref) => foundTasks.has(ref)),
      missingTasks: taskRefs.filter((ref) => !foundTasks.has(ref)),
      availableSchedules: scheduleRefs.filter((ref) => foundSchedules.has(ref)),
      missingSchedules: scheduleRefs.filter((ref) => !foundSchedules.has(ref))
    }
  };
}

function itemPayload(row, ids, by) {
  return {
    key: row.key,
    type: row.type,
    title: row.title,
    summary: row.summary || '',
    status: row.status || 'draft',
    priority: row.priority || 'normal',
    owner: row.owner || '',
    parentId: row.parentKey ? ids.get(row.parentKey) || null : null,
    workstreamId: row.workstreamKey ? ids.get(row.workstreamKey) || null : null,
    tags: row.tags || ['agentx', 'reference-plan', 'nerve-center-alerting'],
    progress: row.progress || { mode: 'manual', manual: 0 },
    decision: row.decision || {},
    automation: { evidenceBindings: row.evidenceBindings || [] },
    history: [{
      action: 'reference_plan_imported',
      by,
      note: 'Created from the approved Nerve Center & Alerting reference plan',
      metadata: { referencePlan: NERVE_CENTER_PLAN.key }
    }]
  };
}

async function applyPlan(plan, inspection, by) {
  const ids = new Map();
  let itemsCreated = 0;
  let itemsReused = 0;
  let tasksLinked = 0;
  let schedulesLinked = 0;
  let evidenceAdded = 0;
  let evidenceBindingsUpdated = 0;

  for (const row of inspection.rows) {
    let item = await PlanningItem.findOne({ key: row.key });
    if (!item) {
      item = await PlanningItem.create(itemPayload(row, ids, by));
      itemsCreated += 1;
    } else {
      itemsReused += 1;
    }
    ids.set(row.key, item._id);
  }

  for (const row of inspection.rows) {
    const item = await PlanningItem.findById(ids.get(row.key));
    let changed = false;
    const nextBindings = row.evidenceBindings || [];
    const currentBindings = (item.automation?.evidenceBindings || []).map((binding) => ({
      source: binding.source,
      enabled: binding.enabled !== false,
      params: binding.params || {}
    }));
    const normalizedNextBindings = nextBindings.map((binding) => ({
      source: binding.source,
      enabled: binding.enabled !== false,
      params: binding.params || {}
    }));
    if (JSON.stringify(currentBindings) !== JSON.stringify(normalizedNextBindings)) {
      item.set('automation.evidenceBindings', normalizedNextBindings);
      evidenceBindingsUpdated += 1;
      changed = true;
    }
    for (const pipelineId of row.taskRefs || []) {
      const task = await PipelineTask.findOne({ pipelineId });
      if (!task || task.planningItemIds.some((id) => String(id) === String(item._id))) continue;
      task.planningItemIds.push(item._id);
      await task.save();
      tasksLinked += 1;
    }
    for (const sourceId of row.scheduleRefs || []) {
      if (item.scheduleRefs.some((ref) => ref.sourceId === sourceId)) continue;
      const schedule = await ClusterScheduleEntry.findOne({ sourceId }).lean();
      if (!schedule) continue;
      item.scheduleRefs.push({ source: schedule.source, sourceId, label: schedule.name });
      schedulesLinked += 1;
      changed = true;
    }
    for (const evidence of row.evidence || []) {
      const exists = item.evidence.some((entry) =>
        entry.kind === evidence.kind && entry.ref === evidence.ref && entry.label === evidence.label
      );
      if (exists) continue;
      item.evidence.push({ ...evidence, addedBy: by });
      evidenceAdded += 1;
      changed = true;
    }
    if (changed) await item.save();
  }

  return {
    itemsCreated,
    itemsReused,
    tasksLinked,
    schedulesLinked,
    evidenceAdded,
    evidenceBindingsUpdated
  };
}

async function importReferencePlan(key, { dryRun = true, by = 'operator' } = {}) {
  const plan = REFERENCE_PLANS[key];
  if (!plan) {
    const error = new Error(`Unknown Planning reference plan: ${key}`);
    error.status = 404;
    error.code = 'PLANNING_REFERENCE_PLAN_NOT_FOUND';
    throw error;
  }
  const inspection = await inspectPlan(plan);
  if (dryRun) {
    return {
      dryRun: true,
      key: plan.key,
      title: plan.title,
      summary: inspection.summary,
      items: inspection.rows.map((row) => ({
        key: row.key,
        type: row.type,
        title: row.title,
        status: row.status,
        action: inspection.existingKeys.has(row.key) ? 'reuse' : 'create'
      }))
    };
  }
  return {
    dryRun: false,
    key: plan.key,
    title: plan.title,
    summary: inspection.summary,
    ...(await applyPlan(plan, inspection, by))
  };
}

module.exports = {
  NERVE_CENTER_PLAN,
  REFERENCE_PLANS,
  catalog,
  flattenPlan,
  importReferencePlan
};
