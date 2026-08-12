const express = require('express');
const router = express.Router();
const { handleMcpMessage } = require('../src/services/mcpSkillBus');
const { tokenAllowed } = require('../src/helpers/mcpToken');

router.post('/', async (req, res) => {
  if (!tokenAllowed(req)) {
    return res.status(401).json({
      jsonrpc: '2.0',
      id: req.body?.id ?? null,
      error: { code: -32001, message: 'Unauthorized' },
    });
  }

  if (Array.isArray(req.body)) {
    return res.status(400).json({
      jsonrpc: '2.0',
      id: null,
      error: { code: -32600, message: 'Batch JSON-RPC is not supported by this MCP endpoint' },
    });
  }

  try {
    const response = await handleMcpMessage(req.body || {});
    if (!response) return res.status(202).end();
    return res.type('application/json').json(response);
  } catch (err) {
    return res.status(500).json({
      jsonrpc: '2.0',
      id: req.body?.id ?? null,
      error: { code: -32603, message: err.message || 'Internal error' },
    });
  }
});

router.get('/', (_req, res) => {
  res.status(405).set('Allow', 'POST').json({
    jsonrpc: '2.0',
    id: null,
    error: { code: -32000, message: 'SSE stream is not supported; use POST for Streamable HTTP requests' },
  });
});

module.exports = router;
