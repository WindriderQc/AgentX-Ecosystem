'use strict';

const MODEL_UNAVAILABLE_RE = /\bmodel\b[\s\S]*\bnot found\b|\bnot found\b[\s\S]*\bmodel\b/i;

class ChatUpstreamError extends Error {
    constructor(message, {
        statusCode = 502,
        code = 'OLLAMA_UPSTREAM_ERROR',
        upstreamStatus = null,
        upstreamMessage = null,
        upstreamUrl = null,
        model = null,
        cause = null
    } = {}) {
        super(message);
        this.name = 'ChatUpstreamError';
        this.statusCode = statusCode;
        this.code = code;
        this.upstreamStatus = upstreamStatus;
        this.upstreamMessage = upstreamMessage;
        this.upstreamUrl = upstreamUrl;
        this.model = model;
        if (cause) this.cause = cause;
    }
}

async function readOllamaErrorDetail(response) {
    let errDetail = response.statusText || `HTTP ${response.status}`;

    try {
        const errBody = await response.json();
        return errBody?.error || errBody?.message || JSON.stringify(errBody) || errDetail;
    } catch {
        try {
            const errText = await response.text();
            return errText || errDetail;
        } catch {
            return errDetail;
        }
    }
}

function isModelUnavailable(detail, status) {
    return status === 404 || MODEL_UNAVAILABLE_RE.test(String(detail || ''));
}

function buildOllamaStatusError({ url, response, detail, model }) {
    if (isModelUnavailable(detail, response.status)) {
        const requestedModel = model || 'requested model';
        return new ChatUpstreamError(
            `Ollama model unavailable: ${requestedModel} (${detail})`,
            {
                statusCode: 404,
                code: 'MODEL_UNAVAILABLE',
                upstreamStatus: response.status,
                upstreamMessage: detail,
                upstreamUrl: url,
                model
            }
        );
    }

    return new ChatUpstreamError(
        `Ollama request failed: ${detail}`,
        {
            statusCode: 502,
            code: 'OLLAMA_UPSTREAM_ERROR',
            upstreamStatus: response.status,
            upstreamMessage: detail,
            upstreamUrl: url,
            model
        }
    );
}

function wrapOllamaFetchError({ url, error, model, timeoutMessage }) {
    if (error?.statusCode) return error;

    if (error?.name === 'AbortError') {
        return new ChatUpstreamError(timeoutMessage, {
            statusCode: 504,
            code: 'OLLAMA_TIMEOUT',
            upstreamUrl: url,
            model,
            cause: error
        });
    }

    return new ChatUpstreamError(
        `Failed to connect to Ollama at ${url}: ${error.message}`,
        {
            statusCode: 503,
            code: 'OLLAMA_UNAVAILABLE',
            upstreamUrl: url,
            model,
            cause: error
        }
    );
}

module.exports = {
    ChatUpstreamError,
    readOllamaErrorDetail,
    buildOllamaStatusError,
    wrapOllamaFetchError
};
