'use strict';

const crypto = require('crypto');

const MODES = Object.freeze(['final_only', 'explicit_thinking']);

function round(value, digits = 3) {
  if (!Number.isFinite(value)) return null;
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function finitePresent(value) {
  return value !== null && value !== undefined && value !== '' && Number.isFinite(Number(value));
}

function numericStats(values) {
  const finite = (values || []).filter(finitePresent).map(Number);
  if (finite.length === 0) return { n: 0, mean: null, min: null, max: null };
  return {
    n: finite.length,
    mean: round(finite.reduce((sum, value) => sum + value, 0) / finite.length),
    min: round(Math.min(...finite)),
    max: round(Math.max(...finite))
  };
}

function promptKey(row) {
  return String(row?.prompt_name || row?.prompt_id || row?.id || 'unknown-prompt');
}

function isReviewClean(row) {
  return row?.success === true
    && row?.infra_error !== true
    && row?.evaluation_authority !== 'executable'
    && row?.needs_review !== true
    && row?.excluded_from_leaderboard !== true
    && finitePresent(row?.quality_score);
}

function unresolvedReason(row) {
  if (row?.success !== true) return row?.infra_error === true ? 'infrastructure_failure' : 'execution_failure';
  if (row?.evaluation_authority === 'executable') return 'executable_verification_required';
  if (row?.truncation?.thinking_only_response) return 'thinking_only_response';
  if (row?.truncation?.thinking_runaway) return 'thinking_runaway';
  if (row?.truncation?.input_truncated) return 'input_truncated';
  if (row?.excluded_from_leaderboard === true) return 'excluded_from_leaderboard';
  if (row?.needs_review === true) return 'pending_human_review';
  if (!finitePresent(row?.quality_score)) return 'unscored';
  return null;
}

function countBy(values) {
  const counts = {};
  for (const value of values || []) {
    if (!value) continue;
    counts[value] = (counts[value] || 0) + 1;
  }
  return counts;
}

function summarizeMode(rows, { mode, expectedRepeats }) {
  if (!MODES.includes(mode)) throw new Error(`unsupported response mode: ${mode}`);
  const all = Array.isArray(rows) ? rows : [];
  const clean = all.filter(isReviewClean);
  const successful = all.filter((row) => row?.success === true);
  const grouped = new Map();
  for (const row of all) {
    const key = promptKey(row);
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key).push(row);
  }

  const perPrompt = [...grouped.entries()].map(([name, promptRows]) => {
    const cleanRows = promptRows.filter(isReviewClean);
    const reasons = countBy(promptRows.map(unresolvedReason));
    return {
      prompt: name,
      category: promptRows.find((row) => row?.prompt_category)?.prompt_category || null,
      raw_count: promptRows.length,
      clean_count: cleanRows.length,
      expected_repeats: expectedRepeats,
      raw_quality: numericStats(promptRows.map((row) => row?.quality_score)),
      review_clean_quality: numericStats(cleanRows.map((row) => row?.quality_score)),
      latency_ms: numericStats(promptRows.filter((row) => row?.success === true).map((row) => row?.latency)),
      unresolved: reasons
    };
  }).sort((left, right) => left.prompt.localeCompare(right.prompt));

  return {
    mode,
    rows: all.length,
    raw: {
      quality: numericStats(all.map((row) => row?.quality_score)),
      composite: numericStats(all.map((row) => row?.composite_score))
    },
    review_clean: {
      rows: clean.length,
      quality: numericStats(clean.map((row) => row?.quality_score)),
      composite: numericStats(clean.map((row) => row?.composite_score))
    },
    execution: {
      successful: successful.length,
      failed: all.length - successful.length,
      latency_ms: numericStats(successful.map((row) => row?.latency)),
      tokens_per_second: numericStats(successful.map((row) => row?.tokens_per_sec)),
      thinking_chars: numericStats(successful.map((row) => row?.truncation?.thinking_chars || 0)),
      visible_response_chars: numericStats(successful.map((row) => row?.truncation?.visible_response_chars)),
      response_truncated: successful.filter((row) => row?.truncation?.response_truncated === true).length,
      thinking_only: successful.filter((row) => row?.truncation?.thinking_only_response === true).length,
      thinking_runaway: successful.filter((row) => row?.truncation?.thinking_runaway === true).length
    },
    evidence: {
      needs_review: all.filter((row) => row?.needs_review === true).length,
      excluded: all.filter((row) => row?.excluded_from_leaderboard === true).length,
      unresolved: countBy(all.map(unresolvedReason)),
      model_digests: [...new Set(all.map((row) => row?.model_digest).filter(Boolean))],
      inference_contract_fingerprints: [...new Set(all
        .map((row) => row?.execution_settings?.inference_contract_fingerprint)
        .filter(Boolean))]
    },
    per_prompt: perPrompt
  };
}

function compareModeSummaries(finalOnly, explicitThinking, { minimumRepeats = 3 } = {}) {
  const finalMap = new Map((finalOnly?.per_prompt || []).map((row) => [row.prompt, row]));
  const thinkingMap = new Map((explicitThinking?.per_prompt || []).map((row) => [row.prompt, row]));
  const prompts = [...new Set([...finalMap.keys(), ...thinkingMap.keys()])].sort();
  const finalDigests = finalOnly?.evidence?.model_digests || [];
  const thinkingDigests = explicitThinking?.evidence?.model_digests || [];
  const artifactComparable = finalDigests.length === 1
    && thinkingDigests.length === 1
    && finalDigests[0] === thinkingDigests[0];
  const identity = {
    comparable: artifactComparable,
    final_only_model_digests: finalDigests,
    explicit_thinking_model_digests: thinkingDigests,
    reason: artifactComparable ? null : 'candidate_artifact_identity_not_exactly_matched'
  };

  if (!artifactComparable) {
    return {
      minimum_repeats: minimumRepeats,
      identity,
      paired_prompts: 0,
      unresolved_prompts: prompts.length,
      mean_prompt_quality_delta: null,
      latency_multiplier: null,
      prompts: [],
      unresolved: prompts.map((prompt) => ({
        prompt,
        reason: identity.reason,
        final_only_clean_repeats: finalMap.get(prompt)?.review_clean_quality?.n || 0,
        explicit_thinking_clean_repeats: thinkingMap.get(prompt)?.review_clean_quality?.n || 0
      }))
    };
  }
  const paired = [];
  const unresolved = [];

  for (const prompt of prompts) {
    const left = finalMap.get(prompt);
    const right = thinkingMap.get(prompt);
    const leftN = left?.review_clean_quality?.n || 0;
    const rightN = right?.review_clean_quality?.n || 0;
    if (leftN >= minimumRepeats && rightN >= minimumRepeats) {
      paired.push({
        prompt,
        category: left?.category || right?.category || null,
        final_only_quality: left.review_clean_quality.mean,
        explicit_thinking_quality: right.review_clean_quality.mean,
        quality_delta: round(right.review_clean_quality.mean - left.review_clean_quality.mean),
        final_only_repeats: leftN,
        explicit_thinking_repeats: rightN
      });
    } else {
      unresolved.push({
        prompt,
        final_only_clean_repeats: leftN,
        explicit_thinking_clean_repeats: rightN,
        final_only_reasons: left?.unresolved || { missing_prompt: 1 },
        explicit_thinking_reasons: right?.unresolved || { missing_prompt: 1 }
      });
    }
  }

  const latencyFinal = finalOnly?.execution?.latency_ms?.mean;
  const latencyThinking = explicitThinking?.execution?.latency_ms?.mean;
  return {
    minimum_repeats: minimumRepeats,
    identity,
    paired_prompts: paired.length,
    unresolved_prompts: unresolved.length,
    mean_prompt_quality_delta: numericStats(paired.map((row) => row.quality_delta)).mean,
    latency_multiplier: Number.isFinite(latencyFinal) && latencyFinal > 0 && Number.isFinite(latencyThinking)
      ? round(latencyThinking / latencyFinal)
      : null,
    prompts: paired,
    unresolved
  };
}

function stableSerialize(value) {
  if (Array.isArray(value)) return `[${value.map(stableSerialize).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableSerialize(value[key])}`).join(',')}}`;
  }
  return value === undefined ? 'null' : JSON.stringify(value);
}

function fingerprint(value) {
  return crypto.createHash('sha256').update(stableSerialize(value)).digest('hex');
}

function buildBatchPayload(config, mode, pairId) {
  if (!MODES.includes(mode)) throw new Error(`unsupported response mode: ${mode}`);
  return {
    host: config.host,
    models: [config.model],
    levels: [1, 2, 3, 4, 5],
    prompt_ids: config.promptIds,
    run_name: `${config.runName || 'Paired thinking comparison'} · ${mode}`,
    description: `Exploratory paired thinking campaign ${pairId}; no automatic routing authority.`,
    tags: ['paired-thinking', 'exploratory', mode, `pair-${pairId.slice(0, 12)}`],
    judge_config: {
      host: config.judgeHost,
      model: config.judgeModel,
      think: false,
      concurrency: config.judgeConcurrency
    },
    execution_config: {
      force_num_ctx: config.numCtx,
      response_max_tokens: config.numPredict,
      response_max_tokens_source: 'caller',
      response_mode: mode,
      think: mode === 'explicit_thinking',
      thinking_final_answer_policy: 'visible_required',
      sampling_profile: 'controlled',
      temperature: config.temperature,
      top_p: config.topP,
      top_k: config.topK,
      repeat_penalty: config.repeatPenalty,
      seed: config.seed,
      repeats: config.repeats,
      api_mode: 'chat',
      include_length_hint: false,
      answer_contract_mode: 'auto'
    }
  };
}

module.exports = {
  MODES,
  numericStats,
  isReviewClean,
  unresolvedReason,
  summarizeMode,
  compareModeSummaries,
  fingerprint,
  buildBatchPayload
};
