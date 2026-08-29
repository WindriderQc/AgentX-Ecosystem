'use strict';

const express = require('express');
const { StringDecoder } = require('string_decoder');
const envelope = require('../src/helpers/responseEnvelope');
const logger = require('../config/logger');
const { sanitizePublicProjection: sanitizePublicValue } = require('../../shared/publicProjection');
const buddyEvents = require('../src/services/buddyEvents');
const { getCapabilities } = require('../src/services/nestorConsumerCapabilitiesService');
const { executeInference, getRouterSnapshot } = require('../src/services/nestorConsumerRuntimeService');
const { getMemoryStatus, searchMemory } = require('../src/services/nestorConsumerMemoryService');
const { getNestorMetrics } = require('../src/services/nestorConsumerMetricsService');
const { CONTRACT_VERSION, LIMITS } = require('../src/services/nestorConsumerContract');

function sendError(res, error) {
  const statusCode = Number(error.statusCode) || 500;
  if (statusCode >= 500) logger.error('[NestorConsumerV1] request failed', { error: error.message });
  const message = statusCode >= 500
    ? 'Nestor consumer request failed.'
    : sanitizePublicValue(error.message || 'Nestor consumer request failed.');
  const body = {
    ok: false,
    status: 'error',
    error: message,
    message,
    code: error.code || 'NESTOR_CONSUMER_ERROR',
  };
  if (statusCode < 500 && error.details) body.details = sanitizePublicValue(error.details);
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

function writePlatformEvent(res, event) {
  res.write(`id: ${event.id}\n`);
  res.write('event: platform\n');
  res.write(`data: ${JSON.stringify(event)}\n\n`);
}

function writeSse(res, event, data) {
  return res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

function waitForDrain(res) {
  if (!res.writableNeedDrain || res.destroyed) return Promise.resolve();
  return new Promise((resolve) => {
    const finish = () => {
      res.off('drain', finish);
      res.off('close', finish);
      resolve();
    };
    res.once('drain', finish);
    res.once('close', finish);
  });
}

function createDisconnectSignal(req, res) {
  const controller = new AbortController();
  let complete = false;
  const cancel = () => {
    if (!complete && !controller.signal.aborted) {
      controller.abort(new Error('Nestor consumer disconnected'));
    }
  };
  req.once('aborted', cancel);
  res.once('close', cancel);
  return {
    signal: controller.signal,
    complete() {
      complete = true;
      req.off('aborted', cancel);
      res.off('close', cancel);
    },
  };
}

async function relayInferenceStream(stream, res, identity) {
  const decoder = new StringDecoder('utf8');
  let buffer = '';
  let terminal = false;
  let reply = '';
  let usage = { promptTokens: 0, completionTokens: 0 };

  const emit = async (event, data) => {
    if (res.destroyed || res.writableEnded) return;
    writeSse(res, event, data);
    await waitForDrain(res);
  };

  const fail = async (code, message) => {
    if (terminal) return;
    terminal = true;
    await emit('error', { code, message });
  };

  const processLine = async (line) => {
    if (!line.trim() || terminal || res.destroyed) return !terminal;
    if (line.length > LIMITS.streamLineCharacters) {
      await fail('INFERENCE_STREAM_INVALID', 'The upstream stream exceeded its line limit.');
      return false;
    }

    let data;
    try {
      data = JSON.parse(line);
    } catch (_error) {
      await fail('INFERENCE_STREAM_INVALID', 'The upstream stream was invalid.');
      return false;
    }

    if (data?.error) {
      await fail('INFERENCE_UPSTREAM_ERROR', 'Upstream inference failed.');
      return false;
    }

    usage = {
      promptTokens: Number(data.prompt_eval_count ?? data.usage?.prompt_tokens) || usage.promptTokens,
      completionTokens: Number(data.eval_count ?? data.usage?.completion_tokens) || usage.completionTokens,
    };
    const text = typeof data.message?.content === 'string'
      ? data.message.content
      : (typeof data.response === 'string' ? data.response : '');
    if (text) {
      reply += text;
      await emit('delta', {
        text,
        ...(data.message?.role && { role: data.message.role }),
      });
    }

    if (data.done === true) {
      terminal = true;
      await emit('done', {
        ...identity,
        reply,
        message: { role: 'assistant', content: reply },
        usage,
        persistence: { persisted: false },
      });
      return false;
    }
    return true;
  };

  try {
    streamLoop: for await (const chunk of stream) {
      buffer += decoder.write(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() || '';
      if (buffer.length > LIMITS.streamLineCharacters) {
        await fail('INFERENCE_STREAM_INVALID', 'The upstream stream exceeded its line limit.');
        break;
      }
      for (const line of lines) {
        if (!await processLine(line)) break streamLoop;
      }
    }
    if (!terminal && !res.destroyed) {
      buffer += decoder.end();
      if (buffer) await processLine(buffer);
    }
    if (!terminal && !res.destroyed) {
      await fail('INFERENCE_STREAM_INCOMPLETE', 'The inference stream ended before completion.');
    }
  } catch (error) {
    if (!res.destroyed && !terminal) {
      await fail(
        'INFERENCE_STREAM_ERROR',
        error?.message === 'Nestor consumer disconnected'
          ? 'Inference request cancelled.'
          : 'The inference stream ended unexpectedly.'
      );
    }
  } finally {
    if (!res.destroyed && !res.writableEnded) res.end();
  }
}

function setInferenceHeaders(res, provenance = {}) {
  const resolved = provenance.resolved || {};
  res.set('X-AgentX-Consumer-Contract', CONTRACT_VERSION);
  res.set('X-Resolved-Model', resolved.model || '');
  res.set('X-Routed-Host-Key', resolved.hostKey || '');
  res.set('X-Routing-Source', provenance.routingSource || '');
  res.set('X-Routing-Task-Type', provenance.taskType || '');
}

function createNestorConsumerV1Routes({ runtimeServices, systemHealth } = {}) {
  if (!runtimeServices?.inference?.execute) {
    throw new Error('Nestor consumer routes require Core runtime services.');
  }
  const router = express.Router();

  // Every Nestor response is attributable to the same stable contract, not
  // only inference responses.
  router.use((_req, res, next) => {
    res.set('X-AgentX-Consumer-Contract', CONTRACT_VERSION);
    next();
  });

  router.get('/capabilities', asyncRoute(async (_req, res) => {
    envelope.success(res, await getCapabilities({ systemHealth }));
  }));

  router.get('/router', asyncRoute(async (_req, res) => {
    res.set('Cache-Control', 'no-store');
    envelope.success(res, await getRouterSnapshot());
  }));

  router.post('/inference', async (req, res) => {
    const disconnect = createDisconnectSignal(req, res);
    try {
      res.set('Cache-Control', 'no-store');
      const result = await executeInference(req.body, {
        runtimeServices,
        signal: disconnect.signal,
      });
      setInferenceHeaders(res, result.provenance);

      if (!result.stream) return envelope.success(res, result);

      const { stream, ...identity } = result;
      res.status(200);
      res.set({
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache, no-store',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
        'Content-Encoding': 'identity',
      });
      res.flushHeaders?.();
      writeSse(res, 'route', identity);
      await waitForDrain(res);
      await relayInferenceStream(stream, res, identity);
      return undefined;
    } catch (error) {
      if (disconnect.signal.aborted) return undefined;
      if (res.headersSent) {
        if (!res.destroyed && !res.writableEnded) {
          writeSse(res, 'error', {
            code: error.code || 'INFERENCE_STREAM_ERROR',
            message: 'The inference stream ended unexpectedly.',
          });
          res.end();
        }
        return undefined;
      }
      return sendError(res, error);
    } finally {
      disconnect.complete();
    }
  });

  router.get('/memory/status', asyncRoute(async (req, res) => {
    const sources = req.query.source || req.query.sources;
    envelope.success(res, await getMemoryStatus(sources));
  }));

  router.post('/memory/search', asyncRoute(async (req, res) => {
    envelope.success(res, await searchMemory(req.body));
  }));

  router.use('/personality', (_req, res) => envelope.error(
    res,
    410,
    'Personality behavior belongs to the external consumer application.',
    'ADAPTER_REQUIRED'
  ));

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

  router.get('/panel-summary', (_req, res) => envelope.error(
    res,
    410,
    'Panel summaries moved to a separately installed trusted extension.',
    'ADAPTER_REQUIRED'
  ));

  return router;
}

module.exports = createNestorConsumerV1Routes;
module.exports.createDisconnectSignal = createDisconnectSignal;
module.exports.relayInferenceStream = relayInferenceStream;
module.exports.sanitizePublicValue = sanitizePublicValue;
module.exports.sendError = sendError;
