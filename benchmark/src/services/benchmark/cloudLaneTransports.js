'use strict';

const fetch = require('node-fetch');

const DEFAULT_TIMEOUT_MS = 120_000;
const OPENROUTER_MODELS_URL = 'https://openrouter.ai/api/v1/models';
const OPENROUTER_API_VERSION = 'openrouter-chat-completions-v1';

function transportError(code, message, statusCode = 400) {
    const error = new Error(message);
    error.code = code;
    error.statusCode = statusCode;
    return error;
}

function required(value, name) {
    const normalized = String(value == null ? '' : value).trim();
    if (!normalized) throw transportError('TRANSPORT_CONFIG_REQUIRED', `${name} is required`);
    return normalized;
}

function normalizedBaseUrl(value) {
    const url = new URL(required(value, 'baseUrl'));
    if (!['http:', 'https:'].includes(url.protocol)) throw transportError('INVALID_BASE_URL', 'baseUrl must use HTTP or HTTPS');
    return url.toString().replace(/\/$/, '');
}

async function fetchResponse(fetchImpl, url, options, timeoutMs) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
        return await fetchImpl(url, { ...options, signal: controller.signal });
    } finally {
        clearTimeout(timer);
    }
}

async function responseBody(response) {
    const rawText = await response.text();
    if (!rawText) return { parsed: {}, rawText: '' };
    try {
        return { parsed: JSON.parse(rawText), rawText };
    } catch (_) {
        return { parsed: null, rawText };
    }
}

function parseToolCalls(raw) {
    if (!Array.isArray(raw)) return [];
    return raw.map((call) => {
        let args = call?.function?.arguments ?? call?.arguments ?? {};
        if (typeof args === 'string') {
            try { args = JSON.parse(args); } catch (_) { args = { _raw: args }; }
        }
        return {
            id: call?.id || null,
            name: String(call?.function?.name || call?.name || ''),
            arguments: args
        };
    });
}

function normalizeOpenAIUsage(raw = {}) {
    const prompt = Number(raw.prompt_tokens) || 0;
    const cached = Number(raw.prompt_tokens_details?.cached_tokens || raw.cache_read_input_tokens) || 0;
    return {
        input: Math.max(0, prompt - cached),
        output: Number(raw.completion_tokens) || 0,
        cacheRead: cached,
        cacheWrite: Number(raw.cache_write_input_tokens || raw.prompt_tokens_details?.cache_write_tokens) || 0
    };
}

function createOpenAICompatibleTransport(config = {}) {
    const provider = required(config.provider, 'provider').toLowerCase();
    const baseUrl = normalizedBaseUrl(config.baseUrl);
    const apiKey = required(config.apiKey, 'apiKey');
    const fetchImpl = config.fetchImpl || fetch;
    const timeoutMs = Number(config.timeoutMs) || DEFAULT_TIMEOUT_MS;
    const headers = { ...config.headers, authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' };
    if (typeof config.resolveCurrentModel !== 'function') {
        throw transportError('MODEL_RESOLVER_REQUIRED', 'OpenAI-compatible transports require a current model metadata resolver');
    }
    let verifiedIdentity = null;
    return {
        async preflight({ candidate, plan }) {
            if (candidate.provider !== provider) throw transportError('PROVIDER_MISMATCH', `transport provider does not match ${candidate.id}`);
            verifiedIdentity = await config.resolveCurrentModel({
                candidate,
                plan,
                fetchImpl,
                headers,
                timeoutMs
            });
            return verifiedIdentity;
        },
        async execute({ candidate, fixture, contract }) {
            if (!verifiedIdentity) throw transportError('PREFLIGHT_REQUIRED', 'transport preflight must complete before execution');
            const payload = {
                model: candidate.model,
                messages: fixture.messages,
                max_tokens: contract.maxOutputTokens,
                temperature: contract.temperature,
                seed: contract.seed,
                stream: false
            };
            if (fixture.tools.length) payload.tools = fixture.tools;
            if (config.reasoningParameter) payload[config.reasoningParameter] = { enabled: contract.thinking };
            const started = Date.now();
            const response = await fetchResponse(fetchImpl, `${baseUrl}/chat/completions`, {
                method: 'POST',
                headers,
                body: JSON.stringify(payload)
            }, timeoutMs);
            const latencyMs = Date.now() - started;
            const { parsed, rawText } = await responseBody(response);
            const message = parsed?.choices?.[0]?.message || {};
            return {
                ok: response.ok && Boolean(parsed),
                observedAt: new Date().toISOString(),
                latencyMs,
                identity: verifiedIdentity,
                usage: normalizeOpenAIUsage(parsed?.usage),
                response: {
                    text: message.content == null ? '' : String(message.content),
                    toolCalls: parseToolCalls(message.tool_calls),
                    raw: parsed || { body: rawText }
                },
                error: response.ok && parsed ? null : {
                    code: String(parsed?.error?.code || `HTTP_${response.status}`),
                    message: String(parsed?.error?.message || rawText || response.statusText)
                }
            };
        }
    };
}

function decimalToScaledInteger(value, scale) {
    const match = String(value == null ? '' : value).trim().match(/^(\d+)(?:\.(\d*))?(?:e([+-]?\d+))?$/i);
    if (!match) throw transportError('INVALID_PROVIDER_PRICE', `provider price is not a non-negative decimal: ${value}`);
    const fraction = match[2] || '';
    const exponent = Number(match[3] || 0);
    const digits = BigInt(`${match[1]}${fraction}`);
    const power = scale + exponent - fraction.length;
    let result;
    if (power >= 0) {
        result = digits * (10n ** BigInt(power));
    } else {
        const divisor = 10n ** BigInt(-power);
        result = (digits + (divisor / 2n)) / divisor;
    }
    if (result > BigInt(Number.MAX_SAFE_INTEGER)) throw transportError('PROVIDER_PRICE_OVERFLOW', 'provider price exceeds safe integer range');
    return Number(result);
}

function openRouterRates(pricing = {}) {
    return {
        input: decimalToScaledInteger(pricing.prompt || 0, 15),
        output: decimalToScaledInteger(pricing.completion || 0, 15),
        cacheRead: decimalToScaledInteger(pricing.input_cache_read || 0, 15),
        cacheWrite: decimalToScaledInteger(pricing.input_cache_write || 0, 15)
    };
}

function ratesEqual(left = {}, right = {}) {
    return ['input', 'output', 'cacheRead', 'cacheWrite'].every((key) => left[key] === right[key]);
}

function createOpenRouterTransport(config = {}) {
    const modelsUrl = config.modelsUrl || OPENROUTER_MODELS_URL;
    return createOpenAICompatibleTransport({
        ...config,
        provider: 'openrouter',
        baseUrl: config.baseUrl || 'https://openrouter.ai/api/v1',
        reasoningParameter: 'reasoning',
        async resolveCurrentModel({ candidate, plan, fetchImpl, headers, timeoutMs }) {
            const response = await fetchResponse(fetchImpl, modelsUrl, { method: 'GET', headers }, timeoutMs);
            const { parsed, rawText } = await responseBody(response);
            if (!response.ok || !Array.isArray(parsed?.data)) {
                throw transportError('MODEL_CATALOG_UNAVAILABLE', `OpenRouter model catalog failed: ${response.status} ${rawText}`, 502);
            }
            const current = parsed.data.find((entry) => entry.id === candidate.model);
            if (!current) throw transportError('MODEL_NOT_CURRENT', `OpenRouter catalog does not contain ${candidate.model}`, 409);
            const modelVersion = String(current.canonical_slug || current.id);
            const contextWindow = Number(current.context_length);
            const rates = openRouterRates(current.pricing);
            if (candidate.apiVersion !== OPENROUTER_API_VERSION
                || modelVersion !== candidate.modelVersion || contextWindow !== candidate.contextWindow
                || !candidate.priceSnapshot || !ratesEqual(rates, candidate.priceSnapshot.rates)) {
                throw transportError('MODEL_OR_PRICE_DRIFT', `OpenRouter identity, context, or price drifted for ${candidate.id}`, 409);
            }
            const supported = new Set(Array.isArray(current.supported_parameters) ? current.supported_parameters : []);
            const requiredParameters = ['max_tokens', 'temperature', 'seed'];
            if (plan.contract.toolProtocol) requiredParameters.push('tools');
            if (plan.contract.thinking) requiredParameters.push('reasoning');
            const missing = requiredParameters.filter((parameter) => !supported.has(parameter));
            if (missing.length) {
                throw transportError('GENERATION_PARAMETER_UNSUPPORTED', `${candidate.id} does not advertise: ${missing.join(', ')}`, 409);
            }
            return {
                ready: true,
                checkedAt: new Date().toISOString(),
                provider: candidate.provider,
                model: candidate.model,
                modelVersion,
                apiVersion: candidate.apiVersion,
                contextWindow,
                artifactDigest: null,
                priceSnapshot: candidate.priceSnapshot
            };
        }
    });
}

function findOllamaModel(models, name) {
    return models.find((entry) => entry.name === name || entry.model === name);
}

function findContextWindow(modelInfo = {}) {
    const entry = Object.entries(modelInfo).find(([key, value]) => key.endsWith('.context_length') && Number.isFinite(Number(value)));
    return entry ? Number(entry[1]) : null;
}

function createOllamaTransport(config = {}) {
    const baseUrl = normalizedBaseUrl(config.baseUrl);
    const fetchImpl = config.fetchImpl || fetch;
    const timeoutMs = Number(config.timeoutMs) || DEFAULT_TIMEOUT_MS;
    let verifiedIdentity = null;
    return {
        async preflight({ candidate }) {
            if (candidate.provider !== 'ollama') throw transportError('PROVIDER_MISMATCH', `Ollama transport does not match ${candidate.id}`);
            const [tagsResponse, versionResponse, showResponse] = await Promise.all([
                fetchResponse(fetchImpl, `${baseUrl}/api/tags`, { method: 'GET' }, timeoutMs),
                fetchResponse(fetchImpl, `${baseUrl}/api/version`, { method: 'GET' }, timeoutMs),
                fetchResponse(fetchImpl, `${baseUrl}/api/show`, {
                    method: 'POST',
                    headers: { 'content-type': 'application/json' },
                    body: JSON.stringify({ model: candidate.model })
                }, timeoutMs)
            ]);
            const [tags, version, show] = await Promise.all([
                responseBody(tagsResponse), responseBody(versionResponse), responseBody(showResponse)
            ]);
            if (!tagsResponse.ok || !versionResponse.ok || !showResponse.ok) {
                throw transportError('OLLAMA_PREFLIGHT_FAILED', `Ollama preflight failed for ${candidate.id}`, 502);
            }
            const installed = findOllamaModel(tags.parsed?.models || [], candidate.model);
            const digest = String(installed?.digest || '');
            const contextWindow = findContextWindow(show.parsed?.model_info);
            const apiVersion = `ollama-${String(version.parsed?.version || '')}`;
            if (!installed || digest !== candidate.artifactDigest || contextWindow !== candidate.contextWindow
                || apiVersion !== candidate.apiVersion) {
                throw transportError('OLLAMA_IDENTITY_DRIFT', `Ollama model, digest, context, or API version drifted for ${candidate.id}`, 409);
            }
            verifiedIdentity = {
                ready: true,
                checkedAt: new Date().toISOString(),
                provider: candidate.provider,
                model: candidate.model,
                modelVersion: candidate.modelVersion,
                apiVersion,
                contextWindow,
                artifactDigest: digest,
                priceSnapshot: null
            };
            return verifiedIdentity;
        },
        async execute({ candidate, fixture, contract }) {
            if (!verifiedIdentity) throw transportError('PREFLIGHT_REQUIRED', 'transport preflight must complete before execution');
            const payload = {
                model: candidate.model,
                messages: fixture.messages,
                stream: false,
                think: contract.thinking,
                options: {
                    num_predict: contract.maxOutputTokens,
                    num_ctx: Math.min(candidate.contextWindow, fixture.maxInputTokens + contract.maxOutputTokens),
                    temperature: contract.temperature,
                    seed: contract.seed
                }
            };
            if (fixture.tools.length) payload.tools = fixture.tools;
            const started = Date.now();
            const response = await fetchResponse(fetchImpl, `${baseUrl}/api/chat`, {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify(payload)
            }, timeoutMs);
            const latencyMs = Date.now() - started;
            const { parsed, rawText } = await responseBody(response);
            return {
                ok: response.ok && Boolean(parsed),
                observedAt: new Date().toISOString(),
                latencyMs,
                identity: verifiedIdentity,
                usage: {
                    input: Number(parsed?.prompt_eval_count) || 0,
                    output: Number(parsed?.eval_count) || 0,
                    cacheRead: 0,
                    cacheWrite: 0
                },
                response: {
                    text: String(parsed?.message?.content || ''),
                    toolCalls: parseToolCalls(parsed?.message?.tool_calls),
                    raw: parsed || { body: rawText }
                },
                error: response.ok && parsed ? null : {
                    code: `HTTP_${response.status}`,
                    message: String(parsed?.error || rawText || response.statusText)
                }
            };
        }
    };
}

module.exports = {
    OPENROUTER_API_VERSION,
    OPENROUTER_MODELS_URL,
    createOllamaTransport,
    createOpenAICompatibleTransport,
    createOpenRouterTransport,
    decimalToScaledInteger,
    normalizeOpenAIUsage,
    openRouterRates,
    transportError
};
