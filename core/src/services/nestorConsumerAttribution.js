'use strict';

const { randomBytes, timingSafeEqual } = require('crypto');

const HEADER_NAME = 'x-agentx-internal-nestor-consumer';
const CONSUMER_CONTRACT = 'nestor-v1';
const processToken = randomBytes(32).toString('hex');

function internalNestorInferenceHeaders() {
  return { [HEADER_NAME]: processToken };
}

function trustedNestorConsumer(req) {
  const supplied = String(req?.get?.(HEADER_NAME) || '');
  const candidate = Buffer.from(supplied);
  const expected = Buffer.from(processToken);
  if (!supplied || candidate.length !== expected.length) return null;
  const trusted = timingSafeEqual(candidate, expected);
  return trusted ? CONSUMER_CONTRACT : null;
}

module.exports = {
  HEADER_NAME,
  CONSUMER_CONTRACT,
  internalNestorInferenceHeaders,
  trustedNestorConsumer,
};
