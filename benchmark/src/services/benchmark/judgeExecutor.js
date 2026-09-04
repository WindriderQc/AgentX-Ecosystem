const BenchmarkResult = require('../../../models/BenchmarkResult');
const BenchmarkPrompt = require('../../../models/BenchmarkPrompt');
const { scoreResponse, calculateCompositeScore } = require('../qualityScorer');
const { resolveJudgeConfig } = require('../scoring/resolveJudgeConfig');
const { SCORER_VERSION } = require('../scoring/scorerVersion');
const { classifyBenchmarkError } = require('./errorClassifier');
const { multiJudgeScore, shouldEscalateToMultiJudge, AGREEMENT_REVIEW_THRESHOLD } = require('./multiJudge');
const { normalizeScoringCategory, DEFAULT_SCORING_CATEGORY } = require('../scoring/scoringConfigs');
const { throwIfJudgeCancelled } = require('../scoring/judgeCall');
const { buildTrustJudgeCellId } = require('./harnessBrokerClient');

function cancellationSignal(config = {}) {
    return config.cancelSignal || config.signal || null;
}

async function invalidateAmbiguousJudgeWrite(resultId, phase) {
    await BenchmarkResult.updateOne(
        { _id: resultId },
        {
            $set: {
                excluded_from_leaderboard: true,
                needs_review: true,
                scoring_method: 'authority_invalidated',
                quality_score: null,
                composite_score: null,
                review_reason: `Judge authority was lost during ${phase}; result requires a fenced rejudge`
            }
        }
    ).catch(() => {});
}

async function persistJudgeUpdate(resultId, update, cancellationConfig, phase) {
    throwIfJudgeCancelled(cancellationConfig);
    const signal = cancellationSignal(cancellationConfig);
    try {
        await BenchmarkResult.updateOne(
            { _id: resultId },
            update,
            signal ? { signal } : undefined
        );
        throwIfJudgeCancelled(cancellationConfig);
    } catch (error) {
        if (signal?.aborted) await invalidateAmbiguousJudgeWrite(resultId, phase);
        throw error;
    }
}

function buildPromptData(result, originalPrompt) {
    return {
        prompt: result.prompt,
        name: result.prompt_name,
        level: result.prompt_level,
        category: result.prompt_category,
        expected_answer: result.expected_answer,
        scoring_type: result.scoring_type,
        scoring_plan: result.scoring_plan || originalPrompt?.scoring_plan || null,
        deterministic_scoring: result.deterministic_scoring,
        scoring_dimensions: result.scoring_dimensions || originalPrompt?.scoring_dimensions || undefined,
        reference_answer: result.reference_answer || originalPrompt?.reference_answer || undefined,
        output_contract: result.output_contract || originalPrompt?.output_contract || undefined,
        judge_criteria: result.judge_criteria || originalPrompt?.judge_criteria || undefined,
    };
}

function buildResultScoreContext(result) {
    return {
        latency: result.latency,
        tokens_per_sec: result.tokens_per_sec,
        time_to_first_token_ms: result.time_to_first_token_ms,
        performance_baseline: result.performance_baseline || null,
        prompt_category: result.prompt_category,
        scoring_type: result.scoring_type,
        judge_host: result.judge_host || null,
        needs_review: !!result.needs_review,
        review_reason: result.review_reason || null,
        excluded_from_leaderboard: !!result.excluded_from_leaderboard
    };
}

async function findOriginalPrompt(result) {
    if (!result.prompt_name || result.prompt_snapshot_embedded) {
        return null;
    }

    return BenchmarkPrompt.findOne({ name: result.prompt_name })
        .select('scoring_dimensions scoring_plan reference_answer output_contract judge_criteria')
        .lean();
}

async function persistMultiJudgeScores(resultId, multiJudgeResult, cancellationConfig = {}) {
    throwIfJudgeCancelled(cancellationConfig);
    const judgeScoreRecords = multiJudgeResult.scores
        .filter((score) => score.success)
        .map((score) => ({
            judge_model: score.judge_model,
            judge_host: score.judge_host,
            quality_score: score.quality_score,
            explanation: score.explanation,
            scoring_time_ms: score.scoring_time_ms
        }));

    await persistJudgeUpdate(
        resultId,
        { $set: { judge_scores: judgeScoreRecords } },
        cancellationConfig,
        'multi-judge score persistence'
    );
}

function buildConsensusReviewReason(baseScores, multiJudgeResult, agreementNeedsReview = false) {
    return [
        baseScores.review_reason || null,
        multiJudgeResult.divergent ? `Multi-judge divergence ${multiJudgeResult.divergence}` : null,
        multiJudgeResult.tiebreakerUsed ? 'Escalated to tiebreaker judge' : null,
        agreementNeedsReview ? `Low inter-judge agreement ${multiJudgeResult.agreement}` : null
    ].filter(Boolean).join('; ');
}

function buildConsensusConfidence(baseScores, multiJudgeResult) {
    const baseConf = baseScores.judge_confidence;
    const agreement = multiJudgeResult.agreement;

    // Single-judge (agreement null) — fall through unchanged
    if (agreement === null || agreement === undefined) {
        return baseConf;
    }

    // Multi-judge: min(single_judge_confidence, agreement) — can drag down, never lift up
    if (typeof baseConf === 'number') {
        return Math.round(Math.min(baseConf, agreement) * 100) / 100;
    }
    return Math.round(agreement * 100) / 100;
}

function mergeReviewReasons(...reasons) {
    const seen = new Set();
    return reasons
        .filter(Boolean)
        .flatMap((reason) => String(reason).split(';').map((part) => part.trim()).filter(Boolean))
        .filter((reason) => {
            const key = reason.toLowerCase();
            if (seen.has(key)) return false;
            seen.add(key);
            return true;
        })
        .join('; ') || null;
}

async function applyScoresToResult(resultId, scores, resultData, cancellationConfig = {}) {
    throwIfJudgeCancelled(cancellationConfig);
    // Contract §2.9 (delta 0113): composite is per-category only — no legacy
    // profile fallback (interactive/balanced/etc). Default missing
    // prompt_category to the contract default (knowledge).
    const categoryOrProfile = resultData.prompt_category || DEFAULT_SCORING_CATEGORY;
    const composite = calculateCompositeScore({
        latency: resultData.latency,
        tokens_per_sec: resultData.tokens_per_sec,
        time_to_first_token_ms: resultData.time_to_first_token_ms,
        // performance_baseline lets compositeScorer prefer calibrated host
        // metrics over raw single-run latency/tps. Without this, every result
        // re-judged after a host restart shows degraded composite scores
        // because the warm-up run hadn't happened yet.
        performance_baseline: resultData.performance_baseline,
        quality_score: scores.quality_score
    }, categoryOrProfile);

    const truncationUpdate = scores.truncation ? {
        'truncation.judge_truncated': scores.truncation.judge_truncated,
        'truncation.judge_tokens': scores.truncation.judge_tokens
    } : {};

    const isJudgeFailed = scores.scoring_method === 'llm_failed';
    let judgeFailureUpdate = {};
    if (isJudgeFailed) {
        const judgeErrorMessage = scores.error || scores.explanation || 'Judge failed';
        const classified = classifyBenchmarkError(judgeErrorMessage);
        judgeFailureUpdate = {
            error: judgeErrorMessage,
            infra_error: classified.infra,
            error_type: classified.type,
            error_http_status: classified.httpStatus
        };
    }

    const combinedNeedsReview = !!resultData.needs_review || !!scores.needs_review;
    const combinedReviewReason = mergeReviewReasons(resultData.review_reason, scores.review_reason);

    await persistJudgeUpdate(
        resultId,
        {
            $set: {
                scorer_version: SCORER_VERSION,
                quality_score: scores.quality_score,
                quality_breakdown: scores.breakdown,
                quality_explanation: scores.explanation,
                judge_prompt: scores.judge_prompt,
                judge_model: scores.judge_model,
                judge_host: scores.judge_host || resultData.judge_host || null,
                judge_raw_response: scores.judge_raw_response,
                judge_target: scores.judge_target || null,
                judge_receipt: scores.judge_receipt || null,
                ...(scores.trust_judge_receipt
                    ? { trust_judge_receipt: scores.trust_judge_receipt }
                    : {}),
                judge_provider_usage: scores.judge_provider_usage || null,
                judge_provider_cost: scores.judge_provider_cost || null,
                judge_hardware_snapshot: scores.judge_hardware_snapshot || null,
                judge_consensus: scores.judge_consensus || null,
                judge_divergence: scores.judge_divergence !== undefined ? scores.judge_divergence : null,
                judge_tiebreaker_used: !!scores.judge_tiebreaker_used,
                judge_escalated: !!scores.judge_escalated,
                scoring_method: scores.scoring_method,
                scoring_type: normalizeScoringCategory(scores.scoring_type || resultData.scoring_type || resultData.prompt_category, DEFAULT_SCORING_CATEGORY),
                scoring_time_ms: scores.scoring_time_ms,
                deterministic_type: scores.deterministic_type || null,
                matched_expected: scores.matched_expected !== undefined ? scores.matched_expected : null,
                deterministic_mismatch: scores.deterministic_mismatch !== undefined ? !!scores.deterministic_mismatch : null,
                deterministic_details: scores.deterministic_details || null,
                judge_reported_overall: scores.judge_reported_overall !== undefined ? scores.judge_reported_overall : null,
                quick_pattern: scores.quick_pattern,
                composite_score: composite.composite_score,
                composite_profile_used: composite.composite_profile_used,
                normalized_scores: composite.normalized,
                accuracy_score: scores.accuracy_score !== undefined ? scores.accuracy_score : null,
                compliance_score: scores.compliance_score !== undefined ? scores.compliance_score : null,
                semantic_score: scores.semantic_score !== undefined ? scores.semantic_score : null,
                format_score: scores.format_score !== undefined ? scores.format_score : null,
                format_compliant: scores.format_compliant !== undefined ? scores.format_compliant : null,
                judge_confidence: scores.judge_confidence,
                prompt_complexity: scores.prompt_complexity,
                needs_review: combinedNeedsReview,
                review_reason: combinedReviewReason,
                decomposed_breakdown: scores.decomposed_breakdown || null,
                ...truncationUpdate,
                ...judgeFailureUpdate
            }
        },
        cancellationConfig,
        'judge score persistence'
    );

    return {
        quality_score: scores.quality_score,
        scoring_method: scores.scoring_method,
        composite_score: composite.composite_score,
        judge_confidence: scores.judge_confidence,
        needs_review: combinedNeedsReview,
        review_reason: combinedReviewReason
    };
}

async function judgeResult(resultId, judgeConfig = {}, batchHardwareSnapshot = null, multiJudgeConfig = null) {
    throwIfJudgeCancelled(judgeConfig);
    const result = await BenchmarkResult.findById(resultId);
    throwIfJudgeCancelled(judgeConfig);
    if (!result) {
        throw new Error(`Result not found: ${resultId}`);
    }
    if (!result.success) {
        throw new Error('Cannot judge failed test executions');
    }
    if (!result.response) {
        throw new Error('No response to judge');
    }
    if ((result.trust_candidate_id || result.trust_prompt_id)
        && judgeConfig.require_trust_worker_receipt !== true) {
        const error = new Error('Strict Benchmark Trust evidence cannot be rejudged in place');
        error.code = 'BENCHMARK_TRUST_RESULT_MUTATION_FORBIDDEN';
        error.statusCode = 409;
        throw error;
    }

    const originalPrompt = await findOriginalPrompt(result);
    throwIfJudgeCancelled(judgeConfig);
    const promptData = buildPromptData(result, originalPrompt);
    const resultData = buildResultScoreContext(result);
    let mergedConfig = resolveJudgeConfig(judgeConfig, {
        resultDefaults: { judge_model: result.judge_model, judge_host: result.judge_host }
    });
    if (mergedConfig.require_trust_worker_receipt === true) {
        mergedConfig = {
            ...mergedConfig,
            cell_id: buildTrustJudgeCellId(result)
        };
    }

    const baseScores = await scoreResponse({
        response: result.response,
        prompt: promptData,
        judgeConfig: mergedConfig,
        _batchHardwareSnapshot: batchHardwareSnapshot
    });
    throwIfJudgeCancelled(mergedConfig);

    const useMultiJudge = shouldEscalateToMultiJudge({
        category: result.prompt_category,
        scoringMethod: baseScores.scoring_method,
        judgeConfidence: baseScores.judge_confidence,
        needsReview: baseScores.needs_review,
        promptLevel: result.prompt_level,
        judgeReliable: baseScores.judge_reliable,
        judgeErrors: baseScores.judge_errors,
        multiJudgeConfig
    });

    if (!useMultiJudge) {
        return applyScoresToResult(resultId, baseScores, resultData, mergedConfig);
    }

    if (multiJudgeConfig?._escalation) {
        multiJudgeConfig._escalation.used += 1;
    }

    const multiJudgeResult = await multiJudgeScore({
        response: result.response,
        prompt: promptData,
        judges: multiJudgeConfig.judges,
        tiebreakerJudge: multiJudgeConfig.tiebreaker || null,
        _batchHardwareSnapshot: batchHardwareSnapshot,
        cancelSignal: mergedConfig.cancelSignal || mergedConfig.signal || null,
        seedJudgeResult: {
            judge_model: baseScores.judge_model || mergedConfig.model,
            judge_host: baseScores.judge_host || mergedConfig.host,
            quality_score: baseScores.quality_score,
            explanation: baseScores.explanation,
            scoring_time_ms: baseScores.scoring_time_ms,
            scoring_method: baseScores.scoring_method,
            success: baseScores.quality_score !== null && baseScores.quality_score !== undefined
        }
    });
    throwIfJudgeCancelled(mergedConfig);

    await persistMultiJudgeScores(resultId, multiJudgeResult, mergedConfig);
    throwIfJudgeCancelled(mergedConfig);

    const consensusConfidence = buildConsensusConfidence(baseScores, multiJudgeResult);
    const agreementNeedsReview = multiJudgeResult.agreement !== null && multiJudgeResult.agreement < AGREEMENT_REVIEW_THRESHOLD;
    const consensusNeedsReview = multiJudgeResult.consensus === 'divergent_unresolved' || agreementNeedsReview;
    const consensusReviewReason = buildConsensusReviewReason(baseScores, multiJudgeResult, agreementNeedsReview);

    return applyScoresToResult(resultId, {
        ...baseScores,
        quality_score: multiJudgeResult.finalScore !== null
            ? multiJudgeResult.finalScore
            : baseScores.quality_score,
        explanation: `[Multi-judge consensus: ${multiJudgeResult.consensus}] ${baseScores.explanation || ''}`.trim(),
        judge_confidence: Math.round(consensusConfidence * 100) / 100,
        needs_review: consensusNeedsReview,
        review_reason: consensusNeedsReview
            ? (consensusReviewReason || 'Multi-judge disagreement requires review')
            : (consensusReviewReason || baseScores.review_reason || null),
        judge_consensus: multiJudgeResult.consensus,
        judge_divergence: multiJudgeResult.divergence ?? null,
        judge_tiebreaker_used: !!multiJudgeResult.tiebreakerUsed,
        judge_escalated: true
    }, resultData, mergedConfig);
}

module.exports = {
    applyScoresToResult,
    buildPromptData,
    judgeResult
};
