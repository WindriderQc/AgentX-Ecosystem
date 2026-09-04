// public/js/model-profiler/models-helpers.js
/**
 * Models helpers — pure data/formatting utilities for the Model Profiler
 * Models sub-tab. No DOM/state dependencies; safe to import anywhere.
 * Extracted from models.js (task 0229) to keep files under the frontend cap.
 */

// ─── Constants ────────────────────────────────────────────────────────────────

export const STAGE_ORDER = ['benchmarked', 'profiled', 'available'];

export const FILTER_DEFS = [
  { key: 'all',          label: 'All' },
  { key: 'profiled',     label: 'Profiled' },
  { key: 'benchmarked',  label: 'Benchmarked' }
];

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Determine the highest readiness stage across all hosts for a model.
 * model.readiness may be a Map or plain object with hostId keys.
 * Each value is either a stage string or an object with a `stage` property.
 */
export function getHighestStage(model) {
  const readiness = model.readiness;
  if (!readiness) return 'available';

  const entries = readiness instanceof Map
    ? Array.from(readiness.values())
    : Object.values(readiness);

  if (entries.length === 0) return 'available';

  const stages = entries.map(v =>
    (typeof v === 'string' ? v : v?.stage) || 'available'
  );

  for (const stage of STAGE_ORDER) {
    if (stages.includes(stage)) return stage;
  }
  return 'available';
}

/**
 * Return a map of hostId → stage string.
 */
export function getHostStages(model) {
  const readiness = model.readiness;
  if (!readiness) return {};

  const result = {};
  const entries = readiness instanceof Map
    ? readiness.entries()
    : Object.entries(readiness);

  for (const [hostId, v] of entries) {
    result[hostId] = (typeof v === 'string' ? v : v?.stage) || 'available';
  }
  return result;
}

export function getReadinessForHost(readiness, hostId) {
  if (!readiness || !hostId) return readiness || {};

  if (readiness instanceof Map) {
    return readiness.has(hostId) ? new Map([[hostId, readiness.get(hostId)]]) : new Map();
  }

  return readiness[hostId] ? { [hostId]: readiness[hostId] } : {};
}

function readinessEntryForHost(readiness, hostId) {
  if (!readiness) return null;
  if (readiness instanceof Map) {
    if (hostId) return readiness.get(hostId) || null;
    return readiness.values().next().value || null;
  }
  if (hostId) return readiness[hostId] || null;
  return Object.values(readiness)[0] || null;
}

/**
 * Rebuild the profile-authority decision after every page load. Persisted
 * performance rows are evidence, but only the matching ModelProfile receipt
 * may authorize Standard/Full recommendations.
 */
export function classifyProfileEvidence(model, evidence, hostId) {
  const readiness = readinessEntryForHost(model?.readiness, hostId);
  const depth = evidence?.profile?.profileDepth || readiness?.profileDepth || null;
  const receipt = readiness?.authorityReceipt;
  const stale = readiness?.stale === true || evidence?.stale === true || evidence?.active === false;
  const evidenceId = String(evidence?._id || '');
  const readinessEvidenceId = String(readiness?.evidenceId || '');
  const qualified = !stale
    && ['standard', 'full'].includes(depth)
    && readiness?.benchmarkQualified === true
    && receipt?.source === 'profiler_pipeline'
    && Number(receipt?.version) === 1
    && /^[a-f0-9]{64}$/i.test(String(receipt?.digest || ''))
    && evidenceId !== ''
    && evidenceId === readinessEvidenceId
    && String(receipt?.evidenceId || '') === readinessEvidenceId
    && evidence?.artifact?.digest === readiness?.artifact?.digest
    && evidence?.artifact?.runtimeFingerprint === readiness?.artifact?.runtimeFingerprint;

  return {
    status: stale ? 'stale' : qualified ? 'qualified' : ['standard', 'full'].includes(depth) ? 'not_qualified' : 'diagnostic',
    benchmarkQualified: qualified,
    recommendationsAuthoritative: qualified,
    profileDepth: depth,
    reason: stale
      ? readiness?.staleReason || evidence?.staleReason || 'stale_profile_evidence'
      : qualified ? null : readiness?.qualificationReason || 'profiler_authority_receipt_missing_or_mismatched'
  };
}

/**
 * Count how many hosts are at or above the given stage.
 * (Any host whose stage appears earlier in STAGE_ORDER counts.)
 */
export function countAtStage(model, targetStage) {
  const hostStages = getHostStages(model);
  const targetIdx = STAGE_ORDER.indexOf(targetStage);
  if (targetIdx === -1) return 0;
  return Object.values(hostStages).filter(s => {
    const idx = STAGE_ORDER.indexOf(s);
    return idx !== -1 && idx <= targetIdx;
  }).length;
}

export function totalHosts(model) {
  const readiness = model.readiness;
  if (!readiness) return 0;
  return readiness instanceof Map ? readiness.size : Object.keys(readiness).length;
}

/**
 * Build a short metadata string: quantization, parameters, provider.
 */
export function buildMeta(model) {
  const parts = [];
  if (model.quantization) parts.push(model.quantization);
  if (model.parameters)   parts.push(model.parameters);
  if (model.provider)     parts.push(model.provider);
  // Capability badges
  const caps = model.capabilities || {};
  const capBadges = [];
  if (caps.vision)   capBadges.push('vision');
  if (caps.tools)    capBadges.push('tools');
  if (caps.thinking) capBadges.push(caps.thinkingPolicy && caps.thinkingPolicy !== 'unknown' ? `thinking:${caps.thinkingPolicy}` : 'thinking');
  if (capBadges.length) parts.push(capBadges.join('+'));
  return parts.join(' · ') || '—';
}

/** Format a profiledAt date as a short relative or absolute string. */
export function _fmtCtx(n) {
  if (n >= 1024) return `${Math.round(n / 1024)}k`;
  return String(n);
}

export function _formatProfileDate(dateVal) {
  if (!dateVal) return null;
  const d = new Date(dateVal);
  if (isNaN(d.getTime())) return null;
  const diffDays = Math.floor((Date.now() - d.getTime()) / 86400000);
  if (diffDays === 0) return 'today';
  if (diffDays === 1) return '1 day ago';
  if (diffDays < 30) return `${diffDays} days ago`;
  return `${d.toLocaleString('en-US', { month: 'short' })} ${d.getDate()}`;
}

export function _formatGiB(mib, digits = 1) {
  const n = Number(mib);
  return Number.isFinite(n) ? `${(n / 1024).toFixed(digits)}GB` : null;
}

export function _formatHardwareTitle(hw) {
  const latest = hw?.latest || {};
  const notes = hw?.diagnostics?.notes || latest.diagnostics?.notes || [];
  const models = (latest.runningModels || [])
    .map(m => m.sizeVramMiB ? `${m.name} (${_formatGiB(m.sizeVramMiB)})` : m.name)
    .filter(Boolean);
  return [
    latest.source ? `source: ${latest.source}` : null,
    latest.gpuName || null,
    notes.length ? `notes: ${notes.join('; ')}` : null,
    models.length ? `running: ${models.join(', ')}` : null
  ].filter(Boolean).join(' | ');
}

/** Build staleness info from per-host readiness entries. */
export function _getStalenessInfo(model) {
  const readiness = model.readiness;
  if (!readiness) return { stale: false, reasons: [] };
  const entries = readiness instanceof Map ? Array.from(readiness.values()) : Object.values(readiness);
  const reasons = [];
  let stale = false;
  for (const v of entries) {
    if (typeof v === 'object' && v?.stale === true) {
      stale = true;
      if (v.reason && !reasons.includes(v.reason)) reasons.push(v.reason);
    }
  }
  return { stale, reasons };
}

export function escAttr(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// ─── Filter + search logic ────────────────────────────────────────────────────

export function matchesFilter(model, filter) {
  if (filter === 'all') return true;
  const stage = getHighestStage(model);
  if (filter === 'profiled')    return stage === 'profiled' || stage === 'benchmarked';
  if (filter === 'benchmarked') return stage === 'benchmarked';
  return true;
}

export function matchesSearch(model, query) {
  if (!query) return true;
  return model.name.toLowerCase().includes(query.toLowerCase());
}

export function applyFilters(models, filter, query) {
  return models.filter(m => matchesFilter(m, filter) && matchesSearch(m, query));
}
