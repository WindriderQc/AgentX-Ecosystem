/**
 * Quality Scorer Service
 * Uses LLM-as-judge pattern to evaluate response quality
 * Enables comparing models on quality, not just speed
 */

const logger = require('../../config/logger');
const deterministicScorer = require('./deterministicScorer');
const decomposedJudge = require('./decomposedJudge');
const referenceScorer = require('./referenceScorer');
const judgeConfidence = require('./judgeConfidence');

// Import from extracted modules
const {
    DEFAULT_SCORING_CATEGORY,
    ENHANCED_SCORING_CONFIGS,
    CATEGORY_COMPOSITE_PROFILES,
    CATEGORY_STRATEGIES,
    getScoringDimensions,
    normalizeScoringCategory
} = require('./scoring/scoringConfigs');
const { calculateCompositeScore } = require('./scoring/compositeScorer');
const { stripMarkdownCodeFences, jsonDeepEqual, tryParseJson } = require('./scoring/jsonUtils');
const { quickScore } = require('./scoring/quickScorer');
const { JUDGE_CONFIG, callJudge, buildDynamicJudgePrompt, incrementJudgeFailureCount } = require('./scoring/judgeCall');
const { scoreFormatCompliance } = require('./scoring/formatComplianceScorer');
const { resolveJudgeConfig } = require('./scoring/resolveJudgeConfig');
const { resolvePlan, PLANS } = require('./scoring/scoringPlan');
const { SCORER_VERSION } = require('./scoring/scorerVersion');

/**
 * Contract §2.3 (delta 0115 row 19): every decomposed dispatch path must carry
 * the category's dimension-weight table into `decomposedJudge.score()` so the
 * downstream weighted-average aggregation is category-aware regardless of
 * caller.
 *
 * This helper is the single source of truth for deriving `_dimensionWeights`
 * from a prompt. `routeScoring()`, judgeValidation, retroCalibration, and any
 * future direct caller must go through this helper rather than building the
 * weight map ad hoc. If a category has no ENHANCED_SCORING_CONFIGS entry the
 * helper returns null and `decomposedJudge.score()` derives an explicit
 * equal-distribution fallback (never an implicit unweighted mean).
 *
 * @param {Object} prompt - Prompt object (may have `scoring_type` or `category`)
 * @returns {Object|null} `{ [dimensionName]: weight }` or null if category unknown
 */
function getCategoryDimensionWeights(prompt) {
    const requestedCategory = (prompt && (prompt.scoring_type || prompt.category)) || null;
    const normalizedCategory = normalizeScoringCategory(requestedCategory, DEFAULT_SCORING_CATEGORY);
    const category = ENHANCED_SCORING_CONFIGS[normalizedCategory]
        ? normalizedCategory
        : DEFAULT_SCORING_CATEGORY;
    const config = ENHANCED_SCORING_CONFIGS[category];
    if (!config || !Array.isArray(config.core_dimensions) || config.core_dimensions.length === 0) {
        return null;
    }
    const weights = {};
    for (const dim of config.core_dimensions) {
        weights[dim.name] = dim.weight;
    }
    return weights;
}

/**
 * Score a model response for quality
 */
async function scoreResponse({ response, prompt, skipLLM = false, judgeConfig = {}, _batchHardwareSnapshot = null }) {
    const startTime = Date.now();
    let mergedJudgeConfig = resolveJudgeConfig(judgeConfig);

    // Helper: compute format compliance and semantic score, then merge into result.
    //
    // Contract §2.5 + §2.4 (0112 branch audit): enrichWithDualScores MUST wrap
    // every return path that produces a scored result when the prompt has an
    // output_contract. Exceptions (format is moot):
    //   - empty_response: quality_score=0 with explicit nulls (no judge ran)
    //   - skipped:        quality_score=null, LLM scoring disabled
    //   - llm_failed:     explicit nulls (judge errored)
    //
    // Branches that DO call enrichWithDualScores:
    //   1. Deterministic match (Phase 1 in scoreResponse)
    //   2. Quick scoring (Phase 2 in scoreResponse)
    //   3. routeScoring → deterministic/numeric (non-LLM, via scoreResponse)
    //   4. routeScoring → reference (LLM path, via scoreResponse)
    //   5. routeScoring → decomposed (LLM path, via scoreResponse)
    //   6. Phase 4 monolithic LLM-as-judge (scoreResponse fallback)
    const enrichWithDualScores = (result, opts = {}) => {
        const contract = prompt.output_contract;
        const formatResult = scoreFormatCompliance(response, contract);
        result.format_score = formatResult.format_score;
        result.format_compliant = formatResult.format_compliant;

        // Deterministic-first scoring (task 0198). Tag each result with
        // independent deterministic_score / subjective_score / composite_formula
        // so operators can see which signal drove quality_score. Non-invasive:
        // doesn't change quality_score, just decomposes its provenance.
        if (opts.deterministicMatch !== undefined) {
            // Phase 1 (deterministic) or Phase 2 (quick) — deterministic path
            result.deterministic_score = result.quality_score;
            result.deterministic_pass = !!opts.deterministicMatch;
            result.subjective_score = null;
            result.composite_formula = 'deterministic_only';
        } else {
            // LLM judge path (decomposed or fallback judge)
            result.deterministic_score = null;
            result.deterministic_pass = null;
            result.subjective_score = result.quality_score;
            result.composite_formula = 'judge_only';
        }

        // Contract §2.4 (0112 Row 6): semantic_score is meaningful only when
        // format_score is non-null (i.e. an output_contract exists and was
        // evaluated). When format_score is null, semantic_score carries no
        // independent signal beyond quality_score and must be null.
        if (result.format_score !== null) {
            if (opts.deterministicMatch !== undefined) {
                // Deterministic/quick: matched = high semantic, regardless of format
                result.semantic_score = opts.deterministicMatch ? Math.max(result.quality_score, 8) : result.quality_score;
            } else {
                // LLM judge: semantic_score equals quality_score (judge evaluates content)
                result.semantic_score = result.quality_score;
            }
        } else {
            result.semantic_score = null;
        }

        // Contract §2.4 / §2.5 / §2.7 (0138 — reasoning format-gate, 0144 —
        // extended to instruction):
        // The decomposed reasoning judge evaluates computational correctness
        // but has no awareness of output-format constraints. 0128 round 2
        // surfaced R034: judge=7, conf=1.00, human=3 — the response was
        // computationally correct but violated "output only the fields joined
        // by commas". 0128 round 3 surfaced R036 (instruction, qwen2.5-coder,
        // conf=0.65, human=0, judge=9.3) — response violated the 18-22 word
        // constraint but the decomposed instruction judge missed it. Same
        // pattern: judge has no independent signal on deterministic format
        // compliance. When a reasoning OR instruction prompt declares a
        // non-null output_contract AND format compliance is weak
        // (format_score < 5.0 on the 0..10 scale, equivalent to < 0.5
        // normalized), gate the final score to prevent confident-wrong
        // leaderboard entries:
        //   1. Cap quality_score at max(3, quality_score × 0.5) — fast-garbage
        //      spirit aligned with §2.7 composite floor.
        //   2. Force judge_confidence ≤ 0.5 — judge had no signal on format.
        //   3. Force needs_review = true so humans catch it.
        //
        // Gate is scoped to reasoning + instruction by design: coding/math/
        // creative/knowledge/translation handle their own format via 0135
        // dimension weights. Only LLM paths are gated; deterministic/quick
        // paths short-circuited earlier with a guaranteed match and do not
        // reach a format violation here.
        const category = prompt.scoring_type || prompt.category;
        const isLlmPath = opts.deterministicMatch === undefined;
        const formatScoreNorm = result.format_score !== null ? result.format_score / 10 : null;
        if (
            isLlmPath
            && ['reasoning', 'instruction'].includes(category)
            && contract
            && formatScoreNorm !== null
            && formatScoreNorm < 0.5
            && typeof result.quality_score === 'number'
        ) {
            const originalQuality = result.quality_score;
            const cappedQuality = Math.max(3, Math.min(originalQuality, originalQuality * 0.5));
            result.quality_score = Math.round(cappedQuality * 10) / 10;
            if (typeof result.judge_confidence === 'number') {
                result.judge_confidence = Math.min(result.judge_confidence, 0.5);
            } else {
                result.judge_confidence = 0.5;
            }
            result.needs_review = true;
            result.review_reason = result.review_reason
                ? `${result.review_reason}; ${category} format-gate: format_score=${result.format_score} (<5) with output_contract`
                : `${category} format-gate: format_score=${result.format_score} (<5) with output_contract — quality capped from ${originalQuality} to ${result.quality_score}`;
            result.format_gated = true;
            // Recompute semantic_score from the capped quality so downstream
            // consumers stay consistent with §2.4.
            if (result.semantic_score !== null && typeof result.semantic_score === 'number') {
                result.semantic_score = result.quality_score;
            }
        }

        return result;
    };

    // Phase 1: deterministic scoring. Matches, forbidden-content failures,
    // and explicit strict checks are terminal. Ordinary mismatches fall through
    // to the judge with an audit flag because extractors can miss correct
    // answers embedded in prose.
    let deterministicMismatch = null;
    let deterministicDetResult = null;
    if (prompt.deterministic_scoring) {
        const detResult = deterministicScorer.score(response, prompt);
        if (detResult) {
            const forbiddenViolation = Array.isArray(detResult.results)
                && detResult.results.some((r) => r.forbidden && r.found);
            const strictMode = prompt.deterministic_scoring.strict === true;

            if (detResult.matched || forbiddenViolation || strictMode) {
                logger.info('Deterministic scoring used', {
                    prompt: prompt.name || prompt.prompt_name || 'unknown',
                    type: detResult.deterministic_type || detResult.method,
                    score: detResult.score,
                    matched: detResult.matched,
                    terminal_reason: detResult.matched ? 'matched' : (forbiddenViolation ? 'forbidden_content' : 'strict')
                });
                return enrichWithDualScores({
                    quality_score: detResult.score,
                    scoring_method: 'deterministic',
                    deterministic_type: detResult.deterministic_type || detResult.method,
                    matched_expected: detResult.matched,
                    explanation: detResult.details,
                    breakdown: { overall: detResult.score },
                    scoring_time_ms: Date.now() - startTime,
                    judge_confidence: 1.0,
                    needs_review: false
                }, { deterministicMatch: detResult.matched });
            }

            deterministicDetResult = detResult;
            deterministicMismatch = {
                deterministic_mismatch: true,
                deterministic_type: detResult.deterministic_type || detResult.method || null,
                deterministic_score: detResult.score,
                deterministic_details: detResult.details
            };
            logger.info('Deterministic mismatch; falling through to judge', {
                prompt: prompt.name || prompt.prompt_name || 'unknown',
                type: deterministicMismatch.deterministic_type,
                deterministic_score: detResult.score
            });
        }
    }

    const withMismatchAudit = (result) => {
        if (!deterministicMismatch || !result) return result;
        const audited = { ...result, ...deterministicMismatch };
        if (typeof audited.quality_score === 'number' && audited.quality_score >= 6) {
            audited.needs_review = true;
            audited.review_reason = [
                audited.review_reason,
                `Judge score ${audited.quality_score} disagrees with deterministic mismatch (${deterministicMismatch.deterministic_details})`
            ].filter(Boolean).join('; ');
            audited.judge_confidence = Math.min(audited.judge_confidence ?? 1.0, 0.6);
        }
        return audited;
    };

    // Phase 2: Try quick scoring (legacy pattern matching)
    const quickResult = quickScore(response, prompt);
    if (quickResult && quickResult.quick) {
        const explanation = quickResult.matched
            ? `Quick scoring matched expected answer "${quickResult.expected}" (pattern: ${quickResult.pattern}).`
            : `Quick scoring did not match expected answer "${quickResult.expected}" (pattern: ${quickResult.pattern}).`;

        logger.info('Quick scoring used', {
            pattern: quickResult.pattern,
            matched: quickResult.matched,
            score: quickResult.score,
            prompt: prompt.name || prompt.prompt_name || 'unknown'
        });

        return enrichWithDualScores({
            quality_score: quickResult.score,
            scoring_method: 'quick',
            matched_expected: quickResult.matched,
            expected_answer: quickResult.expected,
            quick_pattern: quickResult.pattern,
            explanation,
            judge_prompt: 'Quick scoring used (no judge model invoked).',
            scoring_time_ms: Date.now() - startTime,
            breakdown: {
                accuracy: quickResult.score,
                overall: quickResult.score
            },
            judge_confidence: 1.0,
            needs_review: false
        }, { deterministicMatch: quickResult.matched });
    }

    if (skipLLM) {
        if (deterministicDetResult) {
            return enrichWithDualScores({
                quality_score: deterministicDetResult.score,
                scoring_method: 'deterministic',
                deterministic_type: deterministicDetResult.deterministic_type || deterministicDetResult.method,
                matched_expected: false,
                explanation: deterministicDetResult.details,
                breakdown: { overall: deterministicDetResult.score },
                scoring_time_ms: Date.now() - startTime,
                judge_confidence: 1.0,
                needs_review: false
            }, { deterministicMatch: false });
        }
        // 0112 branch: skipped — LLM scoring disabled; format is moot.
        return {
            quality_score: null,
            scoring_method: 'skipped',
            reason: 'LLM scoring disabled',
            scoring_time_ms: Date.now() - startTime,
            format_score: null,
            format_compliant: null,
            semantic_score: null,
            // Task 0198
            deterministic_score: null,
            deterministic_pass: null,
            subjective_score: null,
            composite_formula: 'skipped'
        };
    }

    // Validate that response is not empty before scoring
    if (!response || response.trim().length === 0) {
        logger.warn('Attempting to score empty response', {
            prompt: prompt.name || prompt.prompt_name || 'unknown',
            response_length: response ? response.length : 0,
            task: prompt.prompt ? prompt.prompt.substring(0, 100) : 'unknown'
        });
        // 0112 branch: empty_response — format is moot (no content to evaluate).
        // Explicit nulls instead of enrichWithDualScores.
        return {
            quality_score: 0,
            scoring_method: 'empty_response',
            scoring_type: normalizeScoringCategory(
                prompt.scoring_type || prompt.category,
                DEFAULT_SCORING_CATEGORY
            ),
            explanation: 'CRITICAL: Model produced NO response. Unable to evaluate empty output. Automatic score: 0/10',
            // Contract §2.3: empty response yields quality_score=0 (intentional;
            // an empty response is observable content). But contract §2.6 says
            // confidence is undefined when no judge ran — not 1.0. Leave the
            // decomposed breakdown null because no dimensions were evaluated.
            breakdown: null,
            scoring_time_ms: Date.now() - startTime,
            judge_prompt: null,
            judge_model: null,
            judge_raw_response: 'Model failed to generate any response text',
            judge_confidence: null,
            needs_review: false,
            format_score: null,
            format_compliant: null,
            semantic_score: null,
            // Task 0198: empty response — explicit zero on all axes
            deterministic_score: 0,
            deterministic_pass: false,
            subjective_score: null,
            composite_formula: 'empty_response'
        };
    }

    // Phase 3: Try routed scoring (reference, decomposed, etc.)
    const routedResult = await routeScoring(response, prompt, mergedJudgeConfig);
    if (routedResult) {
        const isDeterministicMatch = routedResult.matched_expected !== undefined ? routedResult.matched_expected : undefined;
        // Deterministic paths (including numeric match) set judge_confidence = 1.0
        // inside routeScoring. Per contract §2.6, deterministic/quick paths may
        // keep 1.0. For every LLM scoring path (llm_judge, decomposed, reference),
        // unconditionally overwrite with judgeConfidence.assess(), regardless of
        // whatever value the routed scorer provided (decomposed now returns null
        // explicitly to force this).
        const LLM_SCORING_METHODS = new Set(['llm_judge', 'decomposed', 'reference', 'reference_quick']);
        const isLlmPath = LLM_SCORING_METHODS.has(routedResult.scoring_method);

        if (!isLlmPath && routedResult.judge_confidence !== undefined && routedResult.needs_review !== undefined) {
            return withMismatchAudit(enrichWithDualScores({
                ...routedResult,
                scoring_time_ms: Date.now() - startTime
            }, { deterministicMatch: isDeterministicMatch }));
        }

        const confidence = judgeConfidence.assess(routedResult, prompt);

        return withMismatchAudit(enrichWithDualScores({
            ...routedResult,
            scoring_time_ms: Date.now() - startTime,
            judge_confidence: confidence.judge_confidence,
            prompt_complexity: confidence.prompt_complexity,
            needs_review: confidence.needs_review,
            review_reason: confidence.review_reason
        }, { deterministicMatch: isDeterministicMatch }));
    }

    // Phase 4: Fall back to standard LLM-as-judge for complex evaluation
    const scoringType = normalizeScoringCategory(
        prompt.scoring_type || prompt.category,
        DEFAULT_SCORING_CATEGORY
    );
    const dimensionsInfo = getScoringDimensions(prompt);

    const cleanedResponse = stripMarkdownCodeFences(response);
    if (cleanedResponse !== response) {
        logger.debug('Stripped markdown code fences from response', {
            prompt: prompt.name || prompt.prompt_name || 'unknown',
            originalLength: response.length,
            cleanedLength: cleanedResponse.length
        });
    }

    const evalPrompt = buildDynamicJudgePrompt(
        dimensionsInfo.dimensions,
        prompt.prompt || prompt,
        prompt.expected_answer || 'See criteria',
        cleanedResponse,
        { judgeHints: dimensionsInfo.judgeHints }
    );
    const config = { weight: dimensionsInfo.weights };

    const judgeResult = await callJudge(evalPrompt, mergedJudgeConfig);

    if (!judgeResult.success) {
        incrementJudgeFailureCount();
        logger.warn('LLM judge failed', {
            error: judgeResult.error,
            prompt: prompt.name || prompt.prompt_name || 'unknown',
            judge_model: mergedJudgeConfig.model || JUDGE_CONFIG.model,
            scoring_type: scoringType
        });
        if (deterministicDetResult) {
            return enrichWithDualScores({
                quality_score: deterministicDetResult.score,
                scoring_method: 'deterministic_fallback',
                deterministic_type: deterministicDetResult.deterministic_type || deterministicDetResult.method,
                matched_expected: false,
                explanation: `Judge failed (${judgeResult.error}); deterministic verdict used: ${deterministicDetResult.details}`,
                breakdown: { overall: deterministicDetResult.score },
                judge_prompt: evalPrompt,
                judge_model: mergedJudgeConfig.model || JUDGE_CONFIG.model,
                judge_host: mergedJudgeConfig.host || JUDGE_CONFIG.host,
                scoring_time_ms: Date.now() - startTime,
                judge_confidence: 0.5,
                needs_review: true,
                review_reason: 'Judge failed on deterministic-mismatch fallthrough; verify the deterministic verdict'
            }, { deterministicMatch: false });
        }
        // Contract §2.6/§2.7: when the judge itself fails, quality is unknown
        // and confidence is undefined (not 1.0 and not low-but-populated).
        // Explicit null on every score axis prevents stale values from a prior
        // code path leaking through via object spread downstream (delta row 15).
        return {
            quality_score: null,
            semantic_score: null,
            format_score: null,
            format_compliant: null,
            judge_confidence: null,
            needs_review: false,
            scoring_method: 'llm_failed',
            scoring_type: scoringType,
            error: judgeResult.error,
            explanation: `Judge model failed: ${judgeResult.error}`,
            judge_prompt: evalPrompt,
            judge_model: mergedJudgeConfig.model || JUDGE_CONFIG.model,
            judge_host: mergedJudgeConfig.host || JUDGE_CONFIG.host,
            scoring_time_ms: Date.now() - startTime,
            breakdown: null,
            // Task 0198: judge failure means no signal on either axis
            deterministic_score: null,
            deterministic_pass: null,
            subjective_score: null,
            composite_formula: 'judge_failed'
        };
    }

    const scores = judgeResult.scores;

    // Validate and normalize judge scores to 0-10 range
    const normalizedScores = {};
    for (const [key, value] of Object.entries(scores)) {
        if (typeof value === 'number' && key !== 'overall') {
            normalizedScores[key] = Math.max(0, Math.min(10, value));
            if (value < 0 || value > 10) {
                logger.warn('Judge returned out-of-range score', {
                    dimension: key,
                    value,
                    clamped_to: normalizedScores[key],
                    prompt: prompt.name || prompt.prompt_name || 'unknown'
                });
            }
        } else {
            normalizedScores[key] = value;
        }
    }

    // Always recompute overall from dimension scores and declared weights.
    // The judge-reported overall is retained as a diagnostic only.
    const judgeReportedOverall = normalizedScores.overall;
    let overallScore;
    let partialDimensionsFlag = false;
    {
        overallScore = 0;
        let totalWeight = 0;
        const missingDimensions = [];
        for (const [key, weight] of Object.entries(config.weight)) {
            if (normalizedScores[key] !== undefined) {
                overallScore += normalizedScores[key] * weight;
                totalWeight += weight;
            } else {
                missingDimensions.push(key);
            }
        }

        if (missingDimensions.length > 0) {
            logger.warn('Judge response missing dimensions, score may be inflated', {
                missing: missingDimensions,
                scoring_type: scoringType,
                prompt: prompt.name || prompt.prompt_name || 'unknown'
            });
            partialDimensionsFlag = true;
        }

        if (totalWeight > 0 && totalWeight !== 1.0) {
            logger.warn('Weights do not sum to 1.0, normalizing', {
                total_weight: totalWeight,
                scoring_type: scoringType,
                prompt: prompt.name || prompt.prompt_name || 'unknown'
            });
            overallScore = overallScore / totalWeight;
        }

        if (totalWeight === 0) {
            overallScore = Number.isFinite(judgeReportedOverall) ? judgeReportedOverall : 0;
        }

        overallScore = Math.max(0, Math.min(10, overallScore));
        overallScore = Math.round(overallScore * 10) / 10;

        if (Number.isFinite(judgeReportedOverall) && Math.abs(judgeReportedOverall - overallScore) > 1.5) {
            logger.debug('Judge self-reported overall diverges from weighted recompute', {
                prompt: prompt.name || prompt.prompt_name || 'unknown',
                judge_reported: judgeReportedOverall,
                recomputed: overallScore
            });
        }
    }

    logger.info('LLM judge scoring completed', {
        prompt: prompt.name || prompt.prompt_name || 'unknown',
        score: overallScore,
        judge_model: mergedJudgeConfig.model || JUDGE_CONFIG.model,
        scoring_type: scoringType,
        time_ms: Date.now() - startTime
    });

    const truncation = {
        judge_truncated: judgeResult.judge_truncated || false,
        judge_tokens: judgeResult.judge_tokens || 0
    };

    if (judgeResult.judge_truncated) {
        logger.warn('Judge output truncated', {
            prompt: prompt.name || prompt.prompt_name || 'unknown',
            judge_tokens: judgeResult.judge_tokens
        });
    }

    // Detect judge hardware
    let judgeHardwareSnapshot = null;
    if (_batchHardwareSnapshot) {
        judgeHardwareSnapshot = _batchHardwareSnapshot;
    }

    const baseResult = {
        quality_score: overallScore,
        judge_reported_overall: Number.isFinite(judgeReportedOverall) ? judgeReportedOverall : null,
        scoring_method: 'llm_judge',
        scoring_type: scoringType,
        breakdown: normalizedScores,
        explanation: normalizedScores.explanation || scores.explanation || 'No explanation provided',
        judge_model: mergedJudgeConfig.model || JUDGE_CONFIG.model,
        judge_host: mergedJudgeConfig.host || JUDGE_CONFIG.host,
        judge_hardware_snapshot: judgeHardwareSnapshot,
        scoring_time_ms: Date.now() - startTime,
        judge_prompt: evalPrompt,
        judge_raw_response: judgeResult.raw || null,
        truncation
    };

    const confidence = judgeConfidence.assess(baseResult, prompt);

    return withMismatchAudit(enrichWithDualScores({
        ...baseResult,
        judge_confidence: confidence.judge_confidence,
        prompt_complexity: confidence.prompt_complexity,
        needs_review: confidence.needs_review || partialDimensionsFlag,
        review_reason: confidence.review_reason
    }));
}

/**
 * Route scoring to the appropriate strategy based on category and prompt
 */
async function routeScoring(response, prompt, judgeConfig) {
    const requestedCategory = prompt.scoring_type || prompt.category;
    const normalizedCategory = normalizeScoringCategory(requestedCategory, DEFAULT_SCORING_CATEGORY);
    const category = CATEGORY_STRATEGIES[normalizedCategory]
        ? normalizedCategory
        : DEFAULT_SCORING_CATEGORY;
    const strategy = CATEGORY_STRATEGIES[category] || CATEGORY_STRATEGIES[DEFAULT_SCORING_CATEGORY];
    const level = prompt.level || 5;

    logger.debug('Routing scoring', {
        prompt: prompt.name || 'unknown',
        requestedCategory,
        category,
        strategy: strategy.primary,
        level
    });

    // Contract §2.1/§2.2 (delta 0116 rows 21, 22): prompt-level signal
    // overrides category default strategy. The category default is 'decomposed'
    // for both instruction and translation, but specific prompt attributes
    // trigger a more targeted scorer first:
    //   - instruction + output_contract.type==='json_schema' → deterministic first
    //   - translation + reference_answer → reference first (via reference_fallback)
    let effectivePrimary = strategy.primary;
    const resolvedPlan = resolvePlan(prompt, CATEGORY_STRATEGIES);
    if (resolvedPlan.error) {
        logger.warn('Invalid scoring_plan, falling back to llm_judge', {
            prompt: prompt.name || prompt.prompt_name || 'unknown',
            declared: prompt.scoring_plan,
            error: resolvedPlan.error
        });
    }
    if (resolvedPlan.source === 'explicit') {
        if (resolvedPlan.plan === PLANS.LLM_JUDGE) return null;
        if (resolvedPlan.plan === PLANS.DECOMPOSED) effectivePrimary = 'decomposed';
        if (resolvedPlan.plan === PLANS.REFERENCE) effectivePrimary = 'reference';
        if (resolvedPlan.plan === PLANS.DETERMINISTIC) effectivePrimary = 'deterministic';
        if (resolvedPlan.plan === PLANS.HYBRID) effectivePrimary = 'hybrid';
        if (resolvedPlan.plan === PLANS.CRITERIA) {
            logger.warn('criteria scoring_plan is no longer executable; routing to LLM judge', {
                prompt: prompt.name || 'unknown'
            });
            return null;
        }
    }
    if (category === 'instruction' && prompt.output_contract && prompt.output_contract.type === 'json_schema') {
        effectivePrimary = 'deterministic';
        logger.debug('Prompt-level override: instruction with json_schema → deterministic first', {
            prompt: prompt.name || 'unknown'
        });
    }

    let result = null;
    const normalizeDeterministic = (detResult, methodLabel = 'deterministic') => {
        if (!detResult) return null;
        const score = Number(detResult.score);
        const quality = Number.isFinite(score) ? Math.max(0, Math.min(10, score)) : 0;
        return {
            quality_score: quality,
            scoring_method: methodLabel,
            scoring_type: category,
            deterministic_type: detResult.deterministic_type || detResult.method || null,
            matched_expected: !!detResult.matched,
            explanation: detResult.details || 'Deterministic scoring',
            breakdown: { overall: quality },
            judge_confidence: 1.0,
            needs_review: false
        };
    };

    // Phase 1: Try deterministic scoring if configured (or prompt-level override)
    if (effectivePrimary === 'deterministic' || effectivePrimary === 'hybrid' || effectivePrimary === 'auto') {
        if (prompt.deterministic_scoring) {
            result = deterministicScorer.score(response, prompt);
            if (result) {
                logger.info('Deterministic scoring completed', {
                    prompt: prompt.name || 'unknown',
                    type: result.deterministic_type,
                    score: result.score,
                    matched: result.matched
                });
                return normalizeDeterministic(result);
            }
        }

        if (category === 'math' && prompt.expected_answer) {
            const numResult = deterministicScorer.numericEval(response, prompt.expected_answer);
            if (numResult.score > 0) {
                logger.info('Math deterministic scoring', {
                    prompt: prompt.name || 'unknown',
                    score: numResult.score,
                    matched: numResult.matched
                });
                return normalizeDeterministic({
                    ...numResult,
                    deterministic_type: 'numeric'
                }, 'deterministic');
            }
        }

        // Contract §2.1 (delta 0116 row 21): instruction prompts with
        // json_schema output_contract get deterministic JSON comparison even
        // without explicit deterministic_scoring config, when expected_answer
        // is available.
        if (category === 'instruction' && prompt.output_contract
            && prompt.output_contract.type === 'json_schema' && prompt.expected_answer) {
            const jsonResult = deterministicScorer.jsonCompare(response, prompt.expected_answer);
            if (jsonResult && jsonResult.score > 0) {
                logger.info('Instruction JSON-schema deterministic scoring', {
                    prompt: prompt.name || 'unknown',
                    score: jsonResult.score,
                    matched: jsonResult.matched
                });
                return normalizeDeterministic({
                    ...jsonResult,
                    deterministic_type: 'json'
                }, 'deterministic');
            }
        }
    }

    // Phase 1.5: Criteria-based hybrid scoring (disabled)
    // Regex matching on judge_criteria is unreliable for both code and format
    // verification. Prompts with deterministic_scoring are caught in Phase 1;
    // everything else goes to decomposed LLM judge (Phase 3) which evaluates
    // category-specific dimensions (correctness, instruction_adherence, etc.).

    // Phase 2: Try reference-based scoring for prompts with reference answers
    if ((effectivePrimary === 'reference' || strategy.reference_fallback) && prompt.reference_answer) {
        result = await referenceScorer.score(response, prompt, judgeConfig);
        if (result) {
            logger.info('Reference scoring used', {
                prompt: prompt.name || 'unknown',
                score: result.quality_score
            });
            return result;
        }
    }

    // Phase 3: Use decomposed judging for complex evaluations
    if (strategy.primary === 'decomposed' || strategy.llm_strategy === 'decomposed') {
        // Contract §2.3 (delta 0115 row 19): derive `_dimensionWeights` via
        // the single shared helper so every decomposed dispatch path — routed,
        // direct, validation, calibration — uses the same weight table. The
        // helper returns null when the category has no ENHANCED_SCORING_CONFIGS
        // entry, in which case `decomposedJudge.score()` builds an explicit
        // equal-distribution fallback. Either way, the unweighted mean is
        // never possible.
        const dimensionWeights = getCategoryDimensionWeights({ ...prompt, scoring_type: category });
        result = await decomposedJudge.score(response, { ...prompt, _dimensionWeights: dimensionWeights }, judgeConfig);
        if (result) {
            logger.info('Decomposed judging used', {
                prompt: prompt.name || 'unknown',
                score: result.quality_score
            });
            return result;
        }
    }

    // Phase 4: Fall back to standard LLM judge
    return null;
}

/**
 * Batch score multiple responses
 */
async function batchScore(results, options = {}) {
    // Contract §2.9 (delta 0113 row 14): composite is per-category, not
    // per-profile. `options.profile` is no longer honoured; each row's
    // prompt_category drives weight selection. Absent categories resolve to
    // DEFAULT_SCORING_CATEGORY inside calculateCompositeScore.
    const concurrency = options.concurrency || 5;

    // Detect judge hardware ONCE for entire batch
    let judgeHardwareSnapshot = null;

    const processResult = async (result) => {
        if (!result.response || !result.success) {
            return {
                ...result,
                quality_score: null,
                scoring_method: 'skipped',
                reason: result.success ? 'no_response' : 'test_failed'
            };
        }

        const promptInfo = {
            prompt: result.prompt,
            expected_answer: result.expected_answer || '',
            scoring_type: normalizeScoringCategory(result.prompt_category, DEFAULT_SCORING_CATEGORY),
            judge_criteria: result.judge_criteria || []
        };

        const scores = await scoreResponse({
            response: result.response,
            prompt: promptInfo,
            _batchHardwareSnapshot: judgeHardwareSnapshot
        });

        const composite = calculateCompositeScore({
            latency: result.latency,
            tokens_per_sec: result.tokens_per_sec,
            time_to_first_token_ms: result.time_to_first_token_ms,
            quality_score: scores.quality_score,
            performance_baseline: result.performance_baseline || null
        }, normalizeScoringCategory(result.prompt_category, DEFAULT_SCORING_CATEGORY));

        return {
            ...result,
            ...scores,
            judge_confidence: scores.judge_confidence,
            prompt_complexity: scores.prompt_complexity,
            needs_review: scores.needs_review,
            review_reason: scores.review_reason,
            ...composite
        };
    };

    const scoredResults = [];
    for (let i = 0; i < results.length; i += concurrency) {
        const batch = results.slice(i, i + concurrency);
        const batchResults = await Promise.all(batch.map(processResult));
        scoredResults.push(...batchResults);
    }

    return scoredResults;
}

module.exports = {
    SCORER_VERSION,
    scoreResponse,
    calculateCompositeScore,
    quickScore,
    buildDynamicJudgePrompt,
    getScoringDimensions,
    getCategoryDimensionWeights,
    stripMarkdownCodeFences,
    jsonDeepEqual,
    tryParseJson,
    routeScoring,
    ENHANCED_SCORING_CONFIGS,
    CATEGORY_COMPOSITE_PROFILES,
    CATEGORY_STRATEGIES,
    JUDGE_CONFIG,
    deterministicScorer,
    decomposedJudge,
    referenceScorer,
    judgeConfidence
};
