'use strict';

const crypto = require('crypto');
const { chat } = require('../../clients/ollamaClient');
const { extractThinkingBlocks } = require('../../helpers/ollamaResponseHandler');
const logger = require('../../../config/logger');

const THINKING_PROFILE_VERSION = 2;
const DEFAULT_NUM_CTX = 4096;
const DEFAULT_NUM_PREDICT = 512;
const DEFAULT_CONTRACT_RETRY_NUM_PREDICT = 1024;
const DEFAULT_STRESS_RETRY_NUM_PREDICT = 2048;
const DEFAULT_TIMEOUT_MS = 120000;
const FINAL_ANSWER_RE = /\bFINAL\s*:\s*42\b/i;
const THINKING_PROBE_PROMPT = [
  'Solve this exactly. If the runtime offers private thinking, use it privately.',
  'Your visible answer must contain one final line exactly in this form: FINAL: 42',
  'Problem: What is 17 + 25?'
].join('\n');
const CONTRACTLESS_PROBE_PROMPT = [
  'Solve this exactly. If the runtime offers private thinking, use it privately.',
  'Problem: What is 17 + 25?',
  'Reply with the answer only.'
].join('\n');
const REASONING_STRESS_PROBE_PROMPT = [
  'Solve this exactly. If the runtime offers private thinking, use it privately.',
  'Your visible answer must contain one final line exactly in this form: FINAL: 2',
  'Problem: Five people sit in seats 1 through 5 from left to right.',
  'Eli is in seat 1. Ben is in seat 4. Ada sits immediately left of Ben.',
  'Cy is not at either end, and Di sits somewhere to the right of Cy.',
  'Which seat is Cy in?'
].join('\n');

const THINKING_PROBES = Object.freeze([
  {
    name: 'contract',
    prompt: THINKING_PROBE_PROMPT,
    finalAnswerRegex: FINAL_ANSWER_RE,
    finalAnswerExpected: 'FINAL: 42',
    requiresContract: true,
    retryNumPredict: DEFAULT_CONTRACT_RETRY_NUM_PREDICT
  },
  {
    name: 'contractless',
    prompt: CONTRACTLESS_PROBE_PROMPT,
    finalAnswerRegex: /\b42\b/,
    finalAnswerExpected: '42',
    requiresContract: false,
    diagnosticOnly: true
  },
  {
    name: 'reasoning_stress',
    prompt: REASONING_STRESS_PROBE_PROMPT,
    finalAnswerRegex: /\bFINAL\s*:\s*2\b/i,
    finalAnswerExpected: 'FINAL: 2',
    requiresContract: true,
    retryNumPredict: DEFAULT_STRESS_RETRY_NUM_PREDICT
  }
]);

function _positiveInt(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.round(n) : fallback;
}

function _round(value, places = 2) {
  const n = Number(value);
  return Number.isFinite(n) ? Number(n.toFixed(places)) : null;
}

function _ratio(numerator, denominator) {
  const a = Number(numerator);
  const b = Number(denominator);
  if (!Number.isFinite(a) || !Number.isFinite(b) || b <= 0) return null;
  return _round(a / b, 2);
}

function _hasText(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function _estimateTokens(text) {
  return Math.ceil(String(text || '').length / 4);
}

function _hashPrompt(prompt) {
  return crypto.createHash('sha256').update(prompt || '').digest('hex').slice(0, 16);
}

function _extractRawContent(data = {}) {
  if (_hasText(data.message?.content)) return data.message.content;
  if (_hasText(data.response)) return data.response;
  return '';
}

function _extractNativeThinking(data = {}) {
  if (_hasText(data.message?.thinking)) return data.message.thinking;
  if (_hasText(data.thinking)) return data.thinking;
  return null;
}

function _classifyChannel({ nativeThinkingPresent, visibleThinkingTags }) {
  if (nativeThinkingPresent && visibleThinkingTags) return 'mixed';
  if (nativeThinkingPresent) return 'hidden';
  if (visibleThinkingTags) return 'visible_tags';
  return 'none';
}

function analyzeThinkingResponse(data = {}, requestedThink = false, latencyMs = null, error = null, options = {}) {
  const finalAnswerRegex = options.finalAnswerRegex || FINAL_ANSWER_RE;
  if (error) {
    return {
      probeName: options.probeName || null,
      promptHash: options.promptHash || null,
      finalAnswerExpected: options.finalAnswerExpected || null,
      attempt: options.attempt || 1,
      numPredict: options.numPredict || null,
      retried: false,
      retryReason: null,
      attempts: undefined,
      requestedThink,
      ok: false,
      error: error.message || String(error),
      channel: 'error',
      visibleFinalAnswerOk: false,
      finalAnswerContractOk: false,
      thinkingPresent: false,
      nativeThinkingPresent: false,
      visibleThinkingTags: false,
      thinkingOnlyResponse: false,
      runawayRisk: false,
      responseTruncated: false,
      doneReason: null,
      latencyMs,
      promptTokens: null,
      completionTokens: null,
      tokensPerSec: null,
      visibleChars: 0,
      thinkingChars: 0,
      rawContentChars: 0
    };
  }

  const rawContent = _extractRawContent(data);
  const nativeThinking = _extractNativeThinking(data);
  const nativeThinkingPresent = _hasText(nativeThinking);
  const visibleThinkingTags = /<think\b/i.test(rawContent);
  const extraction = extractThinkingBlocks(rawContent, nativeThinking);
  const visible = extraction.content || '';
  const thinking = extraction.thinking || '';
  const visibleFinalAnswerOk = _hasText(visible);
  const finalAnswerContractOk = finalAnswerRegex ? finalAnswerRegex.test(visible) : visibleFinalAnswerOk;
  const thinkingPresent = _hasText(thinking);
  const thinkingOnlyResponse = thinkingPresent && !visibleFinalAnswerOk;
  const responseTruncated = data.done_reason === 'length';
  const completionTokens = Number(data.eval_count) || _estimateTokens(`${rawContent}${thinking}`);
  const evalDurationSec = Number(data.eval_duration) > 0 ? Number(data.eval_duration) / 1e9 : null;
  const tokensPerSec = evalDurationSec ? _round(completionTokens / evalDurationSec, 2) : null;

  return {
    probeName: options.probeName || null,
    promptHash: options.promptHash || null,
    finalAnswerExpected: options.finalAnswerExpected || null,
    attempt: options.attempt || 1,
    numPredict: options.numPredict || null,
    retried: false,
    retryReason: null,
    attempts: undefined,
    requestedThink,
    ok: true,
    error: null,
    channel: _classifyChannel({ nativeThinkingPresent, visibleThinkingTags }),
    visibleFinalAnswerOk,
    finalAnswerContractOk,
    thinkingPresent,
    nativeThinkingPresent,
    visibleThinkingTags,
    thinkingOnlyResponse,
    runawayRisk: thinkingPresent && responseTruncated,
    responseTruncated,
    doneReason: data.done_reason || null,
    latencyMs,
    promptTokens: Number(data.prompt_eval_count) || null,
    completionTokens,
    tokensPerSec,
    visibleChars: visible.length,
    thinkingChars: thinking.length,
    rawContentChars: rawContent.length
  };
}

async function _probeCall({ hostUrl, modelName, requestedThink, probe, numCtx, numPredict, timeoutMs, signal, attempt = 1 }) {
  const startedAt = Date.now();
  const prompt = probe?.prompt || THINKING_PROBE_PROMPT;
  const promptHash = _hashPrompt(prompt);
  try {
    const data = await chat(hostUrl, {
      model: modelName,
      stream: false,
      think: requestedThink,
      keep_alive: '10m',
      messages: [{ role: 'user', content: prompt }],
      options: {
        ...(numCtx ? { num_ctx: numCtx } : {}),
        num_predict: numPredict,
        temperature: 0,
        seed: 7
      }
    }, { timeoutMs, signal });
    return analyzeThinkingResponse(data, requestedThink, Date.now() - startedAt, null, {
      probeName: probe?.name || null,
      promptHash,
      finalAnswerRegex: probe?.finalAnswerRegex,
      finalAnswerExpected: probe?.finalAnswerExpected,
      attempt,
      numPredict
    });
  } catch (err) {
    if (signal?.aborted) throw (signal.reason instanceof Error ? signal.reason : err);
    return analyzeThinkingResponse({}, requestedThink, Date.now() - startedAt, err, {
      probeName: probe?.name || null,
      promptHash,
      finalAnswerRegex: probe?.finalAnswerRegex,
      finalAnswerExpected: probe?.finalAnswerExpected,
      attempt,
      numPredict
    });
  }
}

function _compactAttempt(attempt) {
  if (!attempt || typeof attempt !== 'object') return null;
  const { attempts, ...rest } = attempt;
  return rest;
}

function _retryReason(probe, result, numPredict) {
  if (!probe?.requiresContract || !probe.retryNumPredict) return null;
  if (!result?.ok || !result.thinkingPresent || !result.responseTruncated) return null;
  if (result.visibleFinalAnswerOk && result.finalAnswerContractOk && !result.thinkingOnlyResponse) return null;
  return `contracted think=true probe hit num_predict=${numPredict} while thinking was present`;
}

async function _probeCallWithRetry({ hostUrl, modelName, requestedThink, probe, numCtx, numPredict, timeoutMs, signal, assertClaimActive }) {
  const first = await _probeCall({
    hostUrl,
    modelName,
    requestedThink,
    probe,
    numCtx,
    numPredict,
    timeoutMs,
    signal,
    attempt: 1
  });
  assertClaimActive?.();
  const retryReason = requestedThink ? _retryReason(probe, first, numPredict) : null;
  const retryNumPredict = retryReason
    ? Math.max(numPredict, _positiveInt(probe.retryNumPredict, numPredict))
    : numPredict;

  if (!retryReason || retryNumPredict <= numPredict) {
    return {
      ...first,
      attempts: [_compactAttempt(first)].filter(Boolean)
    };
  }

  const second = await _probeCall({
    hostUrl,
    modelName,
    requestedThink,
    probe,
    numCtx,
    numPredict: retryNumPredict,
    timeoutMs,
    signal,
    attempt: 2
  });
  assertClaimActive?.();

  return {
    ...second,
    retried: true,
    retryReason,
    initialNumPredict: numPredict,
    numPredict: retryNumPredict,
    attempts: [_compactAttempt(first), _compactAttempt(second)].filter(Boolean)
  };
}

function _supportSignal(control, think) {
  if (!think?.ok) return 'error';
  if (think.channel === 'mixed') return 'mixed_channel';
  if (think.channel === 'hidden') return 'hidden_channel';
  if (think.channel === 'visible_tags') return 'visible_tags';

  const tokenMultiplier = _ratio(think.completionTokens, control?.completionTokens);
  if (tokenMultiplier && tokenMultiplier >= 1.5 && (think.completionTokens - (control?.completionTokens || 0)) >= 32) {
    return 'token_overhead';
  }

  const latencyMultiplier = _ratio(think.latencyMs, control?.latencyMs);
  if (latencyMultiplier && latencyMultiplier >= 2 && (think.latencyMs - (control?.latencyMs || 0)) >= 750) {
    return 'latency_overhead';
  }

  return 'none';
}

function _positiveSignals(signalsByProbe) {
  const positives = Object.values(signalsByProbe || {})
    .filter(signal => signal && signal !== 'none' && signal !== 'error');
  return [...new Set(positives)];
}

function _hasProbeError(probes) {
  return Object.values(probes || {}).some(probe => probe?.ok === false || probe?.channel === 'error');
}

function _contractedThinkProbes(probes) {
  return THINKING_PROBES
    .filter(probe => probe.requiresContract)
    .map(probe => probes?.[probe.name])
    .filter(Boolean);
}

function _recommendPolicy({
  supported,
  supportSignal,
  think,
  contractedThinkProbes,
  tokenMultiplier,
  latencyMultiplier,
  contractSensitive,
  hasProbeError,
  retryProbeCount
}) {
  if (supportSignal === 'error') {
    return { policy: 'unknown', reason: 'think=true probe failed' };
  }
  if (!supported) {
    return { policy: 'off', reason: 'think=true produced no observable thinking behavior' };
  }
  if (contractedThinkProbes.some(probe => probe?.ok === false || probe?.channel === 'error')) {
    return { policy: 'unknown', reason: 'a contracted think=true behavior probe failed' };
  }
  if (contractedThinkProbes.some(probe => !probe.visibleFinalAnswerOk)) {
    return { policy: 'disallowed', reason: 'think=true did not consistently produce visible answer text' };
  }
  if (contractedThinkProbes.some(probe => probe.thinkingOnlyResponse)) {
    return { policy: 'disallowed', reason: 'think=true produced thinking-only output under a visible-answer contract' };
  }
  if (contractedThinkProbes.some(probe => probe.runawayRisk)) {
    return { policy: 'disallowed', reason: 'think=true hit the output cap while thinking was present' };
  }
  if (contractedThinkProbes.some(probe => !probe.finalAnswerContractOk)) {
    return { policy: 'metered', reason: 'think=true produced visible text but missed a final-answer contract' };
  }
  if (contractSensitive) {
    return { policy: 'metered', reason: 'think=true requires an explicit visible-final-answer contract' };
  }
  if (hasProbeError) {
    return { policy: 'metered', reason: 'at least one diagnostic think=true behavior probe failed' };
  }
  if (retryProbeCount > 0) {
    return { policy: 'metered', reason: 'think=true was safe only after an expanded probe budget' };
  }
  if ((tokenMultiplier && tokenMultiplier >= 4) || (latencyMultiplier && latencyMultiplier >= 4)) {
    return { policy: 'metered', reason: 'think=true is safe but materially increases token or latency cost' };
  }
  return { policy: 'on', reason: 'think=true produced thinking and a visible final answer within the probe budget' };
}

async function profileThinkingBehavior(modelName, hostUrl, options = {}) {
  const numCtx = Math.max(1024, Math.min(
    _positiveInt(options.numCtx, DEFAULT_NUM_CTX),
    _positiveInt(options.maxNumCtx, DEFAULT_NUM_CTX)
  ));
  const numPredict = _positiveInt(options.numPredict, DEFAULT_NUM_PREDICT);
  const timeoutMs = _positiveInt(options.timeoutMs, DEFAULT_TIMEOUT_MS);

  const controlProbe = THINKING_PROBES[0];
  const control = await _probeCall({
    hostUrl, modelName, requestedThink: false, probe: controlProbe, numCtx, numPredict, timeoutMs,
    signal: options.signal
  });
  options.assertClaimActive?.();
  const thinkProbes = {};
  const signalsByProbe = {};
  let probeAttempts = 1;
  let retryProbeCount = 0;
  let maxProbeNumPredict = control.numPredict || numPredict;
  for (const probe of THINKING_PROBES) {
    thinkProbes[probe.name] = await _probeCallWithRetry({
      hostUrl, modelName, requestedThink: true, probe, numCtx, numPredict, timeoutMs,
      signal: options.signal,
      assertClaimActive: options.assertClaimActive
    });
    const attempts = Array.isArray(thinkProbes[probe.name].attempts) ? thinkProbes[probe.name].attempts.length : 1;
    probeAttempts += attempts;
    if (thinkProbes[probe.name].retried) retryProbeCount += 1;
    maxProbeNumPredict = Math.max(maxProbeNumPredict, Number(thinkProbes[probe.name].numPredict) || numPredict);
    signalsByProbe[probe.name] = _supportSignal(control, thinkProbes[probe.name]);
  }

  const positiveSignals = _positiveSignals(signalsByProbe);
  const supportSignal = positiveSignals[0] || (Object.values(signalsByProbe).includes('error') ? 'error' : 'none');
  const supported = positiveSignals.length > 0;
  const think = thinkProbes.contract;
  const contractedProbes = _contractedThinkProbes(thinkProbes);
  const tokenMultiplier = _ratio(think.completionTokens, control.completionTokens);
  const latencyMultiplier = _ratio(think.latencyMs, control.latencyMs);
  const contractSensitive = !!(
    think?.visibleFinalAnswerOk
    && thinkProbes.contractless
    && !thinkProbes.contractless.visibleFinalAnswerOk
  );
  const recommendation = _recommendPolicy({
    supported,
    supportSignal,
    think,
    contractedThinkProbes: contractedProbes,
    tokenMultiplier,
    latencyMultiplier,
    contractSensitive,
    hasProbeError: _hasProbeError(thinkProbes),
    retryProbeCount
  });

  const profile = {
    profileVersion: THINKING_PROFILE_VERSION,
    profiledAt: new Date(),
    apiMode: 'chat',
    promptHash: _hashPrompt(THINKING_PROBE_PROMPT),
    probeCount: 1 + THINKING_PROBES.length,
    probeAttempts,
    retryProbeCount,
    maxProbeNumPredict,
    defaultProbeNumPredict: numPredict,
    supported,
    supportSignal,
    supportSignals: positiveSignals,
    signalsByProbe,
    channel: think.channel || 'unknown',
    visibleFinalAnswerOk: contractedProbes.every(probe => !!probe.visibleFinalAnswerOk),
    finalAnswerContractOk: contractedProbes.every(probe => !!probe.finalAnswerContractOk),
    thinkingOnlyResponse: contractedProbes.some(probe => !!probe.thinkingOnlyResponse),
    runawayRisk: contractedProbes.some(probe => !!probe.runawayRisk),
    contractSensitive,
    contractlessVisibleAnswerOk: !!thinkProbes.contractless?.visibleFinalAnswerOk,
    stressVisibleAnswerOk: !!thinkProbes.reasoning_stress?.visibleFinalAnswerOk,
    tokenMultiplier,
    latencyMultiplier,
    recommendedPolicy: recommendation.policy,
    recommendationReason: recommendation.reason,
    control,
    think,
    probes: thinkProbes
  };

  logger.info('Thinking behavior profiled', {
    modelName,
    hostUrl,
    supported: profile.supported,
    channel: profile.channel,
    policy: profile.recommendedPolicy,
    tokenMultiplier,
    latencyMultiplier
  });

  return profile;
}

module.exports = {
  THINKING_PROFILE_VERSION,
  THINKING_PROBE_PROMPT,
  analyzeThinkingResponse,
  profileThinkingBehavior
};
