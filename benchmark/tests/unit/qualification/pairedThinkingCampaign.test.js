'use strict';

const {
  isReviewClean,
  unresolvedReason,
  summarizeMode,
  compareModeSummaries,
  buildBatchPayload
} = require('../../../src/services/qualification/pairedThinkingCampaign');
const { parseArgs, headersFor } = require('../../../scripts/paired-thinking-campaign');

function row(prompt, score, overrides = {}) {
  return {
    prompt_name: prompt,
    prompt_category: prompt === 'code' ? 'coding' : 'reasoning',
    model_digest: 'sha256:model',
    success: true,
    quality_score: score,
    composite_score: score * 10,
    latency: 1000,
    tokens_per_sec: 30,
    needs_review: false,
    excluded_from_leaderboard: false,
    truncation: {
      thinking_chars: 0,
      visible_response_chars: 100,
      response_truncated: false,
      thinking_only_response: false,
      thinking_runaway: false
    },
    execution_settings: { inference_contract_fingerprint: 'contract-a' },
    ...overrides
  };
}

describe('paired thinking campaign evidence summary', () => {
  test('separates raw scores from review-clean scores', () => {
    const rows = [
      row('logic', 8),
      row('logic', 9, { needs_review: true, review_reason: 'ambiguous' }),
      row('code', 10, {
        needs_review: true,
        excluded_from_leaderboard: true,
        evaluation_authority: 'executable'
      })
    ];

    const summary = summarizeMode(rows, { mode: 'final_only', expectedRepeats: 3 });

    expect(summary.raw.quality).toMatchObject({ n: 3, mean: 9 });
    expect(summary.review_clean.quality).toMatchObject({ n: 1, mean: 8 });
    expect(summary.evidence.unresolved).toEqual({
      pending_human_review: 1,
      executable_verification_required: 1
    });
    expect(summary.per_prompt.find((entry) => entry.prompt === 'code').clean_count).toBe(0);
  });

  test('keeps missing numeric evidence unknown instead of manufacturing zero', () => {
    const summary = summarizeMode([
      row('logic', null, { composite_score: null })
    ], { mode: 'final_only', expectedRepeats: 3 });

    expect(summary.raw.quality).toEqual({ n: 0, mean: null, min: null, max: null });
    expect(summary.review_clean.rows).toBe(0);
    expect(summary.evidence.unresolved).toEqual({ unscored: 1 });
  });

  test('pairs only prompts with the minimum clean repeats in both modes', () => {
    const finalRows = [
      row('logic', 8), row('logic', 8), row('logic', 8),
      row('translation', 6, { needs_review: true })
    ];
    const thinkingRows = [
      row('logic', 9, { truncation: { thinking_chars: 500, visible_response_chars: 100 } }),
      row('logic', 9), row('logic', 9),
      row('translation', 8)
    ];
    const finalSummary = summarizeMode(finalRows, { mode: 'final_only', expectedRepeats: 3 });
    const thinkingSummary = summarizeMode(thinkingRows, { mode: 'explicit_thinking', expectedRepeats: 3 });

    const comparison = compareModeSummaries(finalSummary, thinkingSummary, { minimumRepeats: 3 });

    expect(comparison).toMatchObject({
      identity: { comparable: true },
      paired_prompts: 1,
      unresolved_prompts: 1,
      mean_prompt_quality_delta: 1,
      latency_multiplier: 1
    });
    expect(comparison.prompts[0]).toMatchObject({ prompt: 'logic', quality_delta: 1 });
    expect(comparison.unresolved[0].prompt).toBe('translation');
  });

  test('treats executable and pending-review rows as unresolved', () => {
    const executable = row('code', 10, { evaluation_authority: 'executable' });
    const pending = row('logic', 8, { needs_review: true });
    expect(isReviewClean(executable)).toBe(false);
    expect(unresolvedReason(executable)).toBe('executable_verification_required');
    expect(isReviewClean(pending)).toBe(false);
    expect(unresolvedReason(pending)).toBe('pending_human_review');
  });

  test('withholds comparison when the candidate artifact digest changes between modes', () => {
    const finalSummary = summarizeMode([
      row('logic', 8), row('logic', 8), row('logic', 8)
    ], { mode: 'final_only', expectedRepeats: 3 });
    const thinkingSummary = summarizeMode([
      row('logic', 9, { model_digest: 'sha256:other' }),
      row('logic', 9, { model_digest: 'sha256:other' }),
      row('logic', 9, { model_digest: 'sha256:other' })
    ], { mode: 'explicit_thinking', expectedRepeats: 3 });

    expect(compareModeSummaries(finalSummary, thinkingSummary, { minimumRepeats: 3 })).toMatchObject({
      identity: {
        comparable: false,
        reason: 'candidate_artifact_identity_not_exactly_matched'
      },
      paired_prompts: 0,
      unresolved_prompts: 1,
      mean_prompt_quality_delta: null,
      latency_multiplier: null
    });
  });
});

describe('paired thinking campaign plan', () => {
  const config = {
    host: 'http://candidate:11434',
    model: 'qwen:exact',
    judgeHost: 'http://judge:11434',
    judgeModel: 'judge:exact',
    judgeConcurrency: 1,
    promptIds: ['a'.repeat(24)],
    repeats: 3,
    numCtx: 8192,
    numPredict: 4096,
    temperature: 0.2,
    topP: 0.9,
    topK: 40,
    repeatPenalty: 1.1,
    seed: 42
  };

  test('freezes identical settings except for the explicit response mode', () => {
    const finalPayload = buildBatchPayload(config, 'final_only', 'f'.repeat(64));
    const thinkingPayload = buildBatchPayload(config, 'explicit_thinking', 'f'.repeat(64));

    expect(finalPayload.execution_config).toMatchObject({
      response_mode: 'final_only', think: false, repeats: 3, force_num_ctx: 8192,
      response_max_tokens: 4096, seed: 42
    });
    expect(thinkingPayload.execution_config).toMatchObject({
      response_mode: 'explicit_thinking', think: true, repeats: 3, force_num_ctx: 8192,
      response_max_tokens: 4096, seed: 42
    });
    const { response_mode: _finalMode, think: _finalThink, ...finalFixed } = finalPayload.execution_config;
    const { response_mode: _thinkingMode, think: _thinkingThink, ...thinkingFixed } = thinkingPayload.execution_config;
    expect(thinkingFixed).toEqual(finalFixed);
  });

  test('requires an explicit execute flag and at least three repeats', () => {
    const argv = [
      '--host', config.host, '--model', config.model,
      '--judge-host', config.judgeHost, '--judge-model', config.judgeModel,
      '--prompt-ids', config.promptIds[0]
    ];
    expect(parseArgs(argv)).toMatchObject({ execute: false, repeats: 3 });
    expect(parseArgs([...argv, '--execute']).execute).toBe(true);
    expect(() => parseArgs([...argv, '--repeats', '2'])).toThrow(/3 to 5/);
    expect(() => parseArgs([...argv.slice(0, -1), 'not-an-id'])).toThrow(/ObjectId/);
  });

  test('reads operator authorization from an environment variable without embedding it in the plan', () => {
    process.env.PAIRED_THINKING_TEST_TOKEN = 'secret';
    try {
      expect(headersFor({ operatorTokenEnv: 'PAIRED_THINKING_TEST_TOKEN' }, true)).toEqual({
        'Content-Type': 'application/json',
        'X-AgentX-Operator-Token': 'secret'
      });
    } finally {
      delete process.env.PAIRED_THINKING_TEST_TOKEN;
    }
  });
});
