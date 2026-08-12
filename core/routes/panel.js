const express = require('express');
const envelope = require('../src/helpers/responseEnvelope');
const panelService = require('../src/services/panelService');

function createPanelRouter({ systemHealth } = {}) {
  const router = express.Router();

  router.get('/status', async (_req, res) => {
    try {
      return envelope.success(res, await panelService.getPanelStatus(systemHealth));
    } catch (err) {
      return envelope.error(res, 500, err.message || 'Panel status unavailable', 'PANEL_STATUS_ERROR');
    }
  });

  router.post('/heartbeat', (req, res) => {
    try {
      const heartbeat = panelService.recordHeartbeat(req.body || {}, req);
      return envelope.success(res, { heartbeat });
    } catch (err) {
      return envelope.error(res, 400, err.message || 'Invalid panel heartbeat', 'PANEL_HEARTBEAT_ERROR');
    }
  });

  router.get('/home', async (req, res) => {
    try {
      return envelope.success(res, {
        home: await panelService.getHomeAssistantSnapshot({ limit: req.query.limit })
      });
    } catch (err) {
      return envelope.error(res, 500, err.message || 'Home Assistant status unavailable', 'PANEL_HOME_ERROR');
    }
  });

  return router;
}

module.exports = createPanelRouter;
