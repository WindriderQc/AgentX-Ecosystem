'use strict';

const DESTRUCTIVE_CONFIRMATION_CODE = 'DESTRUCTIVE_CONFIRMATION_REQUIRED';

/**
 * Require an exact phrase in the JSON `confirm` field before a destructive
 * route can invoke its mutation. The response intentionally describes the
 * challenge so API clients can render the same confirmation contract as the
 * product UI.
 *
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @param {string} expected
 * @returns {boolean}
 */
function requireExactConfirmation(req, res, expected) {
    if (req.body?.confirm === expected) return true;

    res.status(400).json({
        status: 'error',
        code: DESTRUCTIVE_CONFIRMATION_CODE,
        error: 'Exact confirmation phrase required before this destructive action can run.',
        confirmation: {
            kind: 'exact-phrase',
            field: 'confirm',
            expected
        }
    });
    return false;
}

module.exports = {
    DESTRUCTIVE_CONFIRMATION_CODE,
    requireExactConfirmation
};
