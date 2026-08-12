const express = require('express');
const router = express.Router();
const envelope = require('../src/helpers/responseEnvelope');
// Cutover 2026-06-26: the task pipeline is MongoDB, not git files. This legacy
// endpoint now creates a Mongo task (alias of POST /api/pipeline/tasks) instead
// of writing a TODO/*.md + ROADMAP entry. Kept for backward compatibility.
const { createTaskInMongo } = require('../src/services/pipelineTaskService');

router.post('/', async (req, res) => {
  try {
    const task = await createTaskInMongo(req.body || {});
    return envelope.success(res, { task }, null, 201);
  } catch (err) {
    return envelope.error(res, err.status || 400, err.message, err.code);
  }
});

module.exports = router;
