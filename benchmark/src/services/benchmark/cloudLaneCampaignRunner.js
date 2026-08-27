'use strict';

const {
    attributeProviderCall,
    buildCampaignPlan,
    checkPaidApproval,
    compareLaneObservations,
    fingerprint,
    normalizeCandidate,
    normalizeContract,
    stableSerialize
} = require('./cloudLaneAccounting');

const EXECUTION_SCHEMA_VERSION = 1;
const BUILTIN_GRADER_VERSION = 'agentx-builtins-v1';
const GRADER_TYPES = new Set(['contains_all', 'exact_text', 'json_exact', 'json_subset', 'tool_call']);

function runnerError(code, message, statusCode = 400) {
    const error = new Error(message);
    error.code = code;
    error.statusCode = statusCode;
    return error;
}

function text(value, name, max = 4000) {
    const normalized = String(value == null ? '' : value).trim();
    if (!normalized) throw runnerError('FIELD_REQUIRED', `${name} is required`);
    if (normalized.length > max) throw runnerError('FIELD_TOO_LONG', `${name} must be at most ${max} characters`);
    return normalized;
}

function integer(value, name, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
    const normalized = Number(value);
    if (!Number.isSafeInteger(normalized) || normalized < min || normalized > max) {
        throw runnerError('INVALID_INTEGER', `${name} must be an integer between ${min} and ${max}`);
    }
    return normalized;
}

function isoTimestamp(value, name) {
    const date = new Date(text(value, name, 80));
    if (Number.isNaN(date.getTime())) throw runnerError('INVALID_TIMESTAMP', `${name} must be an ISO-8601 timestamp`);
    return date.toISOString();
}

function normalizeMessages(raw, fixtureId) {
    if (!Array.isArray(raw) || raw.length === 0) {
        throw runnerError('MESSAGES_REQUIRED', `fixture ${fixtureId} requires at least one message`);
    }
    return raw.map((message, index) => {
        if (!message || typeof message !== 'object' || Array.isArray(message)) {
            throw runnerError('INVALID_MESSAGE', `fixture ${fixtureId} message ${index} must be an object`);
        }
        return {
            role: text(message.role, `fixture ${fixtureId} message ${index}.role`, 40),
            content: String(message.content == null ? '' : message.content)
        };
    });
}

function normalizeTools(raw, fixtureId) {
    if (raw == null) return [];
    if (!Array.isArray(raw)) throw runnerError('INVALID_TOOLS', `fixture ${fixtureId} tools must be an array`);
    return JSON.parse(JSON.stringify(raw));
}

function normalizeGrader(raw = {}, fixtureId) {
    const type = text(raw.type, `fixture ${fixtureId} grader.type`, 40).toLowerCase();
    if (!GRADER_TYPES.has(type)) {
        throw runnerError('UNKNOWN_GRADER', `fixture ${fixtureId} grader.type must be one of: ${[...GRADER_TYPES].join(', ')}`);
    }
    const grader = { type };
    if (type === 'exact_text') grader.expected = String(raw.expected == null ? '' : raw.expected);
    if (type === 'contains_all') {
        if (!Array.isArray(raw.expected) || raw.expected.length === 0) {
            throw runnerError('GRADER_EXPECTED_REQUIRED', `fixture ${fixtureId} contains_all requires expected strings`);
        }
        grader.expected = raw.expected.map((value) => String(value));
        grader.caseSensitive = raw.caseSensitive === true;
    }
    if (type === 'json_exact' || type === 'json_subset') {
        if (raw.expected == null || typeof raw.expected !== 'object') {
            throw runnerError('GRADER_EXPECTED_REQUIRED', `fixture ${fixtureId} ${type} requires an expected JSON value`);
        }
        grader.expected = JSON.parse(JSON.stringify(raw.expected));
    }
    if (type === 'tool_call') {
        grader.name = text(raw.name, `fixture ${fixtureId} grader.name`, 180);
        if (raw.arguments != null) grader.arguments = JSON.parse(JSON.stringify(raw.arguments));
    }
    return grader;
}

function normalizeFixtureSuite(raw = {}) {
    const suite = text(raw.suite, 'fixtures.suite', 120);
    const suiteVersion = text(raw.suiteVersion, 'fixtures.suiteVersion', 80);
    if (!Array.isArray(raw.fixtures) || raw.fixtures.length === 0) {
        throw runnerError('FIXTURES_REQUIRED', 'fixtures.fixtures requires at least one fixture');
    }
    const fixtures = raw.fixtures.map((fixture, index) => {
        const id = text(fixture?.id, `fixtures.fixtures[${index}].id`, 180);
        return {
            id,
            messages: normalizeMessages(fixture.messages, id),
            tools: normalizeTools(fixture.tools, id),
            grader: normalizeGrader(fixture.grader, id),
            maxInputTokens: integer(fixture.maxInputTokens, `fixture ${id}.maxInputTokens`, { min: 1, max: 10_000_000 }),
            maxCacheReadTokens: integer(fixture.maxCacheReadTokens || 0, `fixture ${id}.maxCacheReadTokens`, { max: 10_000_000 }),
            maxCacheWriteTokens: integer(fixture.maxCacheWriteTokens || 0, `fixture ${id}.maxCacheWriteTokens`, { max: 10_000_000 })
        };
    });
    const ids = fixtures.map((fixture) => fixture.id);
    if (new Set(ids).size !== ids.length) throw runnerError('DUPLICATE_FIXTURE', 'fixture ids must be unique');
    const normalized = { suite, suiteVersion, fixtures };
    return { ...normalized, fingerprint: fingerprint(normalized) };
}

function verifyPlan(planInput, suite, attempts) {
    const plan = buildCampaignPlan(planInput);
    if (planInput.planFingerprint && planInput.planFingerprint !== plan.planFingerprint) {
        throw runnerError('PLAN_TAMPERED', 'plan fingerprint does not match the normalized campaign plan', 403);
    }
    if (plan.contract.suite !== suite.suite || plan.contract.suiteVersion !== suite.suiteVersion
        || plan.contract.fixtureFingerprint !== suite.fingerprint) {
        throw runnerError(
            'FIXTURE_CONTRACT_MISMATCH',
            `fixture suite identity must match the exact campaign contract; computed fixture fingerprint: ${suite.fingerprint}`
        );
    }
    if (plan.contract.responseMode !== 'final_only') {
        throw runnerError('RESPONSE_MODE_UNSUPPORTED', 'the measured runner supports only responseMode final_only');
    }
    if (suite.fixtures.some((fixture) => fixture.tools.length > 0)
        && plan.contract.toolProtocol !== 'openai-tools-v1') {
        throw runnerError('TOOL_PROTOCOL_UNSUPPORTED', 'tool fixtures require toolProtocol openai-tools-v1');
    }
    const expectedCalls = plan.candidates.length * suite.fixtures.length * attempts;
    if (plan.estimatedCalls !== expectedCalls) {
        throw runnerError('CALL_COUNT_MISMATCH', `estimatedCalls must equal candidates × fixtures × attempts (${expectedCalls})`);
    }
    return plan;
}

function normalizeAuthorization(raw = {}, plan, paidApproval, now) {
    if (raw.authorized !== true) throw runnerError('EXECUTION_NOT_AUTHORIZED', 'execution authorization was denied', 403);
    const authorization = {
        schemaVersion: EXECUTION_SCHEMA_VERSION,
        authorizationId: text(raw.authorizationId, 'authorization.authorizationId', 180),
        authenticatedActor: text(raw.authenticatedActor, 'authorization.authenticatedActor', 180),
        authenticationMethod: text(raw.authenticationMethod, 'authorization.authenticationMethod', 120),
        authenticatedAt: isoTimestamp(raw.authenticatedAt, 'authorization.authenticatedAt'),
        planFingerprint: text(raw.planFingerprint, 'authorization.planFingerprint', 64).toLowerCase(),
        maxCalls: integer(raw.maxCalls, 'authorization.maxCalls', { min: 1, max: 1_000_000 }),
        maxSpendNanodollars: integer(raw.maxSpendNanodollars || 0, 'authorization.maxSpendNanodollars'),
        paidApprovalFingerprint: raw.paidApprovalFingerprint
            ? text(raw.paidApprovalFingerprint, 'authorization.paidApprovalFingerprint', 64).toLowerCase()
            : null
    };
    if (!/^[a-f0-9]{64}$/.test(authorization.planFingerprint)
        || authorization.planFingerprint !== plan.planFingerprint) {
        throw runnerError('AUTHORIZATION_PLAN_MISMATCH', 'authorization must bind the exact plan fingerprint', 403);
    }
    if (authorization.maxCalls !== plan.estimatedCalls
        || authorization.maxSpendNanodollars !== plan.spendCeilingNanodollars) {
        throw runnerError('AUTHORIZATION_CEILING_MISMATCH', 'authorization ceilings must exactly match the plan', 403);
    }
    if (Math.abs(new Date(authorization.authenticatedAt) - now) > 15 * 60_000) {
        throw runnerError('AUTHORIZATION_STALE', 'execution authorization must be authenticated within 15 minutes', 403);
    }
    if (paidApproval) {
        if (authorization.paidApprovalFingerprint !== paidApproval.fingerprint) {
            throw runnerError('AUTHORIZATION_APPROVAL_MISMATCH', 'paid execution authorization must bind the paid approval', 403);
        }
    } else if (authorization.paidApprovalFingerprint) {
        throw runnerError('UNEXPECTED_PAID_APPROVAL', 'non-paid execution must not claim a paid approval', 403);
    }
    return { ...authorization, fingerprint: fingerprint(authorization) };
}

function sameIdentity(actual = {}, candidate) {
    return actual.provider === candidate.provider
        && actual.model === candidate.model
        && actual.modelVersion === candidate.modelVersion
        && actual.apiVersion === candidate.apiVersion
        && actual.contextWindow === candidate.contextWindow
        && (candidate.artifactDigest == null || actual.artifactDigest === candidate.artifactDigest)
        && (candidate.priceSnapshot == null || actual.priceSnapshot?.fingerprint === candidate.priceSnapshot.fingerprint);
}

function validatePreflight(raw, candidate) {
    if (!raw || raw.ready !== true) throw runnerError('PREFLIGHT_NOT_READY', `preflight rejected candidate ${candidate.id}`);
    const actual = {
        provider: String(raw.provider || '').trim().toLowerCase(),
        model: String(raw.model || '').trim(),
        modelVersion: String(raw.modelVersion || '').trim(),
        apiVersion: String(raw.apiVersion || '').trim(),
        contextWindow: Number(raw.contextWindow),
        artifactDigest: raw.artifactDigest || null,
        priceSnapshot: raw.priceSnapshot || null
    };
    if (!sameIdentity(actual, candidate)) {
        throw runnerError('PREFLIGHT_IDENTITY_DRIFT', `current provider/model/artifact/price identity drifted for ${candidate.id}`, 409);
    }
    return { ...actual, checkedAt: isoTimestamp(raw.checkedAt, 'preflight.checkedAt') };
}

function jsonSubset(actual, expected) {
    if (expected === null || typeof expected !== 'object') return stableSerialize(actual) === stableSerialize(expected);
    if (actual === null || typeof actual !== 'object') return false;
    return Object.keys(expected).every((key) => Object.prototype.hasOwnProperty.call(actual, key)
        && jsonSubset(actual[key], expected[key]));
}

function gradeResponse(grader, response, externalGrader) {
    if (externalGrader) return externalGrader(grader, response);
    const output = String(response.text == null ? '' : response.text);
    if (grader.type === 'exact_text') return { score: output.trim() === grader.expected.trim() ? 1 : 0 };
    if (grader.type === 'contains_all') {
        const source = grader.caseSensitive ? output : output.toLowerCase();
        const expected = grader.caseSensitive ? grader.expected : grader.expected.map((value) => value.toLowerCase());
        return { score: expected.filter((value) => source.includes(value)).length / expected.length };
    }
    if (grader.type === 'json_exact' || grader.type === 'json_subset') {
        try {
            const parsed = JSON.parse(output);
            const matches = grader.type === 'json_exact'
                ? stableSerialize(parsed) === stableSerialize(grader.expected)
                : jsonSubset(parsed, grader.expected);
            return { score: matches ? 1 : 0 };
        } catch (_) {
            return { score: 0 };
        }
    }
    const calls = Array.isArray(response.toolCalls) ? response.toolCalls : [];
    const matching = calls.find((call) => call.name === grader.name);
    if (!matching) return { score: 0 };
    return {
        score: grader.arguments == null || jsonSubset(matching.arguments, grader.arguments) ? 1 : 0
    };
}

function resolveGrader(contract, externalGrader) {
    if (externalGrader == null) {
        if (contract.graderVersion !== BUILTIN_GRADER_VERSION) {
            throw runnerError('GRADER_VERSION_UNAVAILABLE', `built-in graders require graderVersion ${BUILTIN_GRADER_VERSION}`);
        }
        return null;
    }
    if (typeof externalGrader !== 'object' || typeof externalGrader.grade !== 'function'
        || String(externalGrader.version || '') !== contract.graderVersion) {
        throw runnerError('GRADER_VERSION_MISMATCH', 'external grader callback must bind the exact contract graderVersion');
    }
    return externalGrader.grade;
}

function normalizeUsage(raw = {}, fixture, contract) {
    const usage = {
        input: integer(raw.input || 0, 'result.usage.input'),
        output: integer(raw.output || 0, 'result.usage.output'),
        cacheRead: integer(raw.cacheRead || 0, 'result.usage.cacheRead'),
        cacheWrite: integer(raw.cacheWrite || 0, 'result.usage.cacheWrite')
    };
    if (usage.input > fixture.maxInputTokens || usage.output > contract.maxOutputTokens
        || usage.cacheRead > fixture.maxCacheReadTokens || usage.cacheWrite > fixture.maxCacheWriteTokens) {
        throw runnerError('TOKEN_CEILING_EXCEEDED', `provider usage exceeded a frozen token ceiling for fixture ${fixture.id}`, 409);
    }
    return usage;
}

function ceilingAttribution(plan, candidate, fixture, callId, now) {
    return attributeProviderCall({
        callId,
        campaignId: plan.campaignId,
        lane: plan.lane,
        tier: candidate.tier,
        provider: candidate.provider,
        model: candidate.model,
        modelVersion: candidate.modelVersion,
        observedAt: now.toISOString(),
        pricing: candidate.priceSnapshot,
        usage: {
            input: fixture.maxInputTokens,
            output: plan.contract.maxOutputTokens,
            cacheRead: fixture.maxCacheReadTokens,
            cacheWrite: fixture.maxCacheWriteTokens
        }
    });
}

function assertPaidBudget(plan, candidate, fixture, counters, callId, now) {
    if (candidate.tier !== 'paid_cloud') return;
    if (counters.calls + 1 > plan.estimatedCalls) {
        throw runnerError('CALL_CEILING_EXCEEDED', 'paid call ceiling would be exceeded', 403);
    }
    const ceiling = ceilingAttribution(plan, candidate, fixture, callId, now).totalCostNanodollars;
    if (counters.spendNanodollars + ceiling > plan.spendCeilingNanodollars) {
        throw runnerError('SPEND_CEILING_EXCEEDED', 'worst-case paid call cost would exceed the spend ceiling', 403);
    }
}

function normalizeResult(raw = {}, candidate, fixture, contract) {
    const identity = raw.identity || {};
    if (!sameIdentity({
        provider: String(identity.provider || '').trim().toLowerCase(),
        model: String(identity.model || '').trim(),
        modelVersion: String(identity.modelVersion || '').trim(),
        apiVersion: String(identity.apiVersion || '').trim(),
        contextWindow: Number(identity.contextWindow),
        artifactDigest: identity.artifactDigest || null,
        priceSnapshot: identity.priceSnapshot || null
    }, candidate)) {
        throw runnerError('RESPONSE_IDENTITY_DRIFT', `response identity drifted for ${candidate.id}`, 409);
    }
    const latencyMs = Number(raw.latencyMs);
    if (!Number.isFinite(latencyMs) || latencyMs < 0) {
        throw runnerError('INVALID_LATENCY', 'result.latencyMs must be a non-negative number');
    }
    return {
        ok: raw.ok === true,
        observedAt: isoTimestamp(raw.observedAt, 'result.observedAt'),
        latencyMs,
        usage: normalizeUsage(raw.usage, fixture, contract),
        response: {
            text: String(raw.response?.text == null ? '' : raw.response.text),
            toolCalls: Array.isArray(raw.response?.toolCalls) ? raw.response.toolCalls : [],
            raw: raw.response?.raw == null ? null : raw.response.raw
        },
        error: raw.error ? { code: String(raw.error.code || 'PROVIDER_ERROR'), message: String(raw.error.message || '') } : null
    };
}

function validateExecutionReceipt(raw = {}) {
    const supplied = String(raw.fingerprint || '').toLowerCase();
    if (!/^[a-f0-9]{64}$/.test(supplied)) {
        throw runnerError('INVALID_EXECUTION_RECEIPT', 'execution receipt requires a SHA-256 fingerprint');
    }
    const { fingerprint: ignored, ...body } = raw;
    if (fingerprint(body) !== supplied) {
        throw runnerError('EXECUTION_RECEIPT_TAMPERED', 'execution receipt fingerprint does not match its contents');
    }
    return { ...body, fingerprint: supplied };
}

function prepareCampaign(options = {}) {
    const attempts = integer(options.attempts == null ? 1 : options.attempts, 'attempts', { min: 1, max: 1000 });
    const suite = normalizeFixtureSuite(options.fixtures);
    const plan = verifyPlan(options.plan, suite, attempts);
    const prepared = {
        schemaVersion: EXECUTION_SCHEMA_VERSION,
        plan,
        fixtureSuite: suite,
        attempts,
        networkAuthorized: false,
        routeMutation: false
    };
    return { ...prepared, fingerprint: fingerprint(prepared) };
}

async function executeCampaign(options = {}) {
    const prepared = prepareCampaign(options);
    const { attempts, fixtureSuite: suite, plan } = prepared;
    const grader = resolveGrader(plan.contract, options.externalGrader);
    const now = new Date(options.now || Date.now());
    if (typeof options.authorizeExecution !== 'function') {
        throw runnerError('EXECUTION_AUTHORIZATION_REQUIRED', 'an authenticated execution callback is required', 403);
    }
    let paidApproval = null;
    if (plan.paidGate.required) {
        paidApproval = checkPaidApproval(plan, options.paidApproval, { now }).approval;
    }
    const authorizationRaw = await options.authorizeExecution({
        plan,
        paidApproval,
        requestedCalls: plan.estimatedCalls,
        requestedSpendNanodollars: plan.spendCeilingNanodollars
    });
    const authorization = normalizeAuthorization(authorizationRaw, plan, paidApproval, now);
    const transports = options.transports || {};
    const preflights = {};
    for (const candidate of plan.candidates) {
        if (candidate.tier !== 'local' && !candidate.priceSnapshot) {
            throw runnerError('CURRENT_PRICE_REQUIRED', `real cloud candidate ${candidate.id} requires an immutable current price snapshot`);
        }
        const transport = transports[candidate.id];
        if (!transport || typeof transport.preflight !== 'function' || typeof transport.execute !== 'function') {
            throw runnerError('TRANSPORT_REQUIRED', `candidate ${candidate.id} requires injected preflight and execute functions`);
        }
        preflights[candidate.id] = validatePreflight(await transport.preflight({ candidate, plan }), candidate);
    }
    const counters = { calls: 0, paidCalls: 0, spendNanodollars: 0 };
    const calls = [];
    const observations = [];
    for (const candidate of plan.candidates) {
        for (const fixture of suite.fixtures) {
            for (let attempt = 1; attempt <= attempts; attempt += 1) {
                const callId = `${plan.campaignId}:${candidate.id}:${fixture.id}:${attempt}`;
                assertPaidBudget(plan, candidate, fixture, counters, callId, now);
                const raw = await transports[candidate.id].execute({
                    callId,
                    candidate,
                    fixture,
                    contract: plan.contract,
                    plan,
                    attempt,
                    authorization
                });
                const result = normalizeResult(raw, candidate, fixture, plan.contract);
                counters.calls += 1;
                let attribution = null;
                if (candidate.tier !== 'local') {
                    attribution = attributeProviderCall({
                        callId,
                        campaignId: plan.campaignId,
                        lane: plan.lane,
                        tier: candidate.tier,
                        provider: candidate.provider,
                        model: candidate.model,
                        modelVersion: candidate.modelVersion,
                        observedAt: result.observedAt,
                        pricing: candidate.priceSnapshot,
                        usage: result.usage
                    });
                }
                if (candidate.tier === 'paid_cloud') {
                    counters.paidCalls += 1;
                    counters.spendNanodollars += attribution.totalCostNanodollars;
                    if (counters.paidCalls > plan.estimatedCalls
                        || counters.spendNanodollars > plan.spendCeilingNanodollars) {
                        throw runnerError('PAID_CEILING_EXCEEDED', 'paid execution exceeded an approved ceiling', 403);
                    }
                }
                const graded = result.ok ? await gradeResponse(fixture.grader, result.response, grader) : { score: 0 };
                const score = Number(graded?.score);
                if (!Number.isFinite(score) || score < 0 || score > 1) {
                    throw runnerError('INVALID_GRADE', `grader returned an invalid score for ${fixture.id}`);
                }
                const receiptBody = {
                    schemaVersion: EXECUTION_SCHEMA_VERSION,
                    callId,
                    campaignId: plan.campaignId,
                    candidateId: candidate.id,
                    fixtureId: fixture.id,
                    attempt,
                    observedAt: result.observedAt,
                    latencyMs: result.latencyMs,
                    ok: result.ok,
                    usage: result.usage,
                    qualityScore: score,
                    responseFingerprint: fingerprint(result.response),
                    attributionFingerprint: attribution?.fingerprint || null,
                    authorizationFingerprint: authorization.fingerprint
                };
                const executionReceipt = { ...receiptBody, fingerprint: fingerprint(receiptBody) };
                calls.push({
                    candidate: normalizeCandidate(candidate, plan.lane),
                    fixtureId: fixture.id,
                    attempt,
                    result,
                    qualityScore: score,
                    attribution,
                    executionReceipt
                });
                observations.push({
                    campaignId: plan.campaignId,
                    lane: plan.lane,
                    evidenceType: 'measured',
                    candidate,
                    contract: normalizeContract(plan.contract, plan.lane),
                    observedAt: result.observedAt,
                    attempts: 1,
                    successes: result.ok ? 1 : 0,
                    metrics: {
                        qualityScore: score,
                        latencyMs: result.latencyMs,
                        contextTokens: Math.min(candidate.contextWindow, fixture.maxInputTokens)
                    },
                    attribution
                });
            }
        }
    }
    const comparison = compareLaneObservations({ lane: plan.lane, observations, generatedAt: now.toISOString() });
    const artifactBody = {
        schemaVersion: EXECUTION_SCHEMA_VERSION,
        generatedAt: now.toISOString(),
        plan,
        fixtureSuite: suite,
        attempts,
        authorization,
        preflights,
        calls,
        counters,
        comparison,
        universalWinner: null,
        routeMutation: false,
        networkAuthorized: false
    };
    return { ...artifactBody, fingerprint: fingerprint(artifactBody) };
}

module.exports = {
    BUILTIN_GRADER_VERSION,
    EXECUTION_SCHEMA_VERSION,
    executeCampaign,
    gradeResponse,
    normalizeFixtureSuite,
    prepareCampaign,
    runnerError,
    validateExecutionReceipt
};
