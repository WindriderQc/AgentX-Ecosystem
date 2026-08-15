const crypto = require('crypto');
const VoiceTurnTrace = require('../../models/VoiceTurnTrace');
const Alert = require('../../models/Alert');
const logger = require('../../config/logger');

const WINDOWS = { '24h': 24, '7d': 168, '30d': 720, '90d': 2160 };
const MAX_METRIC_MS = 10 * 60 * 1000;
const MAX_TRACES = 5000;
const ALERT_RULE_ID = 'voice-turn-slo-sustained';
const ALERT_SAMPLE_SIZE = 5;
const ALERT_FAILURE_COUNT = 3;
const RECOVERY_SAMPLE_SIZE = 3;

const SLOS = Object.freeze({
  sttMs: { label: 'Warm STT', target: 4000, unit: 'ms' },
  firstTokenMs: { label: 'First token', target: 12000, unit: 'ms' },
  firstPhraseMs: { label: 'First phrase', target: 15000, unit: 'ms' },
  firstAudioMs: { label: 'First audio', target: 18000, unit: 'ms' },
  brainMs: { label: 'Total brain', target: 30000, unit: 'ms' },
  ttsRtf: { label: 'TTS real-time factor', target: 1, unit: 'ratio' },
  interSentenceGapMs: { label: 'Inter-sentence gap', target: 250, unit: 'ms' },
  totalTurnMs: { label: 'Total turn', target: 45000, unit: 'ms' },
  errorRatePct: { label: 'Error rate', target: 5, unit: '%' },
  fallbackRatePct: { label: 'Fallback rate', target: 5, unit: '%' }
});

function boundedText(value, max, fallback = null) {
  if (value === undefined || value === null) return fallback;
  const text = String(value).trim();
  return text ? text.slice(0, max) : fallback;
}

function finiteMetric(value, max = MAX_METRIC_MS) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) return null;
  return Math.min(number, max);
}

function normalizeTrace(input = {}) {
  const rawTraceId = input.traceId === undefined || input.traceId === null
    ? ''
    : String(input.traceId).trim();
  if (!rawTraceId || rawTraceId.length > 120) {
    const error = new Error('traceId is required and must not exceed 120 characters');
    error.code = 'VOICE_TRACE_ID_REQUIRED';
    error.status = 400;
    throw error;
  }
  const traceId = rawTraceId;
  const timings = input.timings && typeof input.timings === 'object' ? input.timings : {};
  const normalizedTimings = {
    sttMs: finiteMetric(timings.sttMs),
    firstTokenMs: finiteMetric(timings.firstTokenMs),
    firstPhraseMs: finiteMetric(timings.firstPhraseMs ?? timings.firstSentenceMs),
    firstAudioMs: finiteMetric(timings.firstAudioMs),
    brainMs: finiteMetric(timings.brainMs),
    ttsSynthesisMs: finiteMetric(timings.ttsSynthesisMs),
    ttsPlaybackMs: finiteMetric(timings.ttsPlaybackMs),
    ttsRtf: finiteMetric(timings.ttsRtf, 100),
    interSentenceGapMs: finiteMetric(timings.interSentenceGapMs),
    totalTurnMs: finiteMetric(timings.totalTurnMs)
  };
  const validStatuses = ['success', 'error', 'cancelled'];
  if (input.status !== undefined && !validStatuses.includes(input.status)) {
    const error = new Error('status must be success, error, or cancelled');
    error.code = 'VOICE_TRACE_STATUS_INVALID';
    error.status = 400;
    throw error;
  }
  const status = input.status || 'success';
  const fallbackUsed = input.fallbackUsed === true || Boolean(input.fallback);
  const violations = Object.entries(SLOS)
    .filter(([key]) => !key.endsWith('RatePct'))
    .filter(([key, slo]) => normalizedTimings[key] !== null && normalizedTimings[key] > slo.target)
    .map(([key]) => key);
  if (status === 'error') violations.push('error');
  if (fallbackUsed) violations.push('fallback');

  return {
    traceId,
    observedAt: new Date(),
    status,
    inputMode: input.inputMode === 'text' ? 'text' : 'voice',
    surface: boundedText(input.surface, 64, 'unknown'),
    requestedLane: boundedText(input.requestedLane, 40),
    lane: boundedText(input.lane, 40),
    brain: boundedText(input.brain, 80),
    model: boundedText(input.model, 200),
    host: boundedText(input.host, 300),
    fallbackUsed,
    fallbackReason: boundedText(input.fallbackReason || input.fallback?.reason, 120),
    stt: {
      provider: boundedText(input.stt?.provider, 80),
      model: boundedText(input.stt?.model, 160)
    },
    tts: {
      provider: boundedText(input.tts?.provider, 80),
      model: boundedText(input.tts?.model, 160),
      voice: boundedText(input.tts?.voice, 120)
    },
    timings: normalizedTimings,
    sentenceCount: Math.max(0, Math.min(100, Math.floor(Number(input.sentenceCount) || 0))),
    errorCode: boundedText(input.errorCode, 120),
    sloViolations: [...new Set(violations)]
  };
}

function percentile(values, fraction) {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!sorted.length) return null;
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)];
}

function metricSummary(traces, key) {
  const values = traces.map((trace) => trace.timings?.[key]).filter(Number.isFinite);
  const slo = SLOS[key];
  const p95 = percentile(values, 0.95);
  return {
    label: slo.label,
    unit: slo.unit,
    target: slo.target,
    sampleSize: values.length,
    p50: percentile(values, 0.5),
    p95,
    status: p95 === null ? 'unavailable' : (p95 <= slo.target ? 'healthy' : 'degraded')
  };
}

function rateSummary(traces, predicate, sloKey) {
  const count = traces.filter(predicate).length;
  const ratePct = traces.length ? Math.round((count / traces.length) * 10000) / 100 : null;
  return {
    label: SLOS[sloKey].label,
    unit: '%',
    target: SLOS[sloKey].target,
    sampleSize: traces.length,
    count,
    ratePct,
    status: ratePct === null ? 'unavailable' : (ratePct <= SLOS[sloKey].target ? 'healthy' : 'degraded')
  };
}

function isTraceHealthy(trace) {
  // User cancellation/barge-in is an intentional control action, not a
  // reliability failure. It remains visible in recent traces but cannot open
  // a sustained-regression incident by itself.
  return trace.status !== 'error' && !(trace.sloViolations || []).length;
}

function segmentKey(trace) {
  return [
    trace.surface || 'unknown', trace.lane || 'unknown', trace.model || 'unknown',
    trace.host || 'unknown', trace.stt?.provider || 'unknown', trace.stt?.model || 'unknown',
    trace.tts?.provider || 'unknown', trace.tts?.model || 'unknown', trace.fallbackUsed ? 'fallback' : 'primary'
  ].join('\u001f');
}

function summarizeTraces(traces, window) {
  const metrics = Object.fromEntries(
    Object.keys(SLOS).filter((key) => !key.endsWith('RatePct')).map((key) => [key, metricSummary(traces, key)])
  );
  const rates = {
    errors: rateSummary(traces, (trace) => trace.status === 'error', 'errorRatePct'),
    fallbacks: rateSummary(traces, (trace) => trace.fallbackUsed === true, 'fallbackRatePct')
  };
  const groups = new Map();
  traces.forEach((trace) => {
    const key = segmentKey(trace);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(trace);
  });
  const segments = [...groups.values()].map((rows) => {
    const first = rows[0];
    return {
      surface: first.surface || 'unknown',
      lane: first.lane || 'unknown',
      model: first.model || 'unknown',
      host: first.host || 'unknown',
      sttProvider: first.stt?.provider || 'unknown',
      sttModel: first.stt?.model || 'unknown',
      ttsProvider: first.tts?.provider || 'unknown',
      ttsModel: first.tts?.model || 'unknown',
      fallback: first.fallbackUsed === true,
      samples: rows.length,
      successRatePct: Math.round((rows.filter((row) => row.status === 'success').length / rows.length) * 10000) / 100,
      firstAudioP95Ms: percentile(rows.map((row) => row.timings?.firstAudioMs), 0.95),
      totalTurnP95Ms: percentile(rows.map((row) => row.timings?.totalTurnMs), 0.95),
      ttsRtfP95: percentile(rows.map((row) => row.timings?.ttsRtf), 0.95)
    };
  }).sort((a, b) => b.samples - a.samples).slice(0, 50);

  const degraded = [...Object.values(metrics), ...Object.values(rates)]
    .some((item) => item.status === 'degraded');
  const failed = traces.length >= 3 && rates.errors.ratePct >= 50;
  return {
    window,
    source: 'voiceturntraces',
    privacy: 'No audio, transcript, prompt, or reply is retained.',
    status: traces.length === 0 ? 'idle' : (failed ? 'failed' : (degraded ? 'degraded' : 'healthy')),
    sampleSize: traces.length,
    confidence: traces.length >= ALERT_SAMPLE_SIZE ? 'established' : (traces.length ? 'low-sample' : 'none'),
    metrics,
    rates,
    segments,
    recent: traces.slice(0, 20).map((trace) => ({
      traceId: trace.traceId,
      observedAt: trace.observedAt,
      status: trace.status,
      surface: trace.surface,
      lane: trace.lane,
      model: trace.model,
      host: trace.host,
      fallbackUsed: trace.fallbackUsed,
      timings: trace.timings,
      sloViolations: trace.sloViolations || []
    }))
  };
}

function resolveWindow(raw) {
  const key = WINDOWS[raw] ? raw : '24h';
  const to = new Date();
  const from = new Date(to.getTime() - WINDOWS[key] * 60 * 60 * 1000);
  return { key, from, to };
}

function alertFingerprint(surface) {
  return crypto.createHash('sha256').update(`${ALERT_RULE_ID}|${surface}`).digest('hex');
}

async function reconcileSustainedAlert(surface, deps = {}) {
  const TraceModel = deps.TraceModel || VoiceTurnTrace;
  const AlertModel = deps.AlertModel || Alert;
  const recent = await TraceModel.find({ surface }).sort({ observedAt: -1 }).limit(ALERT_SAMPLE_SIZE).lean();
  const fingerprint = alertFingerprint(surface);
  const recovered = recent.length >= RECOVERY_SAMPLE_SIZE
    && recent.slice(0, RECOVERY_SAMPLE_SIZE).every(isTraceHealthy);
  if (recovered) {
    const result = await AlertModel.updateMany(
      { fingerprint, status: { $in: ['active', 'acknowledged'] } },
      { $set: {
        status: 'resolved',
        'resolution.resolved': true,
        'resolution.resolvedAt': new Date(),
        'resolution.resolvedBy': 'voice-observability',
        'resolution.resolutionMethod': 'auto-recovery',
        'resolution.comment': `Three healthy ${surface} voice turns`
      } }
    );
    return { state: 'healthy', resolved: result?.modifiedCount ?? result?.nModified ?? 0 };
  }

  const failing = recent.filter((trace) => !isTraceHealthy(trace)).length;
  if (recent.length < ALERT_SAMPLE_SIZE || failing < ALERT_FAILURE_COUNT) {
    return { state: 'insufficient-or-transient', samples: recent.length, failing };
  }

  const now = new Date();
  const context = {
    component: surface,
    metric: 'voice_turn_slo',
    currentValue: failing,
    threshold: ALERT_FAILURE_COUNT,
    additionalData: { samples: recent.length, failing }
  };
  const updated = await AlertModel.findOneAndUpdate(
    { fingerprint, status: { $in: ['active', 'acknowledged'] } },
    { $set: { lastOccurrence: now, context }, $inc: { occurrenceCount: 1 } },
    { new: true }
  );
  if (updated) return { state: 'active', alertId: String(updated._id), deduplicated: true };
  try {
    const created = await AlertModel.create({
      ruleId: ALERT_RULE_ID,
      ruleName: 'Sustained voice-turn SLO regression',
      severity: 'warning',
      title: `Voice experience degraded on ${surface}`,
      message: `${failing} of the latest ${recent.length} turns breached a user-visible SLO.`,
      context,
      fingerprint,
      channels: ['local_log'],
      source: 'voice-observability',
      lastOccurrence: now
    });
    logger.warn('Sustained voice-turn SLO alert opened', { surface, failing, samples: recent.length });
    return { state: 'active', alertId: String(created._id), deduplicated: false };
  } catch (error) {
    if (error.code !== 11000) throw error;
    return { state: 'active', deduplicated: true };
  }
}

async function ingestTrace(input, deps = {}) {
  const TraceModel = deps.TraceModel || VoiceTurnTrace;
  const normalized = normalizeTrace(input);
  let trace;
  try {
    trace = await TraceModel.create(normalized);
  } catch (error) {
    if (error.code !== 11000) throw error;
    trace = await TraceModel.findOne({ traceId: normalized.traceId });
  }
  const alert = await reconcileSustainedAlert(normalized.surface, deps);
  const row = trace?.toObject ? trace.toObject() : trace;
  return { trace: row, alert };
}

async function getSummary(input = {}, deps = {}) {
  const TraceModel = deps.TraceModel || VoiceTurnTrace;
  const { key, from, to } = resolveWindow(input.window);
  const filter = { observedAt: { $gte: from, $lte: to } };
  const surface = boundedText(input.surface, 64);
  if (surface) filter.surface = surface;
  const traces = await TraceModel.find(filter).sort({ observedAt: -1 }).limit(MAX_TRACES).lean();
  return summarizeTraces(traces, { key, from, to, truncated: traces.length === MAX_TRACES });
}

module.exports = {
  SLOS,
  normalizeTrace,
  summarizeTraces,
  reconcileSustainedAlert,
  ingestTrace,
  getSummary,
  resolveWindow
};
