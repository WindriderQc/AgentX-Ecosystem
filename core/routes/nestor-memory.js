const express = require('express');
const router = express.Router();
const envelope = require('../src/helpers/responseEnvelope');
const { saveMemory, NestorMemoryError } = require('../src/services/nestorMemoryService');

function errorResponse(res, err) {
  const status = err instanceof NestorMemoryError ? err.status : 500;
  return envelope.error(res, status, err.message);
}

router.post('/', async (req, res) => {
  try {
    const memory = await saveMemory(req.body || {});
    return envelope.success(res, { memory });
  } catch (err) {
    return errorResponse(res, err);
  }
});

router.post('/summary', async (req, res) => {
  const body = req.body || {};
  try {
    const memory = await saveMemory({
      ...body,
      text: body.summary || body.text,
      type: 'summary',
    });
    return envelope.success(res, { memory });
  } catch (err) {
    return errorResponse(res, err);
  }
});

module.exports = router;
