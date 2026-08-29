const crypto = require('crypto');

const RECOVERY_AUTH_REQUIRED = 'RECOVERY_AUTH_REQUIRED';

function normalizeToken(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function recoveryTokensMatch(expected, presented) {
  const expectedToken = normalizeToken(expected);
  const presentedToken = normalizeToken(presented);
  if (!expectedToken || !presentedToken) return false;

  // Compare fixed-length digests so unequal token lengths do not bypass the
  // timing-safe primitive.
  const expectedDigest = crypto.createHash('sha256').update(expectedToken).digest();
  const presentedDigest = crypto.createHash('sha256').update(presentedToken).digest();
  return crypto.timingSafeEqual(expectedDigest, presentedDigest);
}

function requireRecoveryToken(req, res, next) {
  const expected = process.env.AGENTX_RECOVERY_TOKEN;
  const presented = req.get('x-agentx-recovery-token');
  if (recoveryTokensMatch(expected, presented)) return next();

  return res.status(403).json({
    ok: false,
    code: RECOVERY_AUTH_REQUIRED,
    error: 'Recovery snapshot authorization required'
  });
}

module.exports = {
  RECOVERY_AUTH_REQUIRED,
  recoveryTokensMatch,
  requireRecoveryToken
};
