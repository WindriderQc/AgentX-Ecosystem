/**
 * Result persistence helpers for batch orchestration.
 */

const logger = require('../../../config/logger');
const BenchmarkResult = require('../../../models/BenchmarkResult');
const { JUDGE_CONFIG } = require('../qualityScorer');
const { SCORER_VERSION } = require('../scoring/scorerVersion');
const { getModelDigest } = require('./modelDigestService');
const { classifyBenchmarkError } = require('./errorClassifier');
const { normalizeScoringCategory, DEFAULT_SCORING_CATEGORY } = require('../scoring/scoringConfigs');

async function persistSuccessfulResult({
    batchId,
    judgeConfig,
    queueBatchProgress,
    flushBatchProgress,
    model,
    hostUrl,
    judgeHostUrl,
    prompt,
    promptText,
    latency,
    tokens,
    tokensPerSec,
    timeToFirstTokenMs,
    cleanedResponse,
    extractedThinking,
    hasEmptyResponse,
    responseTruncated,
    doneReason,
    numPredict,
    hintApplied,
    hintText,
    answerContract = null,
    lengthHintApplied = false,
    hardwareSnapshot,
    modelWarmupData,
    performanceBaseline,
    currentBatch,
    pendingModelTimeline,
    inputTruncated = false,
    promptEvalCount = null,
    inputBudget = null,
    executionSettings = null,
    repeatIndex = 0,
    repeatTotal = 1,
    repeatGroupId = null
}) {
    const scoringType = normalizeScoringCategory(prompt.scoring_type || prompt.category, DEFAULT_SCORING_CATEGORY);
    const visibleResponseBudget = !!(lengthHintApplied || answerContract?.applied);
    const visibleResponse = typeof cleanedResponse === 'string' ? cleanedResponse : '';
    const hiddenThinking = typeof extractedThinking === 'string' ? extractedThinking : '';
    const visibleResponseChars = visibleResponse.trim().length;
    const thinkingChars = hiddenThinking.trim().length;
    const thinkingPresent = thinkingChars > 0;
    const thinkEnabled = executionSettings?.think === true;
    const thinkingFinalAnswerPolicy = thinkEnabled
        ? (executionSettings?.thinking_final_answer_policy || null)
        : null;
    const thinkingOnlyResponse = !!(thinkingPresent && visibleResponseChars === 0);
    const thinkingRunaway = !!(thinkingPresent && responseTruncated);
    const hasEmptyVisibleResponse = !!(hasEmptyResponse || visibleResponseChars === 0);
    const hiddenRuntimeCap = !!(responseTruncated && !visibleResponseBudget);
    const responseContractFailure = thinkingOnlyResponse;
    const nonRankableMode = executionSettings?.rankable_mode === false;
    const truncationInvalidatesScore = hiddenRuntimeCap || !!inputTruncated || thinkingRunaway;
    const excludedFromLeaderboard = truncationInvalidatesScore || responseContractFailure || nonRankableMode;
    const reviewReasons = [];
    if (hiddenRuntimeCap) {
        reviewReasons.push('Response hit a hidden runtime token cap; the prompt did not expose a response budget, so the row is invalid for automatic quality ranking');
    }
    if (thinkingOnlyResponse) {
        reviewReasons.push('Thinking mode produced hidden reasoning but no visible final answer; hidden thinking is preserved for audit but not scored');
    }
    if (thinkingRunaway) {
        reviewReasons.push('Thinking mode hit the generation token limit while hidden reasoning was present; the visible final answer may be incomplete or starved');
    }
    if (inputTruncated) {
        reviewReasons.push('Prompt likely hit the input context budget before generation; judge cannot know whether the model saw the full task');
    }
    if (nonRankableMode) {
        reviewReasons.push('Campaign mode is diagnostic/profile-only under the frozen artifact contract and is not rankable');
    }
    const emptyResponseExplanation = thinkingOnlyResponse
        ? 'Model produced hidden thinking but no visible final answer'
        : 'Model produced empty response';
    const modelDigest = await getModelDigest(hostUrl, model);
    const result = new BenchmarkResult({
        model,
        model_digest: modelDigest,
        host: hostUrl,
        judge_host: judgeHostUrl,
        prompt: promptText,
        prompt_level: prompt.level,
        prompt_category: prompt.category,
        prompt_name: prompt.name,
        expected_answer: prompt.expected_answer,
        scoring_type: scoringType,
        scoring_plan: prompt.scoring_plan || null,
        deterministic_scoring: prompt.deterministic_scoring || undefined,
        scoring_dimensions: prompt.scoring_dimensions || undefined,
        reference_answer: prompt.reference_answer || null,
        output_contract: prompt.output_contract || undefined,
        judge_criteria: prompt.judge_criteria,
        prompt_snapshot_embedded: true,
        latency,
        tokens,
        tokens_per_sec: tokensPerSec,
        time_to_first_token_ms: timeToFirstTokenMs,
        response: visibleResponse,
        thinking: hiddenThinking || null,
        success: true,
        batch_id: batchId,
        timestamp: new Date(),
        scorer_version: (hasEmptyVisibleResponse && !responseContractFailure) ? SCORER_VERSION : null,
        quality_score: (hasEmptyVisibleResponse && !responseContractFailure) ? 0 : null,
        quality_explanation: hasEmptyVisibleResponse ? emptyResponseExplanation : null,
        scoring_method: responseContractFailure
            ? 'response_contract_failed'
            : (hasEmptyVisibleResponse ? 'empty_response' : 'pending'),
        needs_review: reviewReasons.length > 0,
        review_reason: reviewReasons.length > 0 ? reviewReasons.join('; ') : null,
        excluded_from_leaderboard: excludedFromLeaderboard,
        judge_model: judgeConfig.model || JUDGE_CONFIG.model,
        hardware_snapshot: hardwareSnapshot,
        truncation: {
            response_truncated: responseTruncated,
            response_tokens: tokens,
            response_limit: numPredict,
            done_reason: doneReason || null,
            hidden_response_cap: hiddenRuntimeCap,
            visible_response_budget: visibleResponseBudget,
            truncation_invalidates_score: truncationInvalidatesScore,
            input_truncated: !!inputTruncated,
            prompt_eval_count: promptEvalCount,
            input_budget: inputBudget,
            thinking_present: thinkingPresent,
            thinking_chars: thinkingChars,
            visible_response_chars: visibleResponseChars,
            thinking_only_response: thinkingOnlyResponse,
            thinking_runaway: thinkingRunaway,
            thinking_final_answer_policy: thinkingFinalAnswerPolicy
        },
        execution_settings: {
            sampling_profile: executionSettings?.sampling_profile || 'controlled',
            sampling_source: executionSettings?.sampling_source || 'controlled_override',
            num_predict: numPredict,
            think: thinkEnabled,
            think_mode: executionSettings?.think_mode || null,
            think_resolved_by: executionSettings?.think_resolved_by || null,
            thinking_profile_policy: executionSettings?.thinking_profile_policy || null,
            thinking_profile_host_id: executionSettings?.thinking_profile_host_id || null,
            thinking_profile_model_name: executionSettings?.thinking_profile_model_name || null,
            thinking_policy_reason: executionSettings?.thinking_policy_reason || null,
            thinking_final_answer_policy: thinkingFinalAnswerPolicy,
            thinking_final_answer_text: executionSettings?.thinking_final_answer_text || null,
            hint_applied: hintApplied,
            hint_text: hintText,
            num_ctx: executionSettings?.num_ctx ?? null,
            num_ctx_source: executionSettings?.num_ctx_source ?? null,
            answer_contract_applied: !!answerContract?.applied,
            answer_contract_mode: answerContract?.mode || null,
            answer_contract_target_tokens: answerContract?.target_tokens ?? null,
            answer_contract_max_tokens: answerContract?.max_tokens ?? null,
            answer_contract_text: answerContract?.text || null,
            temperature: executionSettings?.temperature ?? null,
            top_p: executionSettings?.top_p ?? null,
            top_k: executionSettings?.top_k ?? null,
            repeat_penalty: executionSettings?.repeat_penalty ?? null,
            seed: executionSettings?.seed ?? null,
            rankable_mode: executionSettings?.rankable_mode === true,
            inference_contract_fingerprint: executionSettings?.inference_contract_fingerprint || null,
            inference_contract_request_fingerprint: executionSettings?.inference_contract_request_fingerprint || null,
            artifact_digest: executionSettings?.artifact_digest || null
        },
        performance_baseline: performanceBaseline ? {
            status: performanceBaseline.status || null,
            source: performanceBaseline.source || 'benchmark_host_test',
            tokensPerSec: performanceBaseline.tokensPerSec ?? null,
            promptEvalTokensPerSec: performanceBaseline.promptEvalTokensPerSec ?? null,
            latencyMs: performanceBaseline.latencyMs ?? null,
            timeToFirstTokenMs: performanceBaseline.timeToFirstTokenMs ?? null,
            vramUsedMiB: performanceBaseline.vramUsedMiB ?? null,
            vramTotalMiB: performanceBaseline.vramTotalMiB ?? null,
            numCtx: performanceBaseline.numCtx ?? null,
            numCtxSource: performanceBaseline.numCtxSource ?? null,
            testedAt: performanceBaseline.testedAt || null,
            error: performanceBaseline.error || null
        } : null,
        warmup: modelWarmupData ? {
            prompt: modelWarmupData.prompt,
            response: modelWarmupData.response,
            latency_ms: modelWarmupData.latency_ms,
            already_loaded: modelWarmupData.already_loaded
        } : null,
        repeat_index: repeatIndex,
        repeat_total: repeatTotal,
        repeat_group_id: repeatGroupId
    });

    await result.save();
    pendingModelTimeline.push({
        timestamp: new Date(),
        event: 'test_complete',
        model,
        host: hostUrl,
        prompt_id: prompt._id ? prompt._id.toString() : null,
        prompt_level: prompt.level,
        duration_ms: latency,
        tokens_per_sec: tokensPerSec,
        time_to_first_token_ms: timeToFirstTokenMs,
        success: true,
        error: null
    });

    currentBatch.completed = (currentBatch.completed || 0) + 1;
    queueBatchProgress({
        model,
        host: hostUrl,
        judge_host: judgeHostUrl,
        prompt_name: prompt.name,
        success: true,
        latency,
        response_preview: visibleResponse.substring(0, 100) + '...'
    });
    await flushBatchProgress();

    logger.info('Batch test completed', { batchId, model, prompt: prompt.name, latency });
    return result._id;
}

async function persistFailedResult({ batchId, judgeConfig, queueBatchProgress, flushBatchProgress, model, hostUrl, judgeHostUrl, prompt, err, errorDuration, currentBatch, pendingModelTimeline, repeatIndex = 0, repeatTotal = 1, repeatGroupId = null, executionSettings = null }) {
    const classified = classifyBenchmarkError(err);
    const scoringType = normalizeScoringCategory(prompt.scoring_type || prompt.category, DEFAULT_SCORING_CATEGORY);
    const reviewReason = classified.infra
        ? `Infrastructure failure during execution (${classified.type || 'infra'}); row is invalid for model quality ranking and should be rerun`
        : null;

    try {
        const modelDigest = await getModelDigest(hostUrl, model);
        const result = new BenchmarkResult({
            model,
            model_digest: modelDigest,
            host: hostUrl,
            prompt: prompt.prompt,
            prompt_level: prompt.level,
            prompt_category: prompt.category,
            prompt_name: prompt.name,
            error: err.message,
            infra_error: classified.infra,
            error_type: classified.type || 'unknown',
            error_http_status: classified.httpStatus,
            success: false,
            batch_id: batchId,
            timestamp: new Date(),
            quality_score: null,
            scoring_method: 'exec_failed',
            scoring_type: scoringType,
            needs_review: classified.infra,
            review_reason: reviewReason,
            excluded_from_leaderboard: classified.infra,
            judge_model: judgeConfig.model || JUDGE_CONFIG.model,
            judge_host: judgeHostUrl,
            execution_settings: {
                sampling_profile: executionSettings?.sampling_profile || 'controlled',
                sampling_source: executionSettings?.sampling_source || 'controlled_override',
                think: executionSettings?.think === true,
                think_mode: executionSettings?.think_mode || null,
                rankable_mode: executionSettings?.rankable_mode === true,
                inference_contract_fingerprint: executionSettings?.inference_contract_fingerprint || null,
                inference_contract_request_fingerprint: executionSettings?.inference_contract_request_fingerprint || null,
                artifact_digest: executionSettings?.artifact_digest || null
            },
            repeat_index: repeatIndex,
            repeat_total: repeatTotal,
            repeat_group_id: repeatGroupId
        });

        await result.save();
        pendingModelTimeline.push({
            timestamp: new Date(),
            event: 'error',
            model,
            host: hostUrl,
            prompt_id: prompt._id ? prompt._id.toString() : null,
            prompt_level: prompt.level,
            duration_ms: errorDuration,
            tokens_per_sec: null,
            success: false,
            error: err.message || err.toString()
        });

        currentBatch.completed = (currentBatch.completed || 0) + 1;
        queueBatchProgress(
            { model, prompt_name: prompt.name, success: false, error: err.message },
            { failed: true }
        );
        await flushBatchProgress();

        logger.error('Batch test failed', { batchId, model, prompt: prompt.name, error: err.message });
    } catch (saveErr) {
        logger.error('Failed to save error result', {
            batchId,
            model,
            prompt: prompt.name,
            originalError: err.message,
            saveError: saveErr.message
        });
    }
}

module.exports = { persistSuccessfulResult, persistFailedResult };
