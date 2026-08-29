'use strict';

const crypto = require('crypto');
const { operatorUiAccessAllowed } = require('../middleware/operatorAccess');
const { trustedLocalMachineAllowed } = require('../middleware/publicExposureGuard');

const ALERT_DELIVERY_TOKEN_HEADER = 'X-AgentX-Alert-Delivery-Token';

function expectedAlertDeliveryToken() {
  return String(process.env.AGENTX_ALERT_DELIVERY_TOKEN || '').trim();
}

function presentedAlertDeliveryToken(req) {
  return String(req.get?.(ALERT_DELIVERY_TOKEN_HEADER) || '').trim();
}

function tokensMatch(expected, presented) {
  const left = Buffer.from(String(expected || ''));
  const right = Buffer.from(String(presented || ''));
  return left.length > 0
    && left.length === right.length
    && crypto.timingSafeEqual(left, right);
}

function alertDeliveryTokenAllowed(req) {
  return tokensMatch(expectedAlertDeliveryToken(), presentedAlertDeliveryToken(req));
}

function alertDeliveryAccessAllowed(req) {
  return alertDeliveryTokenAllowed(req)
    || operatorUiAccessAllowed(req)
    || trustedLocalMachineAllowed(req);
}

function requireAlertDeliveryAccess(req, res, next) {
  if (alertDeliveryAccessAllowed(req)) return next();
  return res.status(403).json({
    status: 'error',
    code: 'ALERT_DELIVERY_ACCESS_REQUIRED',
    message: 'Alert delivery token, same-origin UI, or trusted local operator access required.'
  });
}

module.exports = {
  ALERT_DELIVERY_TOKEN_HEADER,
  expectedAlertDeliveryToken,
  presentedAlertDeliveryToken,
  alertDeliveryTokenAllowed,
  alertDeliveryAccessAllowed,
  requireAlertDeliveryAccess,
};
