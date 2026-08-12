/**
 * Secretary lane HTTP API (task 0457) — Nestor's "adjointe administrative".
 *
 *   POST   /api/secretary/tasks              — add a personal task
 *   GET    /api/secretary/tasks              — list (urgent first)
 *   POST   /api/secretary/tasks/complete     — complete by id or title phrase
 *
 * Same surface Nestor reaches over MCP, exposed over HTTP so the voice
 * console, the Surface panel, and smoke tests can drive it directly.
 */

const express = require('express');
const envelope = require('../src/helpers/responseEnvelope');
const logger = require('../config/logger');
const {
  SecretaryError,
  addPersonalTask,
  listPersonalTasks,
  completePersonalTask
} = require('../src/services/secretaryService');

const router = express.Router();

function fail(res, err, context) {
  if (err instanceof SecretaryError) {
    const body = { status: 'error', message: err.message, code: err.code };
    if (err.details) body.details = err.details;
    return res.status(err.status || 400).json(body);
  }
  logger.error('Secretary request failed', { context, error: err.message });
  return envelope.error(res, 500, err.message || 'Secretary request failed', 'SECRETARY_ERROR');
}

router.post('/tasks', async (req, res) => {
  try {
    const task = await addPersonalTask(req.body || {});
    return envelope.success(res, { task }, null, 201);
  } catch (err) {
    return fail(res, err, 'add');
  }
});

router.get('/tasks', async (req, res) => {
  try {
    const result = await listPersonalTasks({
      includeDone: String(req.query.includeDone || '') === 'true',
      limit: req.query.limit
    });
    return envelope.success(res, result);
  } catch (err) {
    return fail(res, err, 'list');
  }
});

router.post('/tasks/complete', async (req, res) => {
  try {
    const result = await completePersonalTask(req.body || {});
    return envelope.success(res, result);
  } catch (err) {
    return fail(res, err, 'complete');
  }
});

module.exports = router;
