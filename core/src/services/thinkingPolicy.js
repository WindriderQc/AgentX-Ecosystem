'use strict';

const { hasQualifiedThinkingCapability } = require('./inferenceContractService');

const AUTO_ON_TASKS = new Set([
    'deep_reasoning',
    'analysis'
]);

// These lanes have benchmark-qualified thinking modes, but auto-enabling them
// would collapse separately measured contracts. Callers can still explicitly
// request thinking, subject to the deployed artifact capability contract.
const EXPLICIT_ONLY_TASKS = new Set([
    'master_brain'
]);

const AUTO_OFF_TASKS = new Set([
    'quick_chat',
    'buddy_reaction',
    'buddy_chat',
    'voice_persona_chat',
    'voice_persona_reader',
    'rag_query_expansion',
    'rag_reranking',
    'rag_compression',
    'summarization',
    'translation',
    'embeddings',
    'code_generation',
    'code_review'
]);

function envSet(name) {
    return new Set(String(process.env[name] || '')
        .split(',')
        .map((value) => value.trim())
        .filter(Boolean));
}

function normalizeRequestedThink(value) {
    if (value === true || value === false) return value;
    if (value == null || value === '') return undefined;
    const raw = String(value).trim().toLowerCase();
    if (['true', 'on', 'enabled', 'force', 'forced'].includes(raw)) return true;
    if (['false', 'off', 'disabled', 'never'].includes(raw)) return false;
    return undefined;
}

function normalizeThinkingMode({ requestedThink, thinkingMode } = {}) {
    const normalizedRequestedThink = normalizeRequestedThink(requestedThink);
    if (normalizedRequestedThink === true) return 'on';
    if (normalizedRequestedThink === false) return 'off';

    const raw = thinkingMode == null || thinkingMode === ''
        ? 'auto'
        : String(thinkingMode).trim().toLowerCase();

    if (['true', 'on', 'enabled', 'force', 'forced'].includes(raw)) return 'on';
    if (['false', 'off', 'disabled', 'never'].includes(raw)) return 'off';
    return 'auto';
}

function taskSetHas(baseSet, envName, taskType) {
    if (!taskType) return false;
    if (baseSet.has(taskType)) return true;
    return envSet(envName).has(taskType);
}

function resolveThinkingPolicy({
    requestedThink,
    thinkingMode,
    capabilityContract,
    taskType,
    rawResponseRequested = false
} = {}) {
    const mode = normalizeThinkingMode({ requestedThink, thinkingMode });
    const thinkingCapability = capabilityContract?.capabilities?.thinking
        || capabilityContract?.thinking
        || null;
    const qualified = hasQualifiedThinkingCapability(capabilityContract);
    const capable = qualified;

    if (mode === 'on') {
        return {
            mode,
            think: true,
            capable,
            qualified,
            source: 'explicit',
            reason: 'caller explicitly requested thinking'
        };
    }

    if (mode === 'off') {
        return {
            mode,
            think: false,
            capable,
            qualified,
            source: 'explicit',
            reason: 'caller explicitly disabled thinking'
        };
    }

    if (rawResponseRequested) {
        return {
            mode,
            think: undefined,
            capable,
            qualified,
            source: 'raw',
            reason: 'raw response requested; leaving Ollama default unchanged'
        };
    }

    if (taskSetHas(AUTO_OFF_TASKS, 'AGENTX_THINKING_AUTO_OFF_TASKS', taskType)) {
        return {
            mode,
            think: false,
            capable,
            qualified,
            source: 'task_policy',
            reason: `task ${taskType} is a latency/utility lane`
        };
    }

    if (!capable) {
        return {
            mode,
            think: undefined,
            capable,
            qualified,
            source: 'model_capability',
            reason: 'deployed host/model artifact is not qualified as thinking-capable'
        };
    }

    if (thinkingCapability?.recommendedPolicy === 'disallowed') {
        return {
            mode,
            think: false,
            capable,
            qualified,
            source: 'capability_policy',
            reason: 'qualified profile disallows thinking for the deployed host/model artifact'
        };
    }

    if (taskSetHas(EXPLICIT_ONLY_TASKS, 'AGENTX_THINKING_EXPLICIT_ONLY_TASKS', taskType)) {
        return {
            mode,
            think: false,
            capable,
            qualified,
            source: 'task_policy',
            reason: `task ${taskType} requires an explicit thinking request`
        };
    }

    if (taskSetHas(AUTO_ON_TASKS, 'AGENTX_THINKING_AUTO_ON_TASKS', taskType)) {
        return {
            mode,
            think: true,
            capable,
            qualified,
            source: 'task_policy',
            reason: `task ${taskType} is a reasoning lane`
        };
    }

    return {
        mode,
        think: false,
        capable,
        qualified,
        source: 'default_off',
        reason: 'auto mode has no matching task policy; disabling thinking by default'
    };
}

module.exports = {
    AUTO_OFF_TASKS,
    AUTO_ON_TASKS,
    EXPLICIT_ONLY_TASKS,
    normalizeRequestedThink,
    normalizeThinkingMode,
    resolveThinkingPolicy
};
