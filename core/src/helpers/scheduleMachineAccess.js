'use strict';

const crypto = require('crypto');
const { operatorUiAccessAllowed } = require('../middleware/operatorAccess');

const SCHEDULE_TOKEN_HEADER = 'X-AgentX-Schedule-Token';

function expectedScheduleToken() {
  return String(process.env.AGENTX_SCHEDULE_TOKEN || '').trim();
}

function presentedScheduleToken(req) {
  return String(req.get?.(SCHEDULE_TOKEN_HEADER) || '').trim();
}

function tokensMatch(expected, presented) {
  const left = Buffer.from(String(expected || ''));
  const right = Buffer.from(String(presented || ''));
  return left.length > 0
    && left.length === right.length
    && crypto.timingSafeEqual(left, right);
}

function scheduleTokenAllowed(req) {
  return tokensMatch(expectedScheduleToken(), presentedScheduleToken(req));
}

function scheduleMachineAccessAllowed(req) {
  if (scheduleTokenAllowed(req)) return true;
  if (operatorUiAccessAllowed(req)) return true;
  // Resolve this at request time so the outer exposure guard can consume the
  // lane-owned token verifier without creating an initialization cycle.
  const { trustedLocalMachineAllowed } = require('../middleware/publicExposureGuard');
  return trustedLocalMachineAllowed(req);
}

function requireScheduleMachineAccess(req, res, next) {
  if (scheduleMachineAccessAllowed(req)) return next();
  return res.status(403).json({
    status: 'error',
    code: 'SCHEDULE_MACHINE_ACCESS_REQUIRED',
    message: 'Schedule token, same-origin UI, or trusted local operator access required.'
  });
}

module.exports = {
  SCHEDULE_TOKEN_HEADER,
  expectedScheduleToken,
  presentedScheduleToken,
  scheduleTokenAllowed,
  scheduleMachineAccessAllowed,
  requireScheduleMachineAccess,
};
