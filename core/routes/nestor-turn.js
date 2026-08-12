/**
 * Nestor turn API: complete front door plus explicit local Answer-Light lane.
 *
 *   POST /api/nestor/turn         — run one user turn through the Nestor brain
 *   POST /api/nestor/turn/stream  — stream assistant text + speakable sentences
 *   GET  /api/nestor/turn/health  — brain reachability + configuration
 *
 * Any surface (voice console, Surface panel, desktop app, scripts) calls the
 * same endpoint and receives one conversation id and timing envelope. The
 * default lane remains OpenClaw `main`; local execution is caller-selected.
 */

const express = require('express');
const envelope = require('../src/helpers/responseEnvelope');
const logger = require('../config/logger');
const {
  NestorTurnError,
  runTurn,
  runTurnStream,
  NESTOR_AGENT_ID,
  NESTOR_TURN_LANES,
  NESTOR_ANSWER_LIGHT_TASK
} = require('../src/services/nestorTurnService');
const {
  getOpenClawClient,
  isOpenClawIntegrationEnabled
} = require('../src/services/openclawClient');

const router = express.Router();

function writeSse(res, event, data) {
  if (res.destroyed || res.writableEnded) return;
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(data)}\n\n`);
  res.flush?.();
}

router.post('/stream', async (req, res) => {
  const controller = new AbortController();
  const onClose = () => controller.abort();
  res.once('close', onClose);
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-store',
    Connection: 'keep-alive',
    'Content-Encoding': 'identity',
    'X-Accel-Buffering': 'no'
  });
  res.flushHeaders?.();
  res.write('retry: 3000\n\n');
  const keepalive = setInterval(() => {
    if (!res.destroyed && !res.writableEnded) res.write(': keepalive\n\n');
  }, 15000);

  try {
    const body = req.body || {};
    const result = await runTurnStream({
      text: body.text,
      conversationId: body.conversationId,
      traceId: body.traceId,
      surface: body.surface,
      lane: body.lane,
      timeoutMs: body.timeoutMs
    }, {
      signal: controller.signal,
      onStart: (data) => writeSse(res, 'meta', data),
      onDelta: (data) => writeSse(res, 'delta', data),
      onSentence: (data) => writeSse(res, 'sentence', data)
    });
    writeSse(res, 'done', result);
  } catch (err) {
    if (!controller.signal.aborted) {
      const status = err instanceof NestorTurnError ? err.status : 502;
      if (!(err instanceof NestorTurnError)) {
        logger.error('Nestor streaming turn failed', { error: err.message });
      }
      writeSse(res, 'error', {
        status,
        message: err.message || 'Nestor streaming turn failed',
        code: err.code || 'NESTOR_TURN_STREAM_ERROR'
      });
    }
  } finally {
    clearInterval(keepalive);
    res.off('close', onClose);
    if (!res.writableEnded && !res.destroyed) res.end();
  }
});

router.post('/', async (req, res) => {
  try {
    const body = req.body || {};
    const result = await runTurn({
      text: body.text,
      conversationId: body.conversationId,
      traceId: body.traceId,
      surface: body.surface,
      lane: body.lane,
      timeoutMs: body.timeoutMs
    });
    return envelope.success(res, result);
  } catch (err) {
    if (err instanceof NestorTurnError) {
      return envelope.error(res, err.status || 500, err.message, err.code);
    }
    logger.error('Nestor turn failed', { error: err.message });
    return envelope.error(res, 502, err.message || 'Nestor turn failed', 'NESTOR_TURN_ERROR');
  }
});

router.get('/health', async (_req, res) => {
  try {
    const enabled = isOpenClawIntegrationEnabled();
    const gateway = enabled ? await getOpenClawClient().healthCheck() : { ok: false, disabled: true };
    return envelope.success(res, {
      enabled,
      agent: NESTOR_AGENT_ID,
      gateway,
      fallback: 'local-inference',
      lanes: {
        default: NESTOR_TURN_LANES.FRONT_DOOR,
        supported: Object.values(NESTOR_TURN_LANES),
        answerLightTask: NESTOR_ANSWER_LIGHT_TASK
      }
    });
  } catch (err) {
    return envelope.error(res, 500, err.message, 'NESTOR_TURN_HEALTH_ERROR');
  }
});

module.exports = router;
