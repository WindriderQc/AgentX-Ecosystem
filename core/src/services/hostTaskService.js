'use strict';
const HostTask = require('../../models/HostTask');
const logger = require('../../config/logger');

const VALID_TASK_TYPES = [
  'ollama.pull', 'ollama.delete', 'ollama.restart',
  'ollama.setEnv', 'ollama.unloadAll',
  'nvidia.smi', 'diag.ping'
];

async function createTask(hostId, type, params = {}) {
  if (!VALID_TASK_TYPES.includes(type)) {
    throw new Error(`Unknown task type: ${type}`);
  }
  const task = await HostTask.create({ hostId, type, params, status: 'pending' });
  logger.info('[HostTask] created', { hostId, type, taskId: task._id });
  return task;
}

async function getPendingTasks(hostId) {
  return HostTask.find({ hostId, status: 'pending' })
    .sort({ createdAt: 1 })
    .limit(10)
    .lean();
}

async function dispatchTasks(hostId) {
  const pending = await HostTask.find({ hostId, status: 'pending' })
    .sort({ createdAt: 1 })
    .limit(1)
    .lean();

  if (pending.length === 0) return [];

  const ids = pending.map(t => t._id);
  await HostTask.updateMany({ _id: { $in: ids } }, { $set: { status: 'dispatched', dispatchedAt: new Date() } });

  return pending.map(t => ({ id: t._id.toString(), type: t.type, params: t.params }));
}

async function processTaskResults(results) {
  for (const r of results) {
    await HostTask.findByIdAndUpdate(r.taskId, {
      status: r.status === 'completed' ? 'completed' : 'failed',
      result: r.result || null,
      completedAt: new Date()
    });
    logger.info('[HostTask] result', { taskId: r.taskId, status: r.status });
  }
}

async function getTasksForHost(hostId, { status, limit = 20 } = {}) {
  const query = { hostId };
  if (status) query.status = status;
  return HostTask.find(query).sort({ createdAt: -1 }).limit(limit).lean();
}

module.exports = { createTask, getPendingTasks, dispatchTasks, processTaskResults, getTasksForHost };
