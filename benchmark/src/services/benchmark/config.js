/**
 * Benchmark Configuration
 * Default settings and normalization functions for benchmark execution
 */

const DEFAULT_EXECUTION_CONFIG = {
    // Simple config: just set a high limit and let models finish naturally
    response_max_tokens: 32000,  // High enough for any response including <think> reasoning
    response_min_tokens: 100,
    response_tokens_multiplier: 1,  // No multiplier games - just use the max
    // Fallback context window for Ollama when no benchmark-local model hint exists.
    // Per-model values are auto-detected by modelSync/parameterDetection.js based on
    // model size and host VRAM when no host-specific benchmark evidence exists.
    num_ctx: 8192,
    // Fairness override: when set, every host runs at this num_ctx regardless of
    // the per-host model adaptation. Null = honor per-host profile (legacy).
    // Set this to make host-vs-host comparisons apples-to-apples.
    force_num_ctx: null,
    // Controlled benchmarks pin sampling for repeatability. Production-lane
    // qualification uses `production`, omitting overrides so the deployed
    // Modelfile/Ollama sampling distribution is actually exercised.
    sampling_profile: 'controlled', // 'controlled' | 'production'
    sampling_source: 'controlled_override',
    // Sampling params pinned per batch for fairness across models/hosts. Without
    // these, each Modelfile/Ollama version supplies its own defaults — variance
    // in scores partly reflects RNG drift, not model quality. seed=42 makes runs
    // reproducible (when the model honors it; some quants ignore seed).
    temperature: 0.2,
    top_p: 0.9,
    top_k: 40,
    repeat_penalty: 1.1,
    seed: 42,
    // Repeat each (model, host, prompt) N times. With seed pinned, low variance
    // = stable model+host pair; high variance with seed pinned = model ignores
    // seed (some quants do). Without repeats, single-sample noise is mistaken
    // for hardware/model signal. Default 1 = legacy single-shot.
    repeats: 1,
    // Per-test abort timeout in ms. 180s was too short for large models (27B+).
    per_test_timeout_ms: 600000,
    // Ollama API mode: 'chat' (default) uses /api/chat with structured messages,
    // 'generate' uses /api/generate with raw prompt text.
    // Chat mode applies the model's chat template automatically — required for
    // instruction-tuned models to avoid empty responses.
    api_mode: 'chat',
    // Thinking policy for execution models:
    //   auto  = enable only when the model+host profiler says it is safe
    //   true  = force think:true for explicit A/B runs
    //   false = force think:false for controls
    // Judges stay controlled by judge_config.think, which defaults false.
    think: 'auto',
    // When thinking is enabled, the benchmark still scores only visible content.
    // This contract makes that explicit to the model instead of disabling thinking.
    thinking_final_answer_policy: 'visible_required', // 'visible_required' | 'off'
    thinking_final_answer_template: 'Thinking may be used internally, but the final answer must appear in the visible response. Hidden thinking is preserved for audit but is not scored.',
    // Length hints can constrain models - disabled by default
    include_length_hint: false,
    length_hint_template: 'Keep your response under {max} tokens.',
    // Answer contracts make the benchmark contract visible to the model when
    // prompt metadata includes expected_tokens. This keeps "what was asked",
    // "what was expected", and "what will be judged" in the same prompt.
    answer_contract_mode: 'auto', // 'auto' | 'off'
    answer_contract_template: 'Answer contract: Target about {target} tokens. Stay under {max} tokens unless the prompt explicitly requires more. Prioritize complete, directly relevant coverage over verbosity.',
    answer_contract_slack_multiplier: 2,
    answer_contract_min_tokens: 256,
    // Custom hint - free-form text appended to every prompt
    custom_hint: '',
    // Warmup timeouts in ms — how long to wait for a model to load (cold) or respond (already loaded).
    warmup_timeout_cold: 180000,
    warmup_timeout_loaded: 90000,
    // Judge queue drain timeouts. drain = max total wait; stall = max idle gap.
    judge_drain_timeout_ms: 1800000,
    judge_stall_timeout_ms: 120000
};

/**
 * Normalize and validate execution configuration
 * @param {Object} config - User-provided config
 * @returns {Object} - Normalized config with defaults applied
 */
function normalizeExecutionConfig(config = {}) {
    const responseMaxTokensExplicit = config?.response_max_tokens_source
        ? config.response_max_tokens_source === 'caller'
        : Object.prototype.hasOwnProperty.call(config || {}, 'response_max_tokens');
    const merged = { ...DEFAULT_EXECUTION_CONFIG, ...(config || {}) };
    const toNumber = (value, fallback, min, max) => {
        const n = Number(value);
        if (!Number.isFinite(n)) return fallback;
        let v = n;
        if (min !== undefined) v = Math.max(min, v);
        if (max !== undefined) v = Math.min(max, v);
        return v;
    };

    merged.response_tokens_multiplier = toNumber(
        merged.response_tokens_multiplier,
        DEFAULT_EXECUTION_CONFIG.response_tokens_multiplier,
        0.25,
        10
    );
    merged.response_min_tokens = Math.round(toNumber(
        merged.response_min_tokens,
        DEFAULT_EXECUTION_CONFIG.response_min_tokens,
        1,
        50000
    ));
    merged.response_max_tokens = Math.round(toNumber(
        merged.response_max_tokens,
        DEFAULT_EXECUTION_CONFIG.response_max_tokens,
        merged.response_min_tokens,
        50000
    ));
    if (merged.response_max_tokens < merged.response_min_tokens) {
        merged.response_max_tokens = merged.response_min_tokens;
    }
    merged.response_max_tokens_source = responseMaxTokensExplicit ? 'caller' : 'default';
    merged.num_ctx = Math.round(toNumber(
        merged.num_ctx,
        DEFAULT_EXECUTION_CONFIG.num_ctx,
        512,
        131072
    ));
    // force_num_ctx: null = unset (honor profile); number = override
    if (merged.force_num_ctx === null || merged.force_num_ctx === undefined || merged.force_num_ctx === '') {
        merged.force_num_ctx = null;
    } else {
        merged.force_num_ctx = Math.round(toNumber(merged.force_num_ctx, null, 512, 131072));
        if (!Number.isFinite(merged.force_num_ctx)) merged.force_num_ctx = null;
    }
    const requestedSamplingProfile = String(
        merged.sampling_profile || DEFAULT_EXECUTION_CONFIG.sampling_profile
    ).trim().toLowerCase();
    merged.sampling_profile = requestedSamplingProfile === 'production' ? 'production' : 'controlled';
    merged.sampling_source = merged.sampling_profile === 'production'
        ? 'modelfile_default'
        : 'controlled_override';
    if (merged.sampling_profile === 'production') {
        merged.temperature = null;
        merged.top_p = null;
        merged.top_k = null;
        merged.repeat_penalty = null;
        merged.seed = null;
    } else {
        merged.temperature = toNumber(merged.temperature, DEFAULT_EXECUTION_CONFIG.temperature, 0, 2);
        merged.top_p = toNumber(merged.top_p, DEFAULT_EXECUTION_CONFIG.top_p, 0, 1);
        merged.top_k = Math.round(toNumber(merged.top_k, DEFAULT_EXECUTION_CONFIG.top_k, 1, 1000));
        merged.repeat_penalty = toNumber(merged.repeat_penalty, DEFAULT_EXECUTION_CONFIG.repeat_penalty, 0.5, 2);
        if (merged.seed === null || merged.seed === undefined || merged.seed === '') {
            merged.seed = null;
        } else {
            const seedN = Number(merged.seed);
            merged.seed = Number.isFinite(seedN) ? Math.round(seedN) : DEFAULT_EXECUTION_CONFIG.seed;
        }
    }
    merged.repeats = Math.round(toNumber(
        merged.repeats,
        DEFAULT_EXECUTION_CONFIG.repeats,
        1,
        5
    ));
    merged.per_test_timeout_ms = Math.round(toNumber(
        merged.per_test_timeout_ms,
        DEFAULT_EXECUTION_CONFIG.per_test_timeout_ms,
        30000,
        3600000
    ));
    if (merged.think === true || merged.think === false) {
        // keep explicit boolean
    } else {
        const rawThink = String(merged.think ?? DEFAULT_EXECUTION_CONFIG.think).trim().toLowerCase();
        if (['true', 'on', 'enabled', 'force', 'forced'].includes(rawThink)) {
            merged.think = true;
        } else if (['false', 'off', 'disabled', 'never'].includes(rawThink)) {
            merged.think = false;
        } else {
            merged.think = 'auto';
        }
    }
    const requestedResponseMode = String(merged.response_mode || '').trim().toLowerCase();
    if (['final_only', 'final-only', 'off'].includes(requestedResponseMode)) {
        merged.response_mode = 'final_only';
        merged.think = false;
    } else if (['native', 'default', 'native_default'].includes(requestedResponseMode)) {
        merged.response_mode = 'native';
    } else if (['explicit_thinking', 'explicit-thinking', 'thinking', 'on'].includes(requestedResponseMode)) {
        merged.response_mode = 'explicit_thinking';
        merged.think = true;
    } else if (['profile_auto', 'profile-auto', 'auto'].includes(requestedResponseMode)) {
        merged.response_mode = 'profile_auto';
        merged.think = 'auto';
    } else {
        merged.response_mode = merged.think === true
            ? 'explicit_thinking'
            : (merged.think === false ? 'final_only' : 'profile_auto');
    }
    merged.thinking_final_answer_policy = String(
        merged.thinking_final_answer_policy || DEFAULT_EXECUTION_CONFIG.thinking_final_answer_policy
    ).toLowerCase();
    if (!['visible_required', 'off'].includes(merged.thinking_final_answer_policy)) {
        merged.thinking_final_answer_policy = DEFAULT_EXECUTION_CONFIG.thinking_final_answer_policy;
    }
    if (
        typeof merged.thinking_final_answer_template !== 'string'
        || !merged.thinking_final_answer_template.trim()
    ) {
        merged.thinking_final_answer_template = DEFAULT_EXECUTION_CONFIG.thinking_final_answer_template;
    }
    merged.include_length_hint = !!merged.include_length_hint;
    merged.answer_contract_mode = String(merged.answer_contract_mode || DEFAULT_EXECUTION_CONFIG.answer_contract_mode).toLowerCase();
    if (!['auto', 'off'].includes(merged.answer_contract_mode)) {
        merged.answer_contract_mode = DEFAULT_EXECUTION_CONFIG.answer_contract_mode;
    }
    if (typeof merged.answer_contract_template !== 'string' || !merged.answer_contract_template.trim()) {
        merged.answer_contract_template = DEFAULT_EXECUTION_CONFIG.answer_contract_template;
    }
    merged.answer_contract_slack_multiplier = toNumber(
        merged.answer_contract_slack_multiplier,
        DEFAULT_EXECUTION_CONFIG.answer_contract_slack_multiplier,
        1,
        10
    );
    merged.answer_contract_min_tokens = Math.round(toNumber(
        merged.answer_contract_min_tokens,
        DEFAULT_EXECUTION_CONFIG.answer_contract_min_tokens,
        1,
        50000
    ));
    merged.warmup_timeout_cold = Math.round(toNumber(
        merged.warmup_timeout_cold,
        DEFAULT_EXECUTION_CONFIG.warmup_timeout_cold,
        30000,
        600000
    ));
    merged.warmup_timeout_loaded = Math.round(toNumber(
        merged.warmup_timeout_loaded,
        DEFAULT_EXECUTION_CONFIG.warmup_timeout_loaded,
        10000,
        180000
    ));
    merged.judge_drain_timeout_ms = Math.round(toNumber(
        merged.judge_drain_timeout_ms,
        DEFAULT_EXECUTION_CONFIG.judge_drain_timeout_ms,
        300000,
        3600000
    ));
    merged.judge_stall_timeout_ms = Math.round(toNumber(
        merged.judge_stall_timeout_ms,
        DEFAULT_EXECUTION_CONFIG.judge_stall_timeout_ms,
        30000,
        600000
    ));
    if (typeof merged.length_hint_template !== 'string' || !merged.length_hint_template.trim()) {
        merged.length_hint_template = DEFAULT_EXECUTION_CONFIG.length_hint_template;
    }
    // Custom hint is optional free-form text
    if (typeof merged.custom_hint !== 'string') {
        merged.custom_hint = '';
    }
    merged.custom_hint = merged.custom_hint.trim();
    return merged;
}

function renderTokenTemplate(template, values) {
    return template
        .replace(/\{target\}/g, String(values.target))
        .replace(/\{max\}/g, String(values.max))
        .replace(/\{min\}/g, String(values.min))
        .replace(/\{multiplier\}/g, String(values.multiplier))
        .replace(/\{runtime_max\}/g, String(values.runtimeMax));
}

function buildAnswerContract(expectedTokens, numPredict, config) {
    if (!config || config.answer_contract_mode === 'off' || config.include_length_hint) {
        return { applied: false, text: null, target_tokens: null, max_tokens: null, mode: config?.answer_contract_mode || 'off' };
    }

    const targetTokens = Math.round(Number(expectedTokens) || 0);
    if (!Number.isFinite(targetTokens) || targetTokens <= 0) {
        return { applied: false, text: null, target_tokens: null, max_tokens: null, mode: config.answer_contract_mode || 'auto' };
    }

    const runtimeMax = Math.round(Number(numPredict) || Number(config.response_max_tokens) || DEFAULT_EXECUTION_CONFIG.response_max_tokens);
    const slackMax = Math.max(
        targetTokens,
        Math.round(targetTokens * (Number(config.answer_contract_slack_multiplier) || DEFAULT_EXECUTION_CONFIG.answer_contract_slack_multiplier)),
        Math.round(Number(config.answer_contract_min_tokens) || DEFAULT_EXECUTION_CONFIG.answer_contract_min_tokens)
    );
    const visibleMax = Math.max(1, Math.min(runtimeMax, slackMax));
    const template = (config.answer_contract_template || DEFAULT_EXECUTION_CONFIG.answer_contract_template).trim();

    return {
        applied: true,
        text: renderTokenTemplate(template, {
            target: targetTokens,
            max: visibleMax,
            min: config.response_min_tokens,
            multiplier: config.response_tokens_multiplier,
            runtimeMax
        }),
        target_tokens: targetTokens,
        max_tokens: visibleMax,
        mode: config.answer_contract_mode || 'auto'
    };
}

/**
 * Apply hints to prompt text based on execution config
 * Supports both length hints (with template variables) and custom hints
 * @param {string} promptText - Original prompt
 * @param {number} expectedTokens - Expected response tokens
 * @param {number} numPredict - Max tokens to predict
 * @param {Object} config - Execution config
 * @returns {string} - Prompt with hints appended
 */
function buildPromptHints(promptText, expectedTokens, numPredict, config) {
    if (!config) {
        return {
            promptText,
            applied: false,
            hintText: null,
            lengthHintApplied: false,
            answerContract: { applied: false, text: null, target_tokens: null, max_tokens: null, mode: 'off' },
            thinkingFinalAnswerContract: { applied: false, text: null, mode: 'off' }
        };
    }

    const hints = [];
    let lengthHintApplied = false;
    const thinkingFinalAnswerContract = {
        applied: false,
        text: null,
        mode: config.thinking_final_answer_policy || 'off'
    };

    // Apply length hint if enabled
    if (config.include_length_hint) {
        const template = (config.length_hint_template || DEFAULT_EXECUTION_CONFIG.length_hint_template).trim();
        if (template) {
            const tokensTarget = Math.round(Number(expectedTokens) || 0);
            const maxTokens = Math.round(Number(numPredict) || 0);
            const lengthHint = renderTokenTemplate(template, {
                target: tokensTarget,
                max: maxTokens,
                min: config.response_min_tokens,
                multiplier: config.response_tokens_multiplier,
                runtimeMax: maxTokens
            });
            hints.push(lengthHint);
            lengthHintApplied = true;
        }
    }

    const answerContract = buildAnswerContract(expectedTokens, numPredict, config);
    if (answerContract.applied && answerContract.text) {
        hints.push(answerContract.text);
    }

    if (config.think === true && config.thinking_final_answer_policy !== 'off') {
        const template = (
            config.thinking_final_answer_template
            || DEFAULT_EXECUTION_CONFIG.thinking_final_answer_template
        ).trim();
        if (template) {
            thinkingFinalAnswerContract.applied = true;
            thinkingFinalAnswerContract.text = template;
            hints.push(template);
        }
    }

    // Apply custom hint if provided
    if (config.custom_hint && config.custom_hint.trim()) {
        hints.push(config.custom_hint.trim());
    }

    if (hints.length === 0) {
        return {
            promptText,
            applied: false,
            hintText: null,
            lengthHintApplied,
            answerContract,
            thinkingFinalAnswerContract
        };
    }

    const hintText = hints.join('\n');
    return {
        promptText: `${promptText}\n\n${hintText}`,
        applied: true,
        hintText,
        lengthHintApplied,
        answerContract,
        thinkingFinalAnswerContract
    };
}

function applyLengthHint(promptText, expectedTokens, numPredict, config) {
    return buildPromptHints(promptText, expectedTokens, numPredict, config).promptText;
}


module.exports = {
    DEFAULT_EXECUTION_CONFIG,
    normalizeExecutionConfig,
    applyLengthHint,
    buildPromptHints,
    buildAnswerContract
};
