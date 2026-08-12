// memoryReview/dedupService.js — deterministic dedup/conflict context.
//
// Fail-soft by design: RAG being down degrades dedup (flagged on the run as
// dedupContext.degraded) but never blocks collection or review. Nothing here
// calls a model.

const { getRagServiceClient } = require('../ragServiceClient');
const MemoryReviewRun = require('../../../models/MemoryReviewRun');
const { LIMITS } = require('./policy');

const RAG_SEARCH_TIMEOUT_MS = Math.max(
  1000,
  Math.min(20000, Number(process.env.MEMORY_REVIEW_RAG_TIMEOUT_MS) || 5000)
);
const MAX_OBSERVATIONS_SEARCHED = 20;
const RAG_MIN_SCORE = 0.55;
const DUPLICATE_SCORE = 0.8;

/**
 * Search nestor-memory + agent-artifacts for near matches of the strongest
 * observations. Returns { ragMatches, degraded, degradedReason }.
 */
async function buildRagDedupContext(observations, { ragClient } = {}) {
  const client = ragClient || getRagServiceClient();
  const strongest = [...observations]
    .sort((a, b) => (b.recurrence?.observationCount || 1) - (a.recurrence?.observationCount || 1))
    .slice(0, MAX_OBSERVATIONS_SEARCHED);

  const ragMatches = [];
  let failures = 0;
  let lastError = null;
  for (const source of ['nestor-memory', 'agent-artifacts']) {
    const settled = await Promise.allSettled(strongest.map((obs) =>
      client.searchSimilarChunks(String(obs.text).slice(0, 300), {
        topK: 3,
        minScore: RAG_MIN_SCORE,
        filters: { source },
        timeoutMs: RAG_SEARCH_TIMEOUT_MS,
      }).then((results) => ({ obs, results }))));
    for (const outcome of settled) {
      if (outcome.status === 'rejected') {
        failures += 1;
        lastError = outcome.reason;
        continue;
      }
      const { obs, results } = outcome.value;
      for (const hit of results.slice(0, 3)) {
        ragMatches.push({
          observationId: obs.observationId,
          source,
          documentId: hit?.metadata?.documentId || null,
          score: Math.round((hit?.score || 0) * 1000) / 1000,
          gist: String(hit?.text || '').replace(/\s+/g, ' ').slice(0, 200),
        });
      }
    }
  }
  const attempted = strongest.length * 2;
  const degraded = attempted > 0 && failures > 0;
  return {
    ragMatches: ragMatches.slice(0, 120),
    degraded,
    degradedReason: degraded
      ? `RAG dedup incomplete (${failures}/${attempted} searches failed): ${String(lastError && lastError.message).slice(0, 160)}`
      : null,
    attempted,
    failures,
  };
}

/**
 * Prior-run candidate dispositions (statement + status), newest first, for
 * suppression of re-proposals and for the synthesis dedup context.
 */
async function loadPriorCandidates(excludeRunId, limit = 15) {
  const runs = await MemoryReviewRun.find(
    { runId: { $ne: excludeRunId } },
    { runId: 1, 'candidates.candidateId': 1, 'candidates.statement': 1, 'candidates.status': 1, 'candidates.evidence.contentHash': 1, createdAt: 1 }
  ).sort({ createdAt: -1 }).limit(limit).lean();

  const priors = [];
  const byId = new Map();
  for (const run of runs) {
    for (const candidate of run.candidates || []) {
      if (!byId.has(candidate.candidateId)) {
        const entry = {
          candidateId: candidate.candidateId,
          runId: run.runId,
          statement: String(candidate.statement || '').slice(0, 160),
          status: candidate.status,
          evidenceHashes: (candidate.evidence || []).map((e) => e.contentHash).filter(Boolean),
        };
        byId.set(candidate.candidateId, entry);
        if (priors.length < LIMITS.MAX_DEDUP_CONTEXT_LINES) priors.push(entry);
      }
    }
  }
  return { priors, byId };
}

/** Load the newest disposition for specific stable candidate ids without a
 * recency-window blind spot. At most 30 ids enter from one bounded run. */
async function loadPriorCandidatesByIds(candidateIds, excludeRunId) {
  const ids = [...new Set((candidateIds || []).filter(Boolean))].slice(0, 30);
  if (!ids.length) return new Map();
  const runs = await MemoryReviewRun.find(
    { runId: { $ne: excludeRunId }, 'candidates.candidateId': { $in: ids } },
    {
      runId: 1,
      'candidates.candidateId': 1,
      'candidates.statement': 1,
      'candidates.status': 1,
      'candidates.evidence.contentHash': 1,
      createdAt: 1,
    }
  ).sort({ createdAt: -1 }).lean();
  const wanted = new Set(ids);
  const byId = new Map();
  for (const run of runs) {
    for (const candidate of run.candidates || []) {
      if (!wanted.has(candidate.candidateId) || byId.has(candidate.candidateId)) continue;
      byId.set(candidate.candidateId, {
        candidateId: candidate.candidateId,
        runId: run.runId,
        statement: String(candidate.statement || '').slice(0, 160),
        status: candidate.status,
        evidenceHashes: (candidate.evidence || []).map((e) => e.contentHash).filter(Boolean),
      });
    }
  }
  return byId;
}

/** Search the final normalized candidate statements, not only their source
 * observations. The returned conflicts are advisory and never auto-resolve. */
async function searchCandidateDuplicates(candidates, { ragClient } = {}) {
  const client = ragClient || getRagServiceClient();
  const jobs = [];
  for (const candidate of (candidates || []).slice(0, LIMITS.MAX_CANDIDATES_PER_RUN)) {
    for (const source of ['nestor-memory', 'agent-artifacts']) {
      jobs.push({ candidate, source });
    }
  }
  const settled = await Promise.allSettled(jobs.map(({ candidate, source }) =>
    client.searchSimilarChunks(String(candidate.statement).slice(0, 300), {
      topK: 2,
      minScore: RAG_MIN_SCORE,
      filters: { source },
      timeoutMs: RAG_SEARCH_TIMEOUT_MS,
    }).then((results) => ({ candidate, source, results }))));
  const byId = new Map();
  let failures = 0;
  for (const outcome of settled) {
    if (outcome.status === 'rejected') {
      failures += 1;
      continue;
    }
    const { candidate, source, results } = outcome.value;
    const conflicts = byId.get(candidate.candidateId) || [];
    for (const hit of (results || []).filter((item) => Number(item?.score) >= DUPLICATE_SCORE)) {
      conflicts.push({
        authority: 'rag',
        sourceRef: hit?.metadata?.documentId || source,
        summary: `existing ${source} document scores ${Math.round(Number(hit.score) * 1000) / 1000} against the final candidate statement`,
      });
    }
    byId.set(candidate.candidateId, conflicts.slice(0, 4));
  }
  return { byId, degraded: failures > 0, failures, attempted: jobs.length };
}

/** Mark candidates that look like existing memory (high-score RAG match). */
function duplicateConflictsFor(candidate, ragMatches) {
  const evidenceIds = new Set((candidate.evidence || []).map((e) => e.observationId));
  return (ragMatches || [])
    .filter((m) => m.score >= DUPLICATE_SCORE && evidenceIds.has(m.observationId))
    .slice(0, 3)
    .map((m) => ({
      authority: 'rag',
      sourceRef: m.documentId || m.source,
      summary: `existing ${m.source} document scores ${m.score} against cited evidence`,
    }));
}

module.exports = {
  buildRagDedupContext,
  loadPriorCandidates,
  loadPriorCandidatesByIds,
  searchCandidateDuplicates,
  duplicateConflictsFor,
  RAG_SEARCH_TIMEOUT_MS,
};
