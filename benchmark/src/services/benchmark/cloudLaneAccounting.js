'use strict';

const crypto = require('crypto');

const SCHEMA_VERSION = 1;
const PRICE_SCHEMA_VERSION = 1;
const RECEIPT_SCHEMA_VERSION = 1;
const APPROVAL_SCHEMA_VERSION = 1;
const NANODOLLARS_PER_USD = 1_000_000_000;
const TOKENS_PER_PRICE_UNIT = 1_000_000;
const MAX_APPROVAL_HOURS = 24;

const LANES = Object.freeze(['coding', 'tools', 'worker', 'architect', 'family', 'kid']);
const TIERS = Object.freeze(['local', 'free_cloud', 'paid_cloud']);
const LOCAL_ONLY_LANES = new Set(['family', 'kid']);
const EVIDENCE_TYPES = new Set(['synthetic', 'measured']);

function contractError(code, message, statusCode = 400) {
    const error = new Error(message);
    error.code = code;
    error.statusCode = statusCode;
    return error;
}

function stableSerialize(value) {
    if (Array.isArray(value)) return `[${value.map(stableSerialize).join(',')}]`;
    if (value && typeof value === 'object') {
        return `{${Object.keys(value).sort().map((key) => (
            `${JSON.stringify(key)}:${stableSerialize(value[key])}`
        )).join(',')}}`;
    }
    return value === undefined ? 'null' : JSON.stringify(value);
}

function fingerprint(value) {
    return crypto.createHash('sha256').update(stableSerialize(value)).digest('hex');
}

function requiredText(value, name, max = 240) {
    const text = String(value == null ? '' : value).trim();
    if (!text) throw contractError('FIELD_REQUIRED', `${name} is required`);
    if (text.length > max) throw contractError('FIELD_TOO_LONG', `${name} must be at most ${max} characters`);
    return text;
}

function optionalText(value, max = 240) {
    const text = String(value == null ? '' : value).trim();
    return text ? text.slice(0, max) : null;
}

function integer(value, name, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
    const number = Number(value);
    if (!Number.isSafeInteger(number) || number < min || number > max) {
        throw contractError('INVALID_INTEGER', `${name} must be an integer between ${min} and ${max}`);
    }
    return number;
}

function ratio(value, name) {
    const number = Number(value);
    if (!Number.isFinite(number) || number < 0 || number > 1) {
        throw contractError('INVALID_RATIO', `${name} must be between 0 and 1`);
    }
    return number;
}

function positiveNumber(value, name) {
    const number = Number(value);
    if (!Number.isFinite(number) || number < 0) {
        throw contractError('INVALID_NUMBER', `${name} must be a non-negative number`);
    }
    return number;
}

function isoTimestamp(value, name) {
    const date = new Date(requiredText(value, name, 80));
    if (Number.isNaN(date.getTime())) {
        throw contractError('INVALID_TIMESTAMP', `${name} must be an ISO-8601 timestamp`);
    }
    return date.toISOString();
}

function normalizeLane(value) {
    const lane = requiredText(value, 'lane', 40).toLowerCase();
    if (!LANES.includes(lane)) {
        throw contractError('UNKNOWN_LANE', `lane must be one of: ${LANES.join(', ')}`);
    }
    return lane;
}

function normalizeTier(value) {
    const tier = requiredText(value, 'tier', 40).toLowerCase();
    if (!TIERS.includes(tier)) {
        throw contractError('UNKNOWN_TIER', `tier must be one of: ${TIERS.join(', ')}`);
    }
    return tier;
}

function normalizeHexFingerprint(value, name) {
    const text = requiredText(value, name, 64).toLowerCase();
    if (!/^[a-f0-9]{64}$/.test(text)) {
        throw contractError('INVALID_FINGERPRINT', `${name} must be a 64-character SHA-256 fingerprint`);
    }
    return text;
}

function normalizeContract(raw = {}, laneInput) {
    const lane = normalizeLane(laneInput || raw.lane);
    const temperature = raw.temperature == null
        ? 0
        : positiveNumber(raw.temperature, 'contract.temperature');
    if (temperature > 2) {
        throw contractError('INVALID_TEMPERATURE', 'contract.temperature must be between 0 and 2');
    }
    if (raw.thinking != null && typeof raw.thinking !== 'boolean') {
        throw contractError('INVALID_BOOLEAN', 'contract.thinking must be a boolean');
    }
    const contract = {
        version: requiredText(raw.version, 'contract.version', 80),
        lane,
        suite: requiredText(raw.suite, 'contract.suite', 120),
        suiteVersion: requiredText(raw.suiteVersion, 'contract.suiteVersion', 80),
        fixtureFingerprint: normalizeHexFingerprint(raw.fixtureFingerprint, 'contract.fixtureFingerprint'),
        graderVersion: requiredText(raw.graderVersion, 'contract.graderVersion', 80),
        responseMode: requiredText(raw.responseMode, 'contract.responseMode', 80),
        maxOutputTokens: integer(raw.maxOutputTokens, 'contract.maxOutputTokens', { min: 1, max: 1_000_000 }),
        temperature,
        seed: integer(raw.seed == null ? 0 : raw.seed, 'contract.seed', { min: 0, max: 2_147_483_647 }),
        thinking: raw.thinking === true,
        toolProtocol: optionalText(raw.toolProtocol, 80)
    };
    return { ...contract, fingerprint: fingerprint(contract) };
}

function normalizePriceSnapshot(raw = {}) {
    const rates = raw.rates || {};
    const snapshot = {
        schemaVersion: PRICE_SCHEMA_VERSION,
        provider: requiredText(raw.provider, 'pricing.provider', 80).toLowerCase(),
        model: requiredText(raw.model, 'pricing.model', 180),
        modelVersion: requiredText(raw.modelVersion, 'pricing.modelVersion', 120),
        currency: requiredText(raw.currency || 'USD', 'pricing.currency', 8).toUpperCase(),
        unit: 'nanodollars_per_million_tokens',
        effectiveAt: isoTimestamp(raw.effectiveAt, 'pricing.effectiveAt'),
        source: requiredText(raw.source, 'pricing.source', 300),
        rates: {
            input: integer(rates.input, 'pricing.rates.input'),
            output: integer(rates.output, 'pricing.rates.output'),
            cacheRead: integer(rates.cacheRead || 0, 'pricing.rates.cacheRead'),
            cacheWrite: integer(rates.cacheWrite || 0, 'pricing.rates.cacheWrite')
        }
    };
    if (snapshot.currency !== 'USD') {
        throw contractError('UNSUPPORTED_CURRENCY', 'Only USD price snapshots are supported');
    }
    const computed = fingerprint(snapshot);
    if (raw.fingerprint && normalizeHexFingerprint(raw.fingerprint, 'pricing.fingerprint') !== computed) {
        throw contractError('PRICE_SNAPSHOT_TAMPERED', 'pricing fingerprint does not match its contents');
    }
    return { ...snapshot, fingerprint: computed };
}

function normalizeCandidate(raw = {}, laneInput) {
    const lane = normalizeLane(laneInput);
    const tier = normalizeTier(raw.tier);
    if (LOCAL_ONLY_LANES.has(lane) && tier !== 'local') {
        throw contractError('LOCAL_ONLY_LANE', `${lane} is a local-only lane`, 403);
    }
    const provider = requiredText(raw.provider, 'candidate.provider', 80).toLowerCase();
    const model = requiredText(raw.model, 'candidate.model', 180);
    const modelVersion = requiredText(raw.modelVersion, 'candidate.modelVersion', 120);
    const candidate = {
        id: requiredText(raw.id || `${provider}/${model}@${modelVersion}`, 'candidate.id', 240),
        tier,
        provider,
        model,
        modelVersion,
        apiVersion: requiredText(raw.apiVersion, 'candidate.apiVersion', 120),
        provenanceSource: requiredText(raw.provenanceSource, 'candidate.provenanceSource', 300),
        contextWindow: integer(raw.contextWindow, 'candidate.contextWindow', { min: 1, max: 100_000_000 }),
        artifactDigest: raw.artifactDigest
            ? normalizeHexFingerprint(raw.artifactDigest, 'candidate.artifactDigest')
            : null,
        priceSnapshot: raw.priceSnapshot ? normalizePriceSnapshot(raw.priceSnapshot) : null
    };
    if (tier === 'local' && !candidate.artifactDigest) {
        throw contractError('LOCAL_IDENTITY_REQUIRED', 'local candidates require an exact artifactDigest');
    }
    if (tier === 'paid_cloud' && !candidate.priceSnapshot) {
        throw contractError('PRICE_SNAPSHOT_REQUIRED', 'paid_cloud candidates require an immutable price snapshot');
    }
    if (candidate.priceSnapshot) {
        const price = candidate.priceSnapshot;
        if (price.provider !== provider || price.model !== model || price.modelVersion !== modelVersion) {
            throw contractError('PRICE_IDENTITY_MISMATCH', 'price snapshot provider/model/version must match the candidate');
        }
        const totalRate = Object.values(price.rates).reduce((sum, value) => sum + value, 0);
        if (tier === 'free_cloud' && totalRate !== 0) {
            throw contractError('FREE_TIER_HAS_PRICE', 'free_cloud candidates must have an all-zero price snapshot');
        }
    }
    return candidate;
}

function costComponent(tokens, rateNanodollarsPerMillion) {
    const numerator = BigInt(tokens) * BigInt(rateNanodollarsPerMillion);
    const rounded = (numerator + BigInt(TOKENS_PER_PRICE_UNIT / 2)) / BigInt(TOKENS_PER_PRICE_UNIT);
    if (rounded > BigInt(Number.MAX_SAFE_INTEGER)) {
        throw contractError('COST_OVERFLOW', 'attributed cost exceeds the safe integer range');
    }
    return {
        tokens,
        rateNanodollarsPerMillion,
        costNanodollars: Number(rounded),
        rounding: 'half_up_to_nearest_nanodollar'
    };
}

function safeSum(values, name) {
    return values.reduce((sum, value) => {
        const next = sum + value;
        if (!Number.isSafeInteger(next)) throw contractError('COST_OVERFLOW', `${name} exceeds the safe integer range`);
        return next;
    }, 0);
}

function formatNanodollarsUsd(value) {
    const amount = integer(value, 'costNanodollars');
    const whole = Math.floor(amount / NANODOLLARS_PER_USD);
    const fraction = String(amount % NANODOLLARS_PER_USD).padStart(9, '0');
    return `${whole}.${fraction}`;
}

function attributeProviderCall(raw = {}) {
    const tier = normalizeTier(raw.tier);
    if (tier === 'local') {
        throw contractError('LOCAL_CALL_NOT_BILLABLE', 'local calls do not use provider price attribution');
    }
    const provider = requiredText(raw.provider, 'provider', 80).toLowerCase();
    const model = requiredText(raw.model, 'model', 180);
    const modelVersion = requiredText(raw.modelVersion, 'modelVersion', 120);
    const pricing = normalizePriceSnapshot(raw.pricing || raw.priceSnapshot);
    if (pricing.provider !== provider || pricing.model !== model || pricing.modelVersion !== modelVersion) {
        throw contractError('PRICE_IDENTITY_MISMATCH', 'price snapshot provider/model/version must match the call');
    }
    const usageRaw = raw.usage || {};
    const usage = {
        input: integer(usageRaw.input || 0, 'usage.input'),
        output: integer(usageRaw.output || 0, 'usage.output'),
        cacheRead: integer(usageRaw.cacheRead || 0, 'usage.cacheRead'),
        cacheWrite: integer(usageRaw.cacheWrite || 0, 'usage.cacheWrite')
    };
    usage.total = safeSum(Object.values(usage), 'usage.total');
    const components = {
        input: costComponent(usage.input, pricing.rates.input),
        output: costComponent(usage.output, pricing.rates.output),
        cacheRead: costComponent(usage.cacheRead, pricing.rates.cacheRead),
        cacheWrite: costComponent(usage.cacheWrite, pricing.rates.cacheWrite)
    };
    const totalCostNanodollars = safeSum(
        Object.values(components).map((entry) => entry.costNanodollars),
        'totalCostNanodollars'
    );
    if (tier === 'free_cloud' && totalCostNanodollars !== 0) {
        throw contractError('FREE_TIER_HAS_COST', 'free_cloud calls must attribute exactly zero cost');
    }
    const receipt = {
        schemaVersion: RECEIPT_SCHEMA_VERSION,
        callId: requiredText(raw.callId, 'callId', 180),
        campaignId: requiredText(raw.campaignId, 'campaignId', 180),
        lane: normalizeLane(raw.lane),
        tier,
        provider,
        model,
        modelVersion,
        observedAt: isoTimestamp(raw.observedAt, 'observedAt'),
        usage,
        pricing,
        components,
        totalCostNanodollars,
        totalCostUsd: formatNanodollarsUsd(totalCostNanodollars)
    };
    return { ...receipt, fingerprint: fingerprint(receipt) };
}

function validateAttributionReceipt(raw = {}) {
    const expectedFingerprint = normalizeHexFingerprint(raw.fingerprint, 'receipt.fingerprint');
    const recomputed = attributeProviderCall({
        callId: raw.callId,
        campaignId: raw.campaignId,
        lane: raw.lane,
        tier: raw.tier,
        provider: raw.provider,
        model: raw.model,
        modelVersion: raw.modelVersion,
        observedAt: raw.observedAt,
        usage: raw.usage,
        pricing: raw.pricing
    });
    if (recomputed.fingerprint !== expectedFingerprint) {
        throw contractError('ATTRIBUTION_TAMPERED', 'provider-call attribution fingerprint does not match its contents');
    }
    return recomputed;
}

function buildCampaignPlan(raw = {}) {
    const lane = normalizeLane(raw.lane);
    const campaignId = requiredText(raw.campaignId, 'campaignId', 180);
    const contract = normalizeContract(raw.contract, lane);
    const candidates = (Array.isArray(raw.candidates) ? raw.candidates : []).map((candidate) => (
        normalizeCandidate(candidate, lane)
    ));
    if (candidates.length < 2) {
        throw contractError('CANDIDATES_REQUIRED', 'a lane comparison requires at least two candidates');
    }
    const ids = candidates.map((candidate) => candidate.id);
    if (new Set(ids).size !== ids.length) {
        throw contractError('DUPLICATE_CANDIDATE', 'candidate ids must be unique');
    }
    const tiers = Object.fromEntries(TIERS.map((tier) => [
        tier,
        candidates.filter((candidate) => candidate.tier === tier).map((candidate) => candidate.id).sort()
    ]));
    const hasPaid = tiers.paid_cloud.length > 0;
    const plan = {
        schemaVersion: SCHEMA_VERSION,
        campaignId,
        lane,
        contract,
        candidates,
        cohorts: tiers,
        estimatedCalls: integer(raw.estimatedCalls, 'estimatedCalls', { min: 1, max: 1_000_000 }),
        spendCeilingNanodollars: hasPaid
            ? integer(raw.spendCeilingNanodollars, 'spendCeilingNanodollars', { min: 1 })
            : 0,
        policy: {
            familyAndKidLocalOnly: true,
            paidCloudUltimateTierOnly: true,
            exactContractRequired: true,
            universalWinner: null,
            routeMutation: false,
            networkAuthorized: false
        },
        paidGate: {
            required: hasPaid,
            status: hasPaid ? 'operator_approval_required' : 'not_required',
            authenticatedExecutionRequired: hasPaid
        }
    };
    const immutable = { ...plan };
    return { ...plan, planFingerprint: fingerprint(immutable) };
}

function normalizeApproval(raw = {}) {
    const approval = {
        schemaVersion: APPROVAL_SCHEMA_VERSION,
        approvalId: requiredText(raw.approvalId, 'approval.approvalId', 180),
        campaignId: requiredText(raw.campaignId, 'approval.campaignId', 180),
        planFingerprint: normalizeHexFingerprint(raw.planFingerprint, 'approval.planFingerprint'),
        approvedBy: requiredText(raw.approvedBy, 'approval.approvedBy', 180),
        approvedAt: isoTimestamp(raw.approvedAt, 'approval.approvedAt'),
        expiresAt: isoTimestamp(raw.expiresAt, 'approval.expiresAt'),
        maxCalls: integer(raw.maxCalls, 'approval.maxCalls', { min: 1, max: 1_000_000 }),
        maxSpendNanodollars: integer(raw.maxSpendNanodollars, 'approval.maxSpendNanodollars', { min: 1 }),
        candidateIds: [...new Set((Array.isArray(raw.candidateIds) ? raw.candidateIds : [])
            .map((id) => requiredText(id, 'approval.candidateIds[]', 240)))].sort()
    };
    const computed = fingerprint(approval);
    if (raw.fingerprint && normalizeHexFingerprint(raw.fingerprint, 'approval.fingerprint') !== computed) {
        throw contractError('APPROVAL_TAMPERED', 'approval fingerprint does not match its contents', 403);
    }
    return { ...approval, fingerprint: computed };
}

function checkPaidApproval(planInput, approvalInput, options = {}) {
    const plan = planInput?.planFingerprint ? planInput : buildCampaignPlan(planInput);
    if (!plan.paidGate.required) {
        return { status: 'not_required', declarationValid: true, networkAuthorized: false };
    }
    if (!approvalInput) {
        throw contractError('PAID_APPROVAL_REQUIRED', 'paid_cloud campaigns require an operator approval declaration', 403);
    }
    const approval = normalizeApproval(approvalInput);
    const now = new Date(options.now || Date.now());
    const approvedAt = new Date(approval.approvedAt);
    const expiresAt = new Date(approval.expiresAt);
    if (approval.campaignId !== plan.campaignId || approval.planFingerprint !== plan.planFingerprint) {
        throw contractError('APPROVAL_PLAN_MISMATCH', 'approval must bind the exact campaign and plan fingerprint', 403);
    }
    const expectedCandidates = [...plan.cohorts.paid_cloud].sort();
    if (stableSerialize(approval.candidateIds) !== stableSerialize(expectedCandidates)) {
        throw contractError('APPROVAL_CANDIDATE_MISMATCH', 'approval must name every paid candidate and no others', 403);
    }
    if (approval.maxCalls !== plan.estimatedCalls
        || approval.maxSpendNanodollars !== plan.spendCeilingNanodollars) {
        throw contractError('APPROVAL_CEILING_MISMATCH', 'approval call and spend ceilings must exactly match the plan', 403);
    }
    if (approvedAt > now || expiresAt <= now || expiresAt <= approvedAt) {
        throw contractError('APPROVAL_NOT_ACTIVE', 'approval must be active for the current time', 403);
    }
    if ((expiresAt - approvedAt) > MAX_APPROVAL_HOURS * 3600_000) {
        throw contractError('APPROVAL_TOO_LONG', `approval may be valid for at most ${MAX_APPROVAL_HOURS} hours`, 403);
    }
    return {
        status: 'declaration_valid',
        declarationValid: true,
        approval,
        networkAuthorized: false,
        reason: 'The stateless Benchmark contract validates scope only; an authenticated operator execution boundary is still required.'
    };
}

function normalizeObservation(raw = {}, laneInput) {
    const lane = normalizeLane(laneInput || raw.lane);
    const candidate = normalizeCandidate(raw.candidate || {}, lane);
    const contract = normalizeContract(raw.contract || {}, lane);
    const attempts = integer(raw.attempts, 'observation.attempts', { min: 1, max: 1_000_000 });
    const successes = integer(raw.successes, 'observation.successes', { min: 0, max: attempts });
    const evidenceType = requiredText(raw.evidenceType, 'observation.evidenceType', 40).toLowerCase();
    if (!EVIDENCE_TYPES.has(evidenceType)) {
        throw contractError('UNKNOWN_EVIDENCE_TYPE', 'observation.evidenceType must be synthetic or measured');
    }
    const observation = {
        schemaVersion: SCHEMA_VERSION,
        campaignId: requiredText(raw.campaignId, 'observation.campaignId', 180),
        lane,
        evidenceType,
        candidate,
        contract,
        observedAt: isoTimestamp(raw.observedAt, 'observation.observedAt'),
        attempts,
        successes,
        metrics: {
            qualityScore: ratio(raw.metrics?.qualityScore, 'observation.metrics.qualityScore'),
            latencyMs: positiveNumber(raw.metrics?.latencyMs, 'observation.metrics.latencyMs'),
            availabilityRate: successes / attempts,
            contextTokens: integer(raw.metrics?.contextTokens, 'observation.metrics.contextTokens', {
                min: 1,
                max: candidate.contextWindow
            })
        },
        attribution: raw.attribution ? validateAttributionReceipt(raw.attribution) : null
    };
    if (candidate.tier === 'paid_cloud' && !observation.attribution) {
        throw contractError('PAID_ATTRIBUTION_REQUIRED', 'every paid_cloud observation requires an untampered per-call attribution receipt');
    }
    if (observation.attribution) {
        const receipt = observation.attribution;
        if (receipt.campaignId !== observation.campaignId
            || receipt.lane !== lane
            || receipt.tier !== candidate.tier
            || receipt.provider !== candidate.provider
            || receipt.model !== candidate.model
            || receipt.modelVersion !== candidate.modelVersion) {
            throw contractError('ATTRIBUTION_OBSERVATION_MISMATCH', 'attribution must match the observation campaign, lane, tier, and provider identity');
        }
    }
    const unsigned = { ...observation };
    return { ...observation, fingerprint: fingerprint(unsigned) };
}

function candidateKey(candidate) {
    return [candidate.tier, candidate.provider, candidate.model, candidate.modelVersion].join('::');
}

function average(values) {
    return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
}

function round(value, digits = 6) {
    const scale = 10 ** digits;
    return Math.round(value * scale) / scale;
}

function cohortSummary(observations) {
    const grouped = new Map();
    for (const observation of observations) {
        const key = candidateKey(observation.candidate);
        if (!grouped.has(key)) grouped.set(key, []);
        grouped.get(key).push(observation);
    }
    const candidates = [...grouped.values()].map((rows) => {
        const first = rows[0];
        const attempts = rows.reduce((sum, row) => sum + row.attempts, 0);
        const successes = rows.reduce((sum, row) => sum + row.successes, 0);
        return {
            candidate: first.candidate,
            evidenceType: rows.every((row) => row.evidenceType === 'measured') ? 'measured' : 'contains_synthetic',
            observations: rows.length,
            attempts,
            successes,
            qualityScore: round(average(rows.map((row) => row.metrics.qualityScore))),
            latencyMs: round(average(rows.map((row) => row.metrics.latencyMs)), 3),
            availabilityRate: round(successes / attempts),
            contextTokens: Math.min(...rows.map((row) => row.metrics.contextTokens)),
            costNanodollars: safeSum(rows.map((row) => row.attribution?.totalCostNanodollars || 0), 'candidate cost')
        };
    });
    if (!candidates.length) return { candidates: [], leader: null };
    const latencies = candidates.map((entry) => entry.latencyMs);
    const minLatency = Math.min(...latencies);
    const maxLatency = Math.max(...latencies);
    for (const entry of candidates) {
        const latencyScore = maxLatency === minLatency ? 1 : 1 - ((entry.latencyMs - minLatency) / (maxLatency - minLatency));
        entry.cohortScore = round((entry.qualityScore * 0.55) + (entry.availabilityRate * 0.30) + (latencyScore * 0.15));
    }
    candidates.sort((left, right) => right.cohortScore - left.cohortScore || left.candidate.id.localeCompare(right.candidate.id));
    return { candidates, leader: candidates[0].candidate.id };
}

function compareLaneObservations(raw = {}) {
    const lane = normalizeLane(raw.lane);
    const observations = (Array.isArray(raw.observations) ? raw.observations : []).map((observation) => (
        normalizeObservation(observation, lane)
    ));
    if (observations.length < 2) {
        throw contractError('OBSERVATIONS_REQUIRED', 'a comparison requires at least two observations');
    }
    const contractGroups = new Map();
    for (const observation of observations) {
        const key = observation.contract.fingerprint;
        if (!contractGroups.has(key)) contractGroups.set(key, []);
        contractGroups.get(key).push(observation);
    }
    const groups = [...contractGroups.entries()].map(([contractFingerprint, rows]) => {
        const cohorts = Object.fromEntries(TIERS.map((tier) => [
            tier,
            cohortSummary(rows.filter((row) => row.candidate.tier === tier))
        ]));
        const presentTiers = TIERS.filter((tier) => cohorts[tier].candidates.length > 0);
        return {
            contractFingerprint,
            contract: rows[0].contract,
            observationCount: rows.length,
            comparableTiers: presentTiers,
            crossTierComparable: presentTiers.length >= 2,
            cohorts,
            leadersByCohort: Object.fromEntries(TIERS.map((tier) => [tier, cohorts[tier].leader]))
        };
    }).sort((left, right) => left.contractFingerprint.localeCompare(right.contractFingerprint));
    const paidCostNanodollars = safeSum(
        observations.map((row) => row.attribution?.totalCostNanodollars || 0),
        'report paid cost'
    );
    const evidenceTypes = new Set(observations.map((row) => row.evidenceType));
    const report = {
        schemaVersion: SCHEMA_VERSION,
        generatedAt: raw.generatedAt ? isoTimestamp(raw.generatedAt, 'generatedAt') : new Date().toISOString(),
        lane,
        observationCount: observations.length,
        evidenceScope: evidenceTypes.size === 1 ? [...evidenceTypes][0] : 'mixed',
        exactContractComparable: groups.length === 1,
        contractGroups: groups,
        paidCostNanodollars,
        paidCostUsd: formatNanodollarsUsd(paidCostNanodollars),
        universalWinner: null,
        routeMutation: false,
        networkAuthorized: false,
        policy: {
            familyAndKidLocalOnly: true,
            paidCloudUltimateTierOnly: true,
            resultsAreLaneSpecific: true,
            syntheticEvidenceIsNotPerformanceEvidence: true
        }
    };
    return { ...report, fingerprint: fingerprint(report) };
}

module.exports = {
    APPROVAL_SCHEMA_VERSION,
    LANES,
    LOCAL_ONLY_LANES,
    NANODOLLARS_PER_USD,
    PRICE_SCHEMA_VERSION,
    RECEIPT_SCHEMA_VERSION,
    SCHEMA_VERSION,
    TIERS,
    attributeProviderCall,
    buildCampaignPlan,
    checkPaidApproval,
    compareLaneObservations,
    fingerprint,
    formatNanodollarsUsd,
    normalizeCandidate,
    normalizeContract,
    normalizeObservation,
    normalizePriceSnapshot,
    stableSerialize,
    validateAttributionReceipt
};
