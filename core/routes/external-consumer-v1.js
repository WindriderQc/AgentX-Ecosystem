'use strict';

const express = require('express');
const envelope = require('../src/helpers/responseEnvelope');
const logger = require('../config/logger');
const { sanitizePublicProjection: sanitizePublicValue } = require('../../shared/publicProjection');
const {
  CONTRACT_NAME,
  CONTRACT_VERSION,
  CONTRACT_BASE_PATH,
  LIMITS,
  normalizeInferenceRequest,
  normalizeNonStreamingResult,
  publicRouteMetadata,
  sanitizeRoutingSnapshot,
} = require('../src/services/externalConsumerContract');

// This value is supplied by the server-owned route, never by the request
// body. Individual external consumer names remain caller-controlled metadata
// and are deliberately redacted from public inference-log projections.
const TELEMETRY_CONSUMER_CONTRACT = 'external-consumer-v1';

function sendError(res, error) {
  const statusCode = Number(error.statusCode) || 500;
  if (statusCode >= 500) logger.error('[ExternalConsumerV1] request failed', { error: error.message });
  const message = statusCode >= 500
    ? 'External consumer request failed.'
    : sanitizePublicValue(error.message || 'External consumer request failed.');
  const body = {
    ok: false,
    status: 'error',
    error: message,
    message,
    code: error.code || 'EXTERNAL_CONSUMER_ERROR',
  };
  if (statusCode < 500 && error.details) body.details = sanitizePublicValue(error.details);
  return res.status(statusCode).json(body);
}

function setRouteHeaders(res, metadata) {
  const route = publicRouteMetadata(metadata);
  res.set('X-AgentX-Consumer-Contract', CONTRACT_VERSION);
  res.set('X-Resolved-Model', route.model || '');
  res.set('X-Routed-Host-Key', route.hostKey || '');
  res.set('X-Routing-Source', route.routingSource || '');
  if (route.taskType) res.set('X-Routing-Task-Type', route.taskType);
  return route;
}

function writeSse(res, event, data) {
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

function createDisconnectSignal(req, res) {
  const controller = new AbortController();
  let complete = false;
  const cancel = () => {
    if (!complete && !controller.signal.aborted) {
      controller.abort(new Error('external consumer disconnected'));
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

function streamEventFromUpstream(data) {
  if (data?.error) return {
    event: 'error',
    data: { code: 'INFERENCE_UPSTREAM_ERROR', message: 'Upstream inference failed.' },
  };
  const text = typeof data?.message?.content === 'string'
    ? data.message.content
    : (typeof data?.response === 'string' ? data.response : '');
  if (text) return {
    event: 'delta',
    data: {
      text,
      ...(data.message?.role && { role: data.message.role }),
    },
  };
  return null;
}

function relaySseStream(stream, res) {
  return new Promise((resolve) => {
    let buffer = '';
    let terminal = false;
    let usage = { promptTokens: 0, completionTokens: 0 };

    const processLine = (line) => {
      if (!line.trim() || terminal || res.destroyed) return;
      let data;
      try { data = JSON.parse(line); } catch {
        terminal = true;
        writeSse(res, 'error', { code: 'INFERENCE_STREAM_INVALID', message: 'The upstream stream was invalid.' });
        return;
      }
      usage = {
        promptTokens: Number(data.prompt_eval_count) || usage.promptTokens,
        completionTokens: Number(data.eval_count) || usage.completionTokens,
      };
      const event = streamEventFromUpstream(data);
      if (event) {
        writeSse(res, event.event, event.data);
        if (event.event === 'error') terminal = true;
      }
      if (data.done === true && !terminal) {
        terminal = true;
        writeSse(res, 'done', { usage, persistence: { persisted: false } });
      }
    };

    stream.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() || '';
      lines.forEach(processLine);
      if (res.writableNeedDrain && typeof stream.pause === 'function') {
        stream.pause();
        res.once('drain', () => stream.resume?.());
      }
    });
    stream.once('end', () => {
      if (buffer) processLine(buffer);
      if (!terminal && !res.destroyed) {
        terminal = true;
        writeSse(res, 'error', {
          code: 'INFERENCE_STREAM_INCOMPLETE',
          message: 'The inference stream ended before completion.',
        });
      }
      if (!res.destroyed) res.end();
      resolve();
    });
    stream.once('error', (error) => {
      if (!res.destroyed && !terminal) {
        writeSse(res, 'error', {
          code: 'INFERENCE_STREAM_ERROR',
          message: error?.message === 'external consumer disconnected'
            ? 'Inference request cancelled.'
            : 'The inference stream ended unexpectedly.',
        });
        res.end();
      }
      resolve();
    });
    stream.once('close', () => {
      if (stream.readableEnded !== true && !res.destroyed && !terminal) {
        writeSse(res, 'error', {
          code: 'INFERENCE_STREAM_ERROR',
          message: 'The inference stream ended unexpectedly.',
        });
        res.end();
      }
      resolve();
    });
  });
}

function createExternalConsumerV1Routes({ runtimeServices, systemHealth } = {}) {
  if (!runtimeServices?.inference?.execute || !runtimeServices?.routing?.getEffectiveSnapshot) {
    throw new Error('External consumer routes require Core runtime services.');
  }
  const router = express.Router();

  // Discovery and read-only projections carry the same version receipt as
  // inference. Consumers can reject an incompatible deployment before using
  // any part of the contract.
  router.use((_req, res, next) => {
    res.set('X-AgentX-Consumer-Contract', CONTRACT_VERSION);
    next();
  });

  router.get('/capabilities', (_req, res) => {
    envelope.success(res, {
      contract: {
        name: CONTRACT_NAME,
        version: CONTRACT_VERSION,
        basePath: CONTRACT_BASE_PATH,
      },
      generatedAt: new Date().toISOString(),
      agentx: {
        available: true,
        health: systemHealth?.overall || systemHealth?.status || 'serving',
        healthEndpoint: '/health',
      },
      inference: {
        endpoint: `${CONTRACT_BASE_PATH}/inference`,
        modes: ['chat', 'generate'],
        routed: true,
        stateless: true,
        persistence: false,
        thinking: {
          booleanControl: true,
          modes: null,
        },
        generationOptions: [
          'num_predict', 'temperature', 'top_p', 'top_k', 'min_p', 'seed', 'stop',
          'repeat_penalty', 'presence_penalty', 'frequency_penalty',
        ],
        streaming: {
          supported: true,
          contentType: 'text/event-stream',
          events: ['route', 'delta', 'done', 'error'],
          cancellation: 'client-disconnect',
        },
      },
      routing: {
        endpoint: `${CONTRACT_BASE_PATH}/routing`,
        readOnly: true,
        topology: 'opaque',
      },
      authentication: {
        remote: 'bearer-or-x-agentx-consumer-token',
        environmentVariable: 'AGENTX_EXTERNAL_CONSUMER_TOKEN',
        loopback: 'allowed',
      },
      limits: { ...LIMITS },
    });
  });

  router.get('/routing', async (req, res) => {
    try {
      res.set('Cache-Control', 'no-store');
      const snapshot = await runtimeServices.routing.getEffectiveSnapshot({ includeCatalog: false });
      envelope.success(res, sanitizeRoutingSnapshot(snapshot));
    } catch (error) {
      sendError(res, error);
    }
  });

  router.post('/inference', async (req, res) => {
    const disconnect = createDisconnectSignal(req, res);
    try {
      res.set('Cache-Control', 'no-store');
      const request = normalizeInferenceRequest(req.body);
      const result = await runtimeServices.inference.execute(request.runtimeRequest, {
        signal: disconnect.signal,
        consumerContract: TELEMETRY_CONSUMER_CONTRACT,
      });
      const route = setRouteHeaders(res, result.metadata);

      if (!result.ok) {
        const error = new Error(result.body?.error || `Inference failed with HTTP ${result.status || 502}`);
        error.statusCode = Number(result.status) || 502;
        error.code = 'INFERENCE_UPSTREAM_ERROR';
        return sendError(res, error);
      }

      if (request.runtimeRequest.stream) {
        res.status(200);
        res.set({
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache, no-store',
          Connection: 'keep-alive',
          'X-Accel-Buffering': 'no',
          'Content-Encoding': 'identity',
        });
        res.flushHeaders?.();
        writeSse(res, 'route', route);
        await relaySseStream(result.stream, res);
        return undefined;
      }

      return envelope.success(res, normalizeNonStreamingResult(result));
    } catch (error) {
      if (disconnect.signal.aborted || res.headersSent) return undefined;
      return sendError(res, error);
    } finally {
      disconnect.complete();
    }
  });

  return router;
}

module.exports = createExternalConsumerV1Routes;
module.exports.createDisconnectSignal = createDisconnectSignal;
module.exports.relaySseStream = relaySseStream;
module.exports.sanitizePublicValue = sanitizePublicValue;
module.exports.sendError = sendError;
