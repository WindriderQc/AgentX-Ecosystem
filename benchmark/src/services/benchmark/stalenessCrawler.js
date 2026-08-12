'use strict';

/**
 * Staleness crawler (Backlog C of the per-host optimization plan).
 *
 * Scans benchmark-owned model state for stale or invalid evidence BEFORE it
 * breaks a sweep, and reports per host with suggested re-profile payloads.
 * Read-only / advisory: it never profiles, adapts, or mutates routing — it just
 * surfaces what needs attention (matching the plan's "do not auto-run without
 * an execution flag").
 *
 * Reasons:
 *   context_profile_stale   ModelContextProfile.stale
 *   profile_readiness_stale ModelProfile.readiness[hostId].stale
 *   adaptation_stale        ModelAdaptation.staleness.stale
 *   implausible_throughput  recorded tok/s above the flat cap or the B1
 *                           model-aware physical ceiling (reuses modelFitEstimator)
 *   missing_deployment      a routed model has no `deployed` adaptation on its host
 *
 * Pure: takes already-fetched record arrays (DI). The route adapter fetches.
 */

const { resolveHostBandwidthGBs, isImplausibleThroughput } = require('../modelFitEstimator');
const { parseQuantization } = require('../parameterDetection');

const FLAT_CAP_TOK_S = 10000;          // matches the context-probe default sane cap
const CEILING_MARGIN = 2;              // generous, matches the probe guard
const REPROFILE_REASONS = new Set([
  'context_profile_stale', 'profile_readiness_stale', 'adaptation_stale', 'implausible_throughput'
]);

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
function normModel(name) {
  return String(name || '').trim().toLowerCase().replace(/^ax\//, '').replace(/:latest$/, '');
}

/**
 * Layered throughput plausibility for a recorded reading. Flat cap first
 * (host-agnostic); then the B1 physical ceiling when host bandwidth + an
 * explicit quant are known. Returns a reason string or null.
 */
function throughputReason(tokensPerSec, modelName, hostUrl) {
  const tps = num(tokensPerSec);
  if (tps == null || tps <= 0) return null;
  if (tps > FLAT_CAP_TOK_S) return `${tps} tok/s exceeds sane cap ${FLAT_CAP_TOK_S}`;
  const quant = parseQuantization(modelName);
  const bw = resolveHostBandwidthGBs(hostUrl);
  if (quant && bw) {
    const r = isImplausibleThroughput(tps, { modelName, hostBandwidthGBs: bw, marginFactor: CEILING_MARGIN });
    if (r.implausible) return `${tps.toFixed(1)} tok/s exceeds physical ceiling ${r.ceilingTokSec.toFixed(1)} (×${CEILING_MARGIN})`;
  }
  return null;
}

/**
 * @param {object} input
 * @param {Array}  [input.contextProfiles] - ModelContextProfile docs (lean)
 * @param {Array}  [input.profiles]        - ModelProfile docs (lean; readiness map/object)
 * @param {Array}  [input.adaptations]     - ModelAdaptation docs (lean)
 * @param {object} [input.routedModelsByHost] - { hostId: [model,...] } for missing-deployment checks
 * @param {string} [input.hostFilter]      - restrict to one hostId or hostUrl
 * @returns {{ hosts: object, totals: object, suggestedProfileQueues: Array }}
 */
function analyzeStaleness(input = {}) {
  const hostFilter = input.hostFilter || null;
  const byHost = new Map(); // hostKey -> Map(model -> { model, reasons:Set, evidence:{} })

  const included = (hostId, hostUrl) =>
    !hostFilter || hostId === hostFilter || hostUrl === hostFilter;

  const entryFor = (hostKey, model) => {
    if (!byHost.has(hostKey)) byHost.set(hostKey, new Map());
    const models = byHost.get(hostKey);
    if (!models.has(model)) models.set(model, { model, reasons: new Set(), evidence: {} });
    return models.get(model);
  };

  // ── Context profiles: stale flag + recorded throughput sanity ──
  for (const cp of input.contextProfiles || []) {
    if (!included(cp.hostId, cp.hostUrl)) continue;
    const hostKey = cp.hostId || cp.hostUrl;
    if (cp.stale) {
      const e = entryFor(hostKey, cp.modelName);
      e.reasons.add('context_profile_stale');
      if (cp.staleReason) e.evidence.contextStaleReason = cp.staleReason;
    }
    const tr = throughputReason(cp.latestEvidence?.tokensPerSec, cp.modelName, cp.hostUrl);
    if (tr) {
      const e = entryFor(hostKey, cp.modelName);
      e.reasons.add('implausible_throughput');
      e.evidence.throughput = tr;
    }
  }

  // ── Profile readiness per host ──
  for (const p of input.profiles || []) {
    const readiness = p.readiness instanceof Map ? Object.fromEntries(p.readiness) : (p.readiness || {});
    for (const [hostId, r] of Object.entries(readiness)) {
      if (!included(hostId, null)) continue;
      if (r && r.stale) entryFor(hostId, p.name).reasons.add('profile_readiness_stale');
    }
  }

  // ── Adaptations: stale flag + throughput sanity ──
  const deployed = new Set();
  for (const a of input.adaptations || []) {
    if (a.deployment?.status === 'deployed') deployed.add(`${a.hostId}::${normModel(a.modelName)}`);
    if (!included(a.hostId, a.hostUrl)) continue;
    const hostKey = a.hostId || a.hostUrl;
    if (a.staleness?.stale) entryFor(hostKey, a.modelName).reasons.add('adaptation_stale');
    const tps = a.profile?.tokensPerSec ?? a.latestEvidence?.tokensPerSec;
    const tr = throughputReason(tps, a.modelName, a.hostUrl || a.hostId);
    if (tr) {
      const e = entryFor(hostKey, a.modelName);
      e.reasons.add('implausible_throughput');
      e.evidence.throughput = tr;
    }
  }

  // ── Routed models with no deployed adaptation ──
  for (const [hostId, models] of Object.entries(input.routedModelsByHost || {})) {
    if (!included(hostId, null)) continue;
    for (const model of models) {
      if (!deployed.has(`${hostId}::${normModel(model)}`)) {
        entryFor(hostId, model).reasons.add('missing_deployment');
      }
    }
  }

  // ── Build report ──
  const hosts = {};
  const byReason = {};
  let staleModels = 0;
  const suggestedProfileQueues = [];

  for (const [hostKey, models] of byHost) {
    const stale = [];
    const reprofileModels = [];
    for (const { model, reasons, evidence } of models.values()) {
      const reasonList = [...reasons];
      stale.push({ model, reasons: reasonList, evidence });
      staleModels++;
      for (const r of reasonList) byReason[r] = (byReason[r] || 0) + 1;
      if (reasonList.some((r) => REPROFILE_REASONS.has(r))) reprofileModels.push(model);
    }
    hosts[hostKey] = { count: stale.length, stale };
    if (reprofileModels.length) {
      // Re-profile payload shape matches /api/profiler/pipeline/profile-host.
      suggestedProfileQueues.push({ hostId: hostKey, skipRecentDays: 0, modelNames: reprofileModels });
    }
  }

  return { hosts, totals: { staleModels, byReason }, suggestedProfileQueues };
}

/**
 * Render a staleness report as a Self-Tuning Ledger entry (Maintenance
 * category). Advisory: records what was found and the re-profile it PROPOSES —
 * nothing is applied (the crawl and the suggested payloads never auto-run).
 * @param {object} report - analyzeStaleness output
 * @param {object} [opts] - { date, actor }
 * @returns {string} markdown ledger entry
 */
function formatStalenessLedgerEntry(report, opts = {}) {
  const date = opts.date || 'YYYY-MM-DD';
  const actor = opts.actor || 'Self-Tuning Lane (Claude Code)';
  const lines = [];
  lines.push(`## ${date} — Staleness crawl: ${report.totals.staleModels} model(s) flagged`);
  lines.push('');
  lines.push(`- **Actor:** ${actor}`);
  lines.push(`- **Category:** Maintenance (advisory — read-only crawl, no change applied)`);
  const reasons = Object.entries(report.totals.byReason || {}).map(([k, v]) => `${k}: ${v}`).join(', ');
  lines.push(`- **Evidence:** ${reasons || 'no stale evidence found'}.`);
  if (report.totals.staleModels > 0) {
    lines.push(`- **Findings:**`);
    for (const [host, h] of Object.entries(report.hosts || {})) {
      for (const m of h.stale) {
        const tp = m.evidence?.throughput ? ` (${m.evidence.throughput})` : '';
        lines.push(`  - \`${host}\` · \`${m.model}\`: ${m.reasons.join(', ')}${tp}`);
      }
    }
  }
  const proposed = (report.suggestedProfileQueues || [])
    .map((q) => `re-profile ${q.modelNames.length} model(s) on \`${q.hostId}\``)
    .join('; ');
  lines.push(`- **Proposed:** ${proposed || 'none'}`);
  lines.push(`- **Validation / Rollback:** n/a — read-only crawl; suggested re-profile payloads are NOT auto-run.`);
  return lines.join('\n');
}

module.exports = {
  analyzeStaleness,
  formatStalenessLedgerEntry,
  _internal: { throughputReason, normModel, FLAT_CAP_TOK_S, CEILING_MARGIN }
};
