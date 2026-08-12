/**
 * Multi-Judge Config Resolver
 *
 * The route layer accepts `multi_judge` as null, a rule string, or a full
 * config object. The downstream services (multiJudge.js, judgeExecutor.js)
 * require the canonical object shape:
 *
 *   {
 *     enabled: boolean,
 *     judges: [{ model, host }, ...],
 *     tiebreaker: { model, host } | null,
 *     autoMinLevel: number,
 *     escalateOnHighLevel: boolean,
 *     escalateOnLowConfidence: boolean,
 *     escalateOnReview: boolean,
 *     escalateOnJudgeFailure: boolean,
 *     confidenceThreshold: number,
 *     rule: string  // for telemetry/UI display
 *   }
 *
 * This module is the single place that maps inputs onto that shape.
 * Default is OFF — multi-judge costs 1–2 extra judge calls per result.
 */

const fs = require('fs');
const path = require('path');

const DEFAULTS_PATH = path.join(process.cwd(), 'config', 'judge-host-defaults.json');

const RULES = {
    OFF: 'off',
    LEVEL_4_5: 'l4l5',
    LOW_CONFIDENCE: 'low_confidence',
    ALWAYS: 'always',
    CUSTOM: 'custom'
};

function readHostDefaults() {
    try {
        if (!fs.existsSync(DEFAULTS_PATH)) return {};
        return JSON.parse(fs.readFileSync(DEFAULTS_PATH, 'utf8')) || {};
    } catch {
        return {};
    }
}

function judgesFromHostDefaults(hostDefaults) {
    return Object.entries(hostDefaults)
        .filter(([host, model]) => host && model)
        .map(([host, model]) => ({ host, model }));
}

/** Pick the strongest judge as default tiebreaker — prefer 14b over 7b. */
function pickTiebreaker(judges) {
    if (!judges || judges.length < 3) return null;
    const sorted = [...judges].sort((a, b) => {
        const aSize = /(\d+)b/i.exec(a.model || '')?.[1] || 0;
        const bSize = /(\d+)b/i.exec(b.model || '')?.[1] || 0;
        return Number(bSize) - Number(aSize);
    });
    return sorted[0];
}

function inferJudgeFamily(model) {
    const raw = String(model || '').toLowerCase();
    if (!raw) return 'unknown';
    if (raw.includes('devstral') || raw.includes('mistral') || raw.includes('mixtral')) return 'mistral';
    if (raw.includes('qwen') || raw.includes('qwq')) return 'qwen';
    if (raw.includes('llama') || raw.includes('codellama')) return 'llama';
    if (raw.includes('gemma')) return 'gemma';
    if (raw.includes('deepseek')) return 'deepseek';
    if (raw.includes('phi')) return 'phi';
    if (raw.includes('command-r') || raw.includes('commandr')) return 'cohere';
    const first = raw.split(/[/:@_-]/).find(Boolean);
    return first || 'unknown';
}

function validateJudgeFamilies(judges) {
    const families = [...new Set((judges || []).map((judge) => inferJudgeFamily(judge.model)))];
    const warnings = [];
    if (families.length === 1 && families[0] !== 'unknown' && judges.length >= 2) {
        warnings.push(`Multi-judge panel uses one model family (${families[0]}), so consensus may share correlated errors`);
    }
    return { families, warnings };
}

function withFamilyValidation(config) {
    if (!config.enabled || !Array.isArray(config.judges) || config.judges.length < 2) {
        return config;
    }
    const validation = validateJudgeFamilies(config.judges);
    return {
        ...config,
        judge_families: validation.families,
        family_warnings: validation.warnings
    };
}

function disabledConfig(rule = RULES.OFF) {
    return {
        enabled: false,
        rule,
        judges: [],
        tiebreaker: null,
        autoMinLevel: 4,
        escalateOnHighLevel: false,
        escalateOnLowConfidence: false,
        escalateOnReview: false,
        escalateOnJudgeFailure: false,
        confidenceThreshold: 0.8
    };
}

function applyRuleFlags(rule) {
    switch (rule) {
        case RULES.LEVEL_4_5:
            return {
                escalateOnHighLevel: true,
                escalateOnLowConfidence: false,
                escalateOnReview: false,
                escalateOnJudgeFailure: false,
                autoMinLevel: 4
            };
        case RULES.LOW_CONFIDENCE:
            return {
                escalateOnHighLevel: false,
                escalateOnLowConfidence: true,
                escalateOnReview: true,
                escalateOnJudgeFailure: true,
                autoMinLevel: 4
            };
        case RULES.ALWAYS:
            return {
                escalateOnHighLevel: true,
                escalateOnLowConfidence: true,
                escalateOnReview: true,
                escalateOnJudgeFailure: true,
                autoMinLevel: 1
            };
        default:
            return null;
    }
}

function expandRule(rule, hostDefaultsOverride) {
    const flags = applyRuleFlags(rule);
    if (!flags) return disabledConfig(rule);

    const hostDefaults = hostDefaultsOverride || readHostDefaults();
    const judges = judgesFromHostDefaults(hostDefaults);

    if (judges.length < 2) {
        return disabledConfig(rule);
    }

    return withFamilyValidation({
        enabled: true,
        rule,
        judges,
        tiebreaker: pickTiebreaker(judges),
        confidenceThreshold: 0.8,
        ...flags
    });
}

function sanitizeJudgeEntry(entry) {
    if (!entry || typeof entry !== 'object') return null;
    const model = String(entry.model || '').trim();
    const host = String(entry.host || '').trim();
    if (!model || !host) return null;
    return { model, host };
}

function fromCustomObject(input, hostDefaultsOverride) {
    if (input.enabled === false) return disabledConfig(RULES.CUSTOM);

    const judges = Array.isArray(input.judges)
        ? input.judges.map(sanitizeJudgeEntry).filter(Boolean)
        : [];

    if (judges.length < 2) {
        return disabledConfig(input.rule || RULES.CUSTOM);
    }

    const tiebreaker = sanitizeJudgeEntry(input.tiebreaker) || null;

    const autoMinLevel = Number.isFinite(Number(input.autoMinLevel))
        ? Math.max(1, Math.min(10, Number(input.autoMinLevel)))
        : 4;

    const confidenceThreshold = Number.isFinite(Number(input.confidenceThreshold))
        ? Math.max(0, Math.min(1, Number(input.confidenceThreshold)))
        : 0.8;
    const escalationBudgetPercent = Number.isFinite(Number(input.escalation_budget_percent))
        ? Math.max(0, Math.min(100, Number(input.escalation_budget_percent)))
        : undefined;

    // When the caller specifies a known rule, use the rule's flag preset as
    // the baseline. Explicit per-flag fields on the input still override.
    const ruleFlags = applyRuleFlags(String(input.rule || '').toLowerCase()) || {
        escalateOnHighLevel: true,
        escalateOnLowConfidence: false,
        escalateOnReview: false,
        escalateOnJudgeFailure: false
    };

    const pickFlag = (key, fallback) => (typeof input[key] === 'boolean' ? input[key] : fallback);

    return withFamilyValidation({
        enabled: true,
        rule: input.rule || RULES.CUSTOM,
        judges,
        tiebreaker,
        autoMinLevel,
        confidenceThreshold,
        ...(escalationBudgetPercent !== undefined ? { escalation_budget_percent: escalationBudgetPercent } : {}),
        escalateOnHighLevel: pickFlag('escalateOnHighLevel', !!ruleFlags.escalateOnHighLevel),
        escalateOnLowConfidence: pickFlag('escalateOnLowConfidence', !!ruleFlags.escalateOnLowConfidence),
        escalateOnReview: pickFlag('escalateOnReview', !!ruleFlags.escalateOnReview),
        escalateOnJudgeFailure: pickFlag('escalateOnJudgeFailure', !!ruleFlags.escalateOnJudgeFailure)
    });
}

/**
 * @param {null|string|object} input — the raw multi_judge value from the API or batch record
 * @param {object} [opts]
 * @param {object} [opts.hostDefaults] — override the host→judge map (for tests)
 * @returns {object} canonical multi-judge config
 */
function resolveMultiJudge(input, opts = {}) {
    if (input === null || input === undefined || input === false) {
        return disabledConfig(RULES.OFF);
    }

    if (typeof input === 'string') {
        const rule = input.trim().toLowerCase();
        if (!rule || rule === RULES.OFF) return disabledConfig(RULES.OFF);
        return expandRule(rule, opts.hostDefaults);
    }

    if (typeof input === 'object') {
        if (input.enabled === false) return disabledConfig(input.rule || RULES.OFF);
        if (Array.isArray(input.judges) && input.judges.length > 0) {
            return fromCustomObject(input, opts.hostDefaults);
        }
        if (input.rule) {
            return expandRule(String(input.rule).toLowerCase(), opts.hostDefaults);
        }
    }

    return disabledConfig(RULES.OFF);
}

module.exports = {
    resolveMultiJudge,
    RULES,
    _internal: {
        expandRule,
        fromCustomObject,
        pickTiebreaker,
        judgesFromHostDefaults,
        inferJudgeFamily,
        validateJudgeFamilies
    }
};
