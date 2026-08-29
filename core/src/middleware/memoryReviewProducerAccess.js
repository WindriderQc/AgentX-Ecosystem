'use strict';

const crypto = require('crypto');
const {
  operatorRequestIdentity,
  operatorUiAccessAllowed,
} = require('./operatorAccess');
const { trustedLocalMachineAllowed } = require('./publicExposureGuard');

const MEMORY_REVIEW_TOKEN_HEADER = 'x-agentx-memory-review-token';

function expectedMemoryReviewToken() {
  return String(process.env.AGENTX_MEMORY_REVIEW_TOKEN || '').trim();
}

function presentedMemoryReviewToken(req) {
  return String(req.get?.(MEMORY_REVIEW_TOKEN_HEADER) || '').trim();
}

function tokensMatch(expected, presented) {
  const left = Buffer.from(String(expected || ''));
  const right = Buffer.from(String(presented || ''));
  return left.length > 0
    && left.length === right.length
    && crypto.timingSafeEqual(left, right);
}

// Purpose-scoped producer credentials fail closed when the environment token
// is unset. Local UI/operator and explicitly trusted local-machine authorities
// remain separate, existing product paths rather than token fallbacks.
function memoryReviewTokenAllowed(req) {
  return tokensMatch(
    expectedMemoryReviewToken(),
    presentedMemoryReviewToken(req)
  );
}

function memoryReviewProducerAccessAllowed(req) {
  if (memoryReviewTokenAllowed(req)) return true;
  if (operatorUiAccessAllowed(req)) return true;
  return trustedLocalMachineAllowed(req);
}

function memoryReviewProducerRequestIdentity(req) {
  if (memoryReviewTokenAllowed(req)) return 'memory-review-producer-token';

  const operatorIdentity = operatorRequestIdentity(req);
  if (operatorIdentity !== 'unauthorized') return operatorIdentity;
  if (trustedLocalMachineAllowed(req)) return 'trusted-local-machine';
  return 'unauthorized';
}

function requireMemoryReviewProducerAccess(req, res, next) {
  if (memoryReviewProducerAccessAllowed(req)) return next();
  return res.status(403).json({
    status: 'error',
    code: 'MEMORY_REVIEW_PRODUCER_ACCESS_REQUIRED',
    message: 'Memory Review producer token, same-origin UI, operator, or trusted local access required.'
  });
}

module.exports = {
  MEMORY_REVIEW_TOKEN_HEADER,
  expectedMemoryReviewToken,
  presentedMemoryReviewToken,
  tokensMatch,
  memoryReviewTokenAllowed,
  memoryReviewProducerAccessAllowed,
  memoryReviewProducerRequestIdentity,
  requireMemoryReviewProducerAccess,
};
