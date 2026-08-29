'use strict';

const CONFIRMATION_HEADER = 'X-AgentX-Confirm';
const CONFIRMATION_CODE = 'CONFIRMATION_REQUIRED';

function normalizePart(value) {
  return String(value == null ? '' : value).trim().replace(/\s+/g, ' ');
}

function buildTypedConfirmation(...parts) {
  const expected = parts.map(normalizePart).filter(Boolean).join(' ');
  if (!expected) {
    throw new TypeError('Typed confirmation requires a non-empty phrase');
  }
  return expected;
}

function requireTypedConfirmation(req, res, ...parts) {
  const expected = buildTypedConfirmation(...parts);
  if (req.get('x-agentx-confirm') === expected) return true;

  res.status(400).json({
    status: 'error',
    code: CONFIRMATION_CODE,
    message: `Type ${expected} exactly to confirm this destructive operation.`,
    confirmation: {
      header: CONFIRMATION_HEADER,
      expected
    }
  });
  return false;
}

module.exports = {
  CONFIRMATION_CODE,
  CONFIRMATION_HEADER,
  buildTypedConfirmation,
  requireTypedConfirmation
};
