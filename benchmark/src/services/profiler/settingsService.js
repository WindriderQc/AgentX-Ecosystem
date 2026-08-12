'use strict';

const BenchmarkConfig = require('../../../models/BenchmarkConfig');

const DEFAULTS = {
  degradationThreshold: 30,
  // Percent of num_ctx filled during context probing. 80 is a strict
  // long-context stress test; lower values profile interactive/chat workloads.
  contextProbeFillPct: 80,
  contextFillPct: 25,
  maxPromptTokens: 2048,
  numPredict: 64,
  // Default 3: sample 1 is discarded as a warm-up settle pass, leaving 2
  // steady-state samples for a meaningful coefficient of variation.
  throughputSamples: 3,
  thinkingProbeEnabled: true,
  collectHardwareTelemetry: true,
  showHardwareDiagnostics: true,
  warmup: true,
  testTimeoutSec: 60,
  baselineModel: 'qwen2.5:3b',
};

/** Maps setting key -> env var name */
const ENV_MAP = {
  degradationThreshold: 'CONTEXT_PROBE_DEGRADATION_PCT',
  contextProbeFillPct: 'CONTEXT_PROBE_FILL_PCT',
  contextFillPct: 'HOST_TEST_CONTEXT_FILL_PCT',
  maxPromptTokens: 'HOST_TEST_MAX_PROMPT_TOKENS',
  numPredict: 'HOST_TEST_NUM_PREDICT',
  throughputSamples: 'PROFILER_THROUGHPUT_SAMPLES',
  thinkingProbeEnabled: 'PROFILER_THINKING_PROBE_ENABLED',
  collectHardwareTelemetry: 'PROFILER_COLLECT_HARDWARE_TELEMETRY',
  showHardwareDiagnostics: 'PROFILER_SHOW_HARDWARE_DIAGNOSTICS',
  warmup: 'HOST_TEST_WARMUP',
  testTimeoutSec: 'HOST_TEST_TIMEOUT_MS',
  baselineModel: 'HOST_BASELINE_MODEL',
};

/**
 * Coerce a raw string from env/DB to the correct JS type based on the default value.
 */
function coerce(raw, defaultVal) {
  if (raw === undefined || raw === null) return undefined;
  if (typeof defaultVal === 'boolean') {
    if (typeof raw === 'boolean') return raw;
    return String(raw).toLowerCase() === 'true';
  }
  if (typeof defaultVal === 'number') {
    const n = parseInt(raw, 10);
    return Number.isNaN(n) ? undefined : n;
  }
  return raw;
}

/**
 * Resolve env var for a given key. Handles the special case where
 * HOST_TEST_TIMEOUT_MS is in milliseconds but testTimeoutSec is in seconds.
 */
function resolveEnv(key) {
  const envKey = ENV_MAP[key];
  if (!envKey) return undefined;
  // Keep the baseline override as a named read so the capability-conservation
  // inventory can prove that this supported setting still exists.
  const raw = key === 'baselineModel'
    ? process.env.HOST_BASELINE_MODEL
    : process.env[envKey];
  if (raw === undefined) return undefined;

  const defaultVal = DEFAULTS[key];
  let val = coerce(raw, defaultVal);

  // Convert ms -> sec for timeout
  if (key === 'testTimeoutSec' && typeof val === 'number') {
    val = Math.round(val / 1000);
  }

  return val;
}

/**
 * Get all profiler settings, resolved via: DB > env > default.
 */
async function getAll() {
  const dbEntries = await BenchmarkConfig.find({
    $or: [
      { key: { $regex: /^profiler\./ } },
      { key: 'hostBaselineModel' }
    ]
  });

  const dbMap = {};
  let legacyBaselineModel;
  for (const entry of dbEntries) {
    if (entry.key === 'hostBaselineModel') {
      legacyBaselineModel = entry.value;
      continue;
    }
    const shortKey = entry.key.replace('profiler.', '');
    dbMap[shortKey] = entry.value;
  }
  if (dbMap.baselineModel === undefined && legacyBaselineModel !== undefined) {
    dbMap.baselineModel = legacyBaselineModel;
  }

  const result = {};
  for (const key of Object.keys(DEFAULTS)) {
    if (dbMap[key] !== undefined) {
      result[key] = dbMap[key];
    } else {
      const envVal = resolveEnv(key);
      result[key] = envVal !== undefined ? envVal : DEFAULTS[key];
    }
  }
  return result;
}

/**
 * Save settings to DB. Only keys present in DEFAULTS are accepted.
 * Returns the full resolved settings after save.
 */
async function save(settings) {
  const entries = Object.entries(settings).filter(([k]) => k in DEFAULTS);

  await Promise.all(entries.map(([k, v]) =>
    BenchmarkConfig.findOneAndUpdate(
      { key: `profiler.${k}` },
      { key: `profiler.${k}`, value: v },
      { upsert: true, new: true }
    )
  ));

  return getAll();
}

module.exports = { getAll, save, DEFAULTS };
