'use strict';

const RUNTIMES = new Set(['agentx', 'openclaw', 'hermes', 'codex', 'claude-code', 'other']);

function boundedIdentifier(value, max = 160) {
  if (value == null) return null;
  const text = String(value).trim();
  if (!text) return null;
  return text.replace(/[^a-zA-Z0-9._:/-]/g, '-').slice(0, max);
}

function inferRuntime(value, fallback = 'agentx') {
  const explicit = String(value || '').trim().toLowerCase();
  if (RUNTIMES.has(explicit)) return explicit;
  if (explicit.includes('openclaw') || explicit.includes('clawdx')) return 'openclaw';
  if (explicit.includes('hermes')) return 'hermes';
  if (explicit.includes('codex')) return 'codex';
  if (explicit.includes('claude')) return 'claude-code';
  return RUNTIMES.has(fallback) ? fallback : 'other';
}

function positiveAttempt(value) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? Math.min(parsed, 10_000) : 1;
}

function telemetryContextFromRequest(req, defaultRuntime = 'agentx') {
  const body = req?.body && typeof req.body === 'object' ? req.body : {};
  const telemetry = body.telemetry && typeof body.telemetry === 'object' ? body.telemetry : {};
  const get = (name) => (typeof req?.get === 'function' ? req.get(name) : null);
  const callerDetail = body.callerDetail || get('X-AgentX-Caller') || null;

  return {
    runtime: inferRuntime(
      telemetry.runtime || body.runtime || get('X-AgentX-Runtime') || callerDetail,
      defaultRuntime,
    ),
    correlationId: boundedIdentifier(
      telemetry.correlationId || body.correlationId || req?.correlationId || get('X-Correlation-Id'),
    ),
    workItemId: boundedIdentifier(
      telemetry.workItemId || body.workItemId || get('X-AgentX-Work-Item-Id'),
    ),
    attempt: positiveAttempt(telemetry.attempt || body.attempt || get('X-AgentX-Attempt')),
  };
}

module.exports = {
  RUNTIMES,
  boundedIdentifier,
  inferRuntime,
  positiveAttempt,
  telemetryContextFromRequest,
};
