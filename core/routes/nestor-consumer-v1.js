'use strict';

const express = require('express');
const envelope = require('../src/helpers/responseEnvelope');
const logger = require('../config/logger');
const { operatorAccessAllowed } = require('../src/middleware/operatorAccess');
const buddyEvents = require('../src/services/buddyEvents');
const panelService = require('../src/services/panelService');
const { getCapabilities } = require('../src/services/nestorConsumerCapabilitiesService');
const {
  exportLegacyProfile,
  exportLegacyProfileV1,
  getMigrationNotesPage,
} = require('../src/services/nestorConsumerProfileService');
const { executeInference, getRouterSnapshot } = require('../src/services/nestorConsumerRuntimeService');
const { getMemoryStatus, searchMemory } = require('../src/services/nestorConsumerMemoryService');
const {
  getPersonalitySources,
  resolvePersonalityCandidate,
} = require('../src/services/nestorConsumerPersonalityService');
const { getNestorMetrics } = require('../src/services/nestorConsumerMetricsService');
const { NestorConsumerError } = require('../src/services/nestorConsumerContract');

function sendError(res, error) {
  const statusCode = Number(error.statusCode) || 500;
  if (statusCode >= 500) logger.error('[NestorConsumerV1] request failed', { error: error.message });
  const body = {
    ok: false,
    status: 'error',
    error: error.message,
    message: error.message,
    code: error.code || 'NESTOR_CONSUMER_ERROR',
  };
  if (error.details) body.details = error.details;
  return res.status(statusCode).json(body);
}

function asyncRoute(handler) {
  return async (req, res) => {
    try {
      await handler(req, res);
    } catch (error) {
      sendError(res, error);
    }
  };
}

function requireMigrationAccess(req, res, next) {
  res.set('Cache-Control', 'no-store');
  if (operatorAccessAllowed(req)) return next();
  return sendError(res, new NestorConsumerError(
    'Nestor migration export requires loopback access or a valid AgentX operator token.',
    403,
    'NESTOR_MIGRATION_OPERATOR_TOKEN_REQUIRED'
  ));
}

function writePlatformEvent(res, event) {
  res.write(`id: ${event.id}\n`);
  res.write('event: platform\n');
  res.write(`data: ${JSON.stringify(event)}\n\n`);
}

function createNestorConsumerV1Routes({ systemHealth } = {}) {
  const router = express.Router();

  router.get('/capabilities', asyncRoute(async (_req, res) => {
    envelope.success(res, await getCapabilities({ systemHealth }));
  }));

  router.get('/migration/profile', requireMigrationAccess, asyncRoute(async (req, res) => {
    const includeRawNotes = ['1', 'true'].includes(String(req.query.includeRawNotes || '').toLowerCase());
    const schemaVersion = String(req.query.schemaVersion || '1').trim();
    if (!['1', '2'].includes(schemaVersion)) {
      throw new NestorConsumerError(
        'schemaVersion must be 1 or 2',
        400,
        'NESTOR_MIGRATION_UNSUPPORTED_SCHEMA'
      );
    }
    res.set('Cache-Control', 'no-store');
    const exportProfile = schemaVersion === '2' ? exportLegacyProfile : exportLegacyProfileV1;
    envelope.success(res, await exportProfile({ includeRawNotes }));
  }));

  router.get('/migration/notes', requireMigrationAccess, asyncRoute(async (req, res) => {
    res.set('Cache-Control', 'no-store');
    envelope.success(res, await getMigrationNotesPage({
      snapshotId: req.query.snapshotId,
      offset: req.query.offset,
      limit: req.query.limit,
    }));
  }));

  router.get('/router', asyncRoute(async (_req, res) => {
    res.set('Cache-Control', 'no-store');
    envelope.success(res, await getRouterSnapshot());
  }));

  router.post('/inference', asyncRoute(async (req, res) => {
    res.set('Cache-Control', 'no-store');
    envelope.success(res, await executeInference(req.body));
  }));

  router.get('/memory/status', asyncRoute(async (req, res) => {
    const sources = req.query.source || req.query.sources;
    envelope.success(res, await getMemoryStatus(sources));
  }));

  router.post('/memory/search', asyncRoute(async (req, res) => {
    envelope.success(res, await searchMemory(req.body));
  }));

  router.get('/personality/sources', asyncRoute(async (_req, res) => {
    envelope.success(res, await getPersonalitySources());
  }));

  router.post('/personality/resolve', asyncRoute(async (req, res) => {
    envelope.success(res, await resolvePersonalityCandidate(req.body));
  }));

  router.get('/metrics', asyncRoute(async (req, res) => {
    res.set('Cache-Control', 'no-store');
    envelope.success(res, await getNestorMetrics({
      hours: req.query.hours,
      taskType: req.query.taskType,
    }));
  }));

  router.get('/events/stream', (req, res) => {
    const cursor = String(req.query.cursor || req.get('last-event-id') || '').trim().slice(0, 200);
    const replay = buddyEvents.getEventsAfter(cursor, 200);
    req.socket?.setTimeout?.(0);
    req.socket?.setNoDelay?.(true);
    req.socket?.setKeepAlive?.(true);

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-store',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
      'Content-Encoding': 'identity',
      'X-AgentX-Event-Replay': 'memory',
      'X-AgentX-Replay-Cursor-Found': String(replay.cursorFound),
    });
    res.flushHeaders?.();
    res.write('retry: 5000\n\n');
    if (cursor && !replay.cursorFound) res.write(': requested cursor is no longer in the in-memory replay window\n\n');
    replay.events.forEach((event) => writePlatformEvent(res, event));

    const keepalive = setInterval(() => res.write(': keepalive\n\n'), 30000);
    const onEvent = (event) => writePlatformEvent(res, event);
    buddyEvents.bus.on('buddy-event', onEvent);

    req.on('close', () => {
      clearInterval(keepalive);
      buddyEvents.bus.off('buddy-event', onEvent);
    });
  });

  router.get('/panel-summary', asyncRoute(async (_req, res) => {
    res.set('Cache-Control', 'no-store');
    envelope.success(res, await panelService.getPanelStatus(systemHealth));
  }));

  return router;
}

module.exports = createNestorConsumerV1Routes;
module.exports.sendError = sendError;
