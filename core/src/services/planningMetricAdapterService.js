const Alert = require('../../models/Alert');
const PipelineTask = require('../../models/PipelineTask');
const ClusterScheduleEntry = require('../../models/ClusterScheduleEntry');
const planningMetricRegistry = require('./planningMetricRegistry');
const { getBenchmarkServiceClient } = require('./benchmarkServiceClient');

const PIPELINE_WEIGHTS = {
  queued: 0,
  blocked: 0.15,
  in_progress: 0.5,
  review: 0.85,
  done: 1
};
const SUCCESS_STATUSES = new Set(['ok', 'success', 'completed', 'healthy']);

class PlanningMetricSourceError extends Error {
  constructor(message, code = 'PLANNING_METRIC_SOURCE_ERROR') {
    super(message);
    this.name = 'PlanningMetricSourceError';
    this.code = code;
  }
}

function roundedPercent(numerator, denominator) {
  if (!denominator) return 0;
  return Math.max(0, Math.min(100, Math.round((numerator / denominator) * 100)));
}

async function linkedTasks(item) {
  return PipelineTask.find({ planningItemIds: item._id })
    .select('pipelineId status')
    .sort({ pipelineId: 1 })
    .lean();
}

async function pipelineProgress(item) {
  const tasks = await linkedTasks(item);
  const weighted = tasks.reduce((sum, task) => sum + (PIPELINE_WEIGHTS[task.status] ?? 0), 0);
  return {
    value: roundedPercent(weighted, tasks.length),
    metadata: {
      total: tasks.length,
      done: tasks.filter((task) => task.status === 'done').length,
      blocked: tasks.filter((task) => task.status === 'blocked').length,
      review: tasks.filter((task) => task.status === 'review').length
    }
  };
}

async function pipelineDoneRatio(item) {
  const tasks = await linkedTasks(item);
  const done = tasks.filter((task) => task.status === 'done').length;
  return { value: roundedPercent(done, tasks.length), metadata: { total: tasks.length, done } };
}

async function activeAlertCount(params, now) {
  const query = { status: params.status || 'active' };
  if (params.severity) query.severity = params.severity;
  if (params.ruleId) query.ruleId = params.ruleId;
  if (params.component) query['context.component'] = params.component;
  if (params.olderThanMs) {
    query.lastOccurrence = { $lt: new Date(now.getTime() - params.olderThanMs) };
  }
  const count = await Alert.countDocuments(query);
  return { value: count, metadata: { filters: params } };
}

async function linkedSchedules(item) {
  const sourceIds = [...new Set((item.scheduleRefs || []).map((ref) => ref.sourceId).filter(Boolean))];
  if (!sourceIds.length) {
    throw new PlanningMetricSourceError(
      'No linked schedules are available for this metric',
      'PLANNING_METRIC_SOURCE_EMPTY'
    );
  }
  const schedules = await ClusterScheduleEntry.find({ sourceId: { $in: sourceIds } })
    .select('sourceId enabled lastRun metadata')
    .sort({ sourceId: 1 })
    .lean();
  if (!schedules.length) {
    throw new PlanningMetricSourceError(
      'Linked schedule records were not found',
      'PLANNING_METRIC_SOURCE_EMPTY'
    );
  }
  return schedules;
}

async function scheduleSuccessRate(item) {
  const schedules = await linkedSchedules(item);
  const declared = schedules.filter((schedule) =>
    String(schedule.metadata?.lastStatus || schedule.metadata?.lastRunStatus || '').trim()
  );
  if (!declared.length) {
    throw new PlanningMetricSourceError(
      'Linked schedules do not expose a latest run status',
      'PLANNING_METRIC_SOURCE_UNAVAILABLE'
    );
  }
  const successful = declared.filter((schedule) =>
    SUCCESS_STATUSES.has(String(schedule.metadata?.lastStatus || schedule.metadata?.lastRunStatus).toLowerCase())
    && Number(schedule.metadata?.consecutiveErrors || 0) === 0
  ).length;
  return {
    value: roundedPercent(successful, declared.length),
    metadata: { linked: schedules.length, declared: declared.length, successful }
  };
}

async function scheduleConsecutiveErrors(item) {
  const schedules = await linkedSchedules(item);
  const values = schedules.map((schedule) => Number(schedule.metadata?.consecutiveErrors || 0));
  return {
    value: Math.max(...values, 0),
    metadata: { linked: schedules.length, totalErrors: values.reduce((sum, value) => sum + value, 0) }
  };
}

async function benchmarkBatch(params) {
  const client = getBenchmarkServiceClient();
  let batchId = params.batchId || '';
  if (params.tag) {
    const list = await client.getBatches({ tag: params.tag, limit: 1 });
    if (!list) {
      throw new PlanningMetricSourceError(
        'Benchmark service is unavailable',
        'PLANNING_METRIC_SOURCE_UNAVAILABLE'
      );
    }
    const match = (list.batches || []).find((batch) => (batch.tags || []).includes(params.tag));
    batchId = match?._id || match?.id || '';
    if (!batchId) {
      throw new PlanningMetricSourceError(
        `No Benchmark batch found for ${params.tag}`,
        'PLANNING_METRIC_SOURCE_EMPTY'
      );
    }
  }
  const batch = await client.getBatch(batchId);
  if (!batch) {
    throw new PlanningMetricSourceError(
      'Benchmark batch is unavailable',
      'PLANNING_METRIC_SOURCE_UNAVAILABLE'
    );
  }
  return batch;
}

function benchmarkBatchMetadata(batch, params) {
  return {
    batchId: String(batch._id || batch.id || params.batchId || ''),
    tag: params.tag || '',
    status: String(batch.status || ''),
    completed: Number(batch.completed) || 0,
    failed: Number(batch.failed) || 0,
    total: Number(batch.total_tests) || 0
  };
}

async function benchmarkBatchCompletion(params) {
  const batch = await benchmarkBatch(params);
  const completed = Number(batch.completed) || 0;
  const total = Number(batch.total_tests) || 0;
  const value = Number.isFinite(Number(batch.progress))
    ? Number(batch.progress)
    : roundedPercent(completed, total);
  return { value, metadata: benchmarkBatchMetadata(batch, params) };
}

async function benchmarkBatchSuccessRate(params) {
  const batch = await benchmarkBatch(params);
  const completed = Number(batch.completed) || 0;
  const failed = Math.min(completed, Math.max(0, Number(batch.failed) || 0));
  const value = completed
    ? Math.round(((completed - failed) / completed) * 1000) / 10
    : 0;
  return { value, metadata: benchmarkBatchMetadata(batch, params) };
}

async function trustedGeneralistScore(params) {
  const payload = await getBenchmarkServiceClient().getTrustedGeneralistLeaderboard({
    hostScope: params.hostScope
  });
  if (!payload) {
    throw new PlanningMetricSourceError(
      'Benchmark trusted leaderboard is unavailable',
      'PLANNING_METRIC_SOURCE_UNAVAILABLE'
    );
  }
  if (payload.trusted !== true || payload.trustScope !== 'trusted') {
    throw new PlanningMetricSourceError(
      'Benchmark did not return a trusted leaderboard',
      'PLANNING_METRIC_SOURCE_UNAVAILABLE'
    );
  }
  // The current Benchmark consumer projection is Phase 0. It can prove a
  // coherent observation cohort, but it cannot verify the separate judge
  // qualification and human/AIOps ratification attestations. Caller-supplied
  // `qualified` fields therefore remain non-authorizing until that verified
  // bridge exists.
  throw new PlanningMetricSourceError(
    `No receipt-qualified Benchmark winner is available for ${params.model}`,
    'PLANNING_METRIC_SOURCE_UNQUALIFIED'
  );
}

async function execute(adapter, item, { now = new Date() } = {}) {
  const binding = planningMetricRegistry.validateBinding(
    adapter,
    item.progress?.metric?.params || {}
  );
  let result;
  if (binding.adapter === 'pipeline.progress') result = await pipelineProgress(item);
  else if (binding.adapter === 'pipeline.done_ratio') result = await pipelineDoneRatio(item);
  else if (binding.adapter === 'alerts.active_count') {
    result = await activeAlertCount(binding.params, now);
  } else if (binding.adapter === 'schedule.success_rate') {
    result = await scheduleSuccessRate(item);
  } else if (binding.adapter === 'schedule.consecutive_errors') {
    result = await scheduleConsecutiveErrors(item);
  } else if (binding.adapter === 'benchmark.batch_completion') {
    result = await benchmarkBatchCompletion(binding.params);
  } else if (binding.adapter === 'benchmark.batch_success_rate') {
    result = await benchmarkBatchSuccessRate(binding.params);
  } else if (binding.adapter === 'benchmark.trusted_generalist_score') {
    result = await trustedGeneralistScore(binding.params);
  }
  if (!result || !Number.isFinite(Number(result.value))) {
    throw new PlanningMetricSourceError(`Adapter ${adapter} did not produce a numeric value`);
  }
  return {
    adapter,
    value: Number(result.value),
    observedAt: now,
    metadata: result.metadata || {}
  };
}

module.exports = {
  PIPELINE_WEIGHTS,
  SUCCESS_STATUSES,
  PlanningMetricSourceError,
  roundedPercent,
  execute
};
