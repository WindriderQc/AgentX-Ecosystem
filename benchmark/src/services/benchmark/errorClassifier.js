/**
 * Benchmark Error Classifier
 *
 * Distinguishes infra/network/runtime failures from model/response failures.
 * Used to prevent infrastructure noise from impacting model reliability ranking.
 */

function _normalizeMessage(message) {
    if (!message) return '';
    return String(message).trim();
}

function classifyBenchmarkError(errorLike) {
    // Short-circuit: callers can set err.infra = true to force infra
    // classification (used for custom failures like ModelDidNotRunError
    // where the HTTP layer succeeded but the model never actually ran).
    if (errorLike && typeof errorLike === 'object' && errorLike.infra === true) {
        return {
            infra: true,
            type: 'infra',
            httpStatus: null,
            message: _normalizeMessage(errorLike.message || errorLike.name || 'infra error')
        };
    }

    const message = _normalizeMessage(
        typeof errorLike === 'string'
            ? errorLike
            : (errorLike && (errorLike.message || errorLike.error))
    );

    const upper = message.toUpperCase();

    // Network / DNS / socket / GPU / runtime
    const infraPatterns = [
        'ECONNREFUSED',
        'ECONNRESET',
        'EPIPE',
        'ENOTFOUND',
        'EAI_AGAIN',
        'ETIMEDOUT',
        'ESOCKETTIMEDOUT',
        'CERT_',
        'TLS',
        'SSL',
        'SOCKET HANG UP',
        'FETCH FAILED',
        'NETWORK',
        'CONNECTION',
        'CONNECT ',
        'OUT OF MEMORY',
        'OUT_OF_MEMORY',
        'OOM',
        'CUDA',
        'DEVICE NOT FOUND',
        'UNEXPECTED EOF',
        'BROKEN PIPE',
        'NO SPACE LEFT',
        'KILL',
        'RUNNER '
    ];

    const isHttpError = /^HTTP\s+\d+\s*:/i.test(message);
    let httpStatus = null;
    if (isHttpError) {
        const m = message.match(/^HTTP\s+(\d+)\s*:/i);
        if (m) httpStatus = Number(m[1]);
    }

    const infraByHttp = Number.isFinite(httpStatus) && (httpStatus >= 500 || httpStatus === 429 || httpStatus === 408);

    const infraByPattern = infraPatterns.some(p => upper.includes(p));

    // Abort/timeout wording seen across fetch/undici/node-fetch
    const infraByWording = /timed?\s*out|timeout|aborted|aborterror/i.test(message);

    const infra = !!(infraByHttp || infraByPattern || infraByWording);

    return {
        infra,
        type: infra ? 'infra' : (message ? 'model' : 'unknown'),
        httpStatus: Number.isFinite(httpStatus) ? httpStatus : null,
        message
    };
}

module.exports = {
    classifyBenchmarkError,
    // Shared regex for MongoDB $regexMatch / Mongoose $regex queries.
    // Must stay in sync with the infraPatterns array + infraByWording/infraByHttp logic above.
    INFRA_ERROR_REGEX: /(ECONNREFUSED|ECONNRESET|EPIPE|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|ESOCKETTIMEDOUT|socket hang up|fetch failed|timed\s*out|timeout|aborted|HTTP\s+(5\d\d|429|408)\s*:)/i
};
