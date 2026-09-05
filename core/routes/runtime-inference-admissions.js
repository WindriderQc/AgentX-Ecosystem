'use strict';

const express = require('express');
const { validateHostUrl } = require('../src/helpers/ollamaHostConfig');
const { requireOperatorAccess, operatorRequestIdentity } = require('../src/middleware/operatorAccess');
const {
  inferenceAdmissionBridgeCredentialAllowed
} = require('../src/middleware/publicExposureGuard');
const runtimeCoordination = require('../src/services/runtimeCoordinationService');

const router = express.Router();
const RUNTIME_BRIDGE_PRINCIPAL = 'runtime-bridge';
const ADMISSION_CONTRACT = 'agentx.runtime-inference-admission/v1';
const HEARTBEAT_CONTRACT = 'agentx.runtime-inference-heartbeat/v1';
const COMPLETION_CONTRACT = 'agentx.runtime-inference-completion/v1';
const QUARANTINE_CONTRACT = 'agentx.runtime-inference-quarantine/v1';

function requireRuntimeBridgeAccess(req, res, next) {
  if (inferenceAdmissionBridgeCredentialAllowed(req)) return next();
  return res.status(403).json({
    status: 'error',
    code: 'RUNTIME_INFERENCE_ADMISSION_AUTH_REQUIRED',
    message: 'Exact runtime bridge authentication is required.'
  });
}

function exactHost(rawHost) {
  const validation = validateHostUrl(rawHost);
  return validation.valid ? (validation.host || String(rawHost || '').trim()) : null;
}

function projectInferenceReceipt(result, contract, outcomeField) {
  if (result?.[outcomeField] !== true) return result;
  return {
    contract,
    coordinationKind: 'inference',
    [outcomeField]: true,
    admissionId: result.admissionId,
    generation: result.generation,
    principal: RUNTIME_BRIDGE_PRINCIPAL,
    requestId: result.requestId || null,
    host: result.host || null,
    model: result.model || null,
    kind: result.kind || null,
    mode: result.mode || 'shared',
    residencyKey: result.residencyKey || null,
    residencySpec: result.residencySpec || null,
    acquiredAt: result.acquiredAt || null,
    heartbeatAt: result.heartbeatAt || null,
    expiresAt: result.expiresAt || null,
    releasedAt: result.releasedAt || null,
    unknownAt: result.unknownAt || null,
    reason: result.reason || null,
    state: outcomeField === 'quarantined' ? 'UNKNOWN' : (result.state || null),
    ...(result.idempotent === true && { idempotent: true })
  };
}

router.post('/', requireRuntimeBridgeAccess, async (req, res) => {
  try {
    if (req.body?.mode && req.body.mode !== 'shared') {
      return res.status(400).json({
        status: 'error',
        code: 'RUNTIME_INFERENCE_SHARED_ONLY',
        message: 'Runtime bridge inference admissions are shared-only.'
      });
    }
    const host = exactHost(req.body?.host);
    if (!host) {
      return res.status(400).json({ status: 'error', code: 'RUNTIME_INFERENCE_HOST_INVALID', message: 'host is invalid' });
    }
    const result = await runtimeCoordination.acquireInference({
      principal: RUNTIME_BRIDGE_PRINCIPAL,
      requestId: req.body?.requestId || req.body?.idempotencyKey,
      host,
      model: req.body?.model,
      kind: 'runtime-bridge',
      mode: 'shared',
      runtimeOptions: req.body?.runtimeOptions,
      ...(Object.prototype.hasOwnProperty.call(req.body || {}, 'keepAlive')
        && { keepAlive: req.body.keepAlive }),
      ttl: req.body?.ttlMs
    });
    const data = projectInferenceReceipt(result, ADMISSION_CONTRACT, 'acquired');
    return res.status(result.acquired ? 200 : 409).json({
      status: result.acquired ? 'success' : 'error',
      data
    });
  } catch (error) {
    return res.status(500).json({ status: 'error', code: 'RUNTIME_INFERENCE_ACQUIRE_FAILED', message: error.message });
  }
});

router.post('/:admissionId/heartbeat', requireRuntimeBridgeAccess, async (req, res) => {
  try {
    const result = await runtimeCoordination.heartbeatInference({
      id: req.params.admissionId,
      generation: req.body?.generation,
      principal: RUNTIME_BRIDGE_PRINCIPAL,
      ttl: req.body?.ttlMs
    });
    const data = projectInferenceReceipt(result, HEARTBEAT_CONTRACT, 'heartbeat');
    return res.status(result.heartbeat ? 200 : 409).json({
      status: result.heartbeat ? 'success' : 'error',
      data
    });
  } catch (error) {
    return res.status(500).json({ status: 'error', code: 'RUNTIME_INFERENCE_HEARTBEAT_FAILED', message: error.message });
  }
});

router.post('/:admissionId/complete', requireRuntimeBridgeAccess, async (req, res) => {
  try {
    const result = await runtimeCoordination.releaseInference({
      id: req.params.admissionId,
      generation: req.body?.generation,
      principal: RUNTIME_BRIDGE_PRINCIPAL
    });
    const data = projectInferenceReceipt(result, COMPLETION_CONTRACT, 'released');
    return res.status(result.released ? 200 : 409).json({
      status: result.released ? 'success' : 'error',
      data
    });
  } catch (error) {
    return res.status(500).json({ status: 'error', code: 'RUNTIME_INFERENCE_COMPLETE_FAILED', message: error.message });
  }
});

router.post('/:admissionId/mark-unknown', requireRuntimeBridgeAccess, async (req, res) => {
  try {
    const result = await runtimeCoordination.markInferenceUnknown({
      id: req.params.admissionId,
      generation: req.body?.generation,
      principal: RUNTIME_BRIDGE_PRINCIPAL,
      reason: req.body?.reason || 'runtime bridge lost terminal response'
    });
    const data = projectInferenceReceipt(result, QUARANTINE_CONTRACT, 'quarantined');
    return res.status(result.quarantined ? 200 : 409).json({
      status: result.quarantined ? 'success' : 'error',
      data
    });
  } catch (error) {
    return res.status(500).json({ status: 'error', code: 'RUNTIME_INFERENCE_QUARANTINE_FAILED', message: error.message });
  }
});

// UNKNOWN recovery is intentionally not available to the runtime bridge.
// Only an operator can attest the controlled runtime restart that proves old
// Ollama requests terminated.
router.post('/:admissionId/recover-runtime-restart', requireOperatorAccess, async (req, res) => {
  try {
    const result = await runtimeCoordination.recoverInferenceAfterRuntimeRestart({
      id: req.params.admissionId,
      generation: req.body?.generation,
      principal: RUNTIME_BRIDGE_PRINCIPAL,
      receipt: {
        contract: req.body?.contract,
        runtimeRestarted: req.body?.runtimeRestarted,
        confirmation: req.body?.confirmation,
        restartedAt: req.body?.restartedAt,
        recoveredBy: operatorRequestIdentity(req)
      }
    });
    return res.status(result.recovered ? 200 : 409).json({
      status: result.recovered ? 'success' : 'error',
      data: result
    });
  } catch (error) {
    return res.status(500).json({ status: 'error', code: 'RUNTIME_INFERENCE_RECOVERY_FAILED', message: error.message });
  }
});

module.exports = router;
module.exports._internal = {
  requireRuntimeBridgeAccess,
  RUNTIME_BRIDGE_PRINCIPAL,
  ADMISSION_CONTRACT,
  HEARTBEAT_CONTRACT,
  COMPLETION_CONTRACT,
  QUARANTINE_CONTRACT,
  projectInferenceReceipt
};
