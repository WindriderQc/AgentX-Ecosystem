'use strict';

const crypto = require('crypto');
const {
  operatorTokenAllowed,
  operatorUiAccessAllowed,
} = require('../middleware/operatorAccess');
const { trustedLocalMachineAllowed } = require('../middleware/publicExposureGuard');

const PIPELINE_TOKEN_HEADER = 'X-AgentX-Pipeline-Token';
const PIPELINE_AUTHORITY = Object.freeze({
  OPERATOR: 'operator-token',
  TRUSTED_CONTROL: 'trusted-local-or-ui',
  WORKER: 'pipeline-worker',
  NONE: 'unauthorized',
});

function expectedPipelineToken() {
  return String(process.env.AGENTX_PIPELINE_TOKEN || '').trim();
}

function presentedPipelineToken(req) {
  return String(req.get?.('x-agentx-pipeline-token') || '').trim();
}

function pipelineTokensMatch(expected, presented) {
  const left = Buffer.from(String(expected || ''));
  const right = Buffer.from(String(presented || ''));
  return left.length > 0
    && left.length === right.length
    && crypto.timingSafeEqual(left, right);
}

// The purpose-scoped credential deliberately has no unset fallback.
function pipelineWorkerTokenAllowed(req) {
  return pipelineTokensMatch(expectedPipelineToken(), presentedPipelineToken(req));
}

function pipelineRequestAuthority(req) {
  if (operatorTokenAllowed(req)) return PIPELINE_AUTHORITY.OPERATOR;
  // An explicitly presented worker credential retains worker scope even when
  // a reverse proxy makes the connection appear loopback. This prevents the
  // transport topology from upgrading a remote worker into final authority.
  if (pipelineWorkerTokenAllowed(req)) return PIPELINE_AUTHORITY.WORKER;
  if (operatorUiAccessAllowed(req) || trustedLocalMachineAllowed(req)) {
    return PIPELINE_AUTHORITY.TRUSTED_CONTROL;
  }
  return PIPELINE_AUTHORITY.NONE;
}

function pipelineMutationDecision(req, { finalizesTask = false } = {}) {
  const authority = pipelineRequestAuthority(req);
  if (authority === PIPELINE_AUTHORITY.NONE) {
    return {
      allowed: false,
      authority,
      code: 'PIPELINE_ACCESS_REQUIRED',
      message: `${PIPELINE_TOKEN_HEADER}, same-origin UI, trusted local access, or operator token required.`,
    };
  }

  // AGENTX_PIPELINE_TOKEN is a worker-lifecycle credential. It may claim,
  // heartbeat, report feedback (including done -> review), and set non-final
  // states. It can never authorize the final status=done confirmation.
  if (finalizesTask && authority === PIPELINE_AUTHORITY.WORKER) {
    return {
      allowed: false,
      authority,
      code: 'PIPELINE_FINALIZE_REQUIRES_CONTROL_AUTHORITY',
      message: "The pipeline worker token cannot confirm status 'done'; a trusted reviewer or operator must finalize the task.",
    };
  }

  return { allowed: true, authority };
}

function enforcePipelineDecision(req, res, next, options) {
  const decision = pipelineMutationDecision(req, options);
  if (!decision.allowed) {
    return res.status(403).json({
      ok: false,
      status: 'error',
      error: decision.message,
      message: decision.message,
      code: decision.code,
    });
  }
  req.pipelineAuthority = decision.authority;
  return next();
}

function requirePipelineWorkerAccess(req, res, next) {
  return enforcePipelineDecision(req, res, next);
}

function requirePipelineStatusAccess(req, res, next) {
  return enforcePipelineDecision(req, res, next, {
    finalizesTask: req.body?.status === 'done',
  });
}

module.exports = {
  PIPELINE_TOKEN_HEADER,
  PIPELINE_AUTHORITY,
  expectedPipelineToken,
  presentedPipelineToken,
  pipelineTokensMatch,
  pipelineWorkerTokenAllowed,
  pipelineRequestAuthority,
  pipelineMutationDecision,
  requirePipelineWorkerAccess,
  requirePipelineStatusAccess,
};
