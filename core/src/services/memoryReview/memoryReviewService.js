// memoryReview/memoryReviewService.js — run lifecycle for the Ecosystem
// Memory Review capability.
//
// Invariants enforced here:
// - idempotent everywhere: reopening a runKey returns the open run; observation
//   batches dedup by content hash; candidate submission upserts by candidateId.
// - raw transcripts are structurally refused (policy + guard at the edge).
// - the deterministic pass (finalize) runs before any model sees anything, and
//   a run with zero eligible observations completes WITHOUT a model call.
// - every state change appends an audit record.
// - semantic writes still live only in applyService. This lifecycle may ask it
//   to apply a Core-policy-authorized reversible write when both standing-
//   policy gates are enabled; all exceptions keep the manual four-gate path.

const MemoryReviewRun = require('../../../models/MemoryReviewRun');
const policy = require('./policy');
const contentGuard = require('./contentGuard');
const dedupService = require('./dedupService');
const { defaultPlanningTimeZone } = require('../planningDateService');

const { MemoryReviewError, LIMITS } = policy;

function audit(run, event, { by = 'system', level = 'info', candidateId = null, detail = '' } = {}) {
  run.audit.push({ at: new Date(), event, by, level, candidateId, detail: String(detail).slice(0, 1000) });
  if (run.audit.length > LIMITS.MAX_AUDIT_ENTRIES) {
    run.audit = run.audit.slice(run.audit.length - LIMITS.MAX_AUDIT_ENTRIES);
  }
}

async function getRunOrThrow(runId) {
  const run = await MemoryReviewRun.findOne({ runId });
  if (!run) throw new MemoryReviewError(`run ${runId} not found`, { status: 404, code: 'MEMORY_REVIEW_RUN_NOT_FOUND' });
  return run;
}

// ---------------------------------------------------------------- lifecycle --

const RUN_INPUT_KEYS = ['runKey', 'mode', 'window', 'collectorVersion', 'promptVersion', 'model'];

async function openRun(input = {}) {
  policy.assertKnownKeys(input, RUN_INPUT_KEYS, 'run');
  const runKey = policy.cleanRunKey(input.runKey);
  if (!runKey) throw new MemoryReviewError('runKey is required');
  const mode = ['shadow', 'review'].includes(input.mode) ? input.mode : 'shadow';

  const open = await MemoryReviewRun.findOne({
    runKey,
    status: { $in: ['collecting', 'synthesizing', 'ready_for_review', 'partially_reviewed'] },
  });
  if (open) return open; // idempotent reopen

  const priorCount = await MemoryReviewRun.countDocuments({ runKey });
  const runId = priorCount === 0 ? runKey : `${runKey}-r${priorCount + 1}`;
  const run = new MemoryReviewRun({
    runId,
    runKey,
    mode,
    status: 'collecting',
    window: {
      from: String(input.window?.from || '').slice(0, 40) || null,
      to: String(input.window?.to || '').slice(0, 40) || null,
      timezone: String(input.window?.timezone || defaultPlanningTimeZone()).slice(0, 64),
    },
    collectorVersion: String(input.collectorVersion || '').slice(0, 80),
    promptVersion: String(input.promptVersion || '').slice(0, 80),
    model: {
      provider: String(input.model?.provider || 'agentx-inference').slice(0, 64),
      model: String(input.model?.model || '').slice(0, 128),
      temperature: Number(input.model?.temperature) || 0,
    },
  });
  audit(run, 'run_opened', { detail: `mode=${mode} key=${runKey}` });
  await run.save();
  return run;
}

// ------------------------------------------------------------- observations --

const COLLECTOR_KEYS = [
  'runtime', 'host', 'agentOrProfile', 'project', 'watermarkBefore', 'watermarkAfter',
  'sourceFilesSeen', 'sourceEventsSeen', 'eligibleObservations', 'rejectedObservations',
  'rejectionCounts', 'errors', 'drift', 'localDedupContext',
];

function normalizeCollector(input) {
  policy.assertKnownKeys(input, COLLECTOR_KEYS, 'collector');
  if (!policy.RUNTIMES.includes(input.runtime)) {
    throw new MemoryReviewError('collector.runtime invalid');
  }
  return {
    runtime: input.runtime,
    host: String(input.host || 'unknown-host').slice(0, 64),
    agentOrProfile: input.agentOrProfile ? String(input.agentOrProfile).slice(0, 64) : null,
    project: input.project ? String(input.project).slice(0, 128) : null,
    watermarkBefore: String(input.watermarkBefore || '').slice(0, 200),
    watermarkAfter: String(input.watermarkAfter || '').slice(0, 200),
    sourceFilesSeen: Number(input.sourceFilesSeen) || 0,
    sourceEventsSeen: Number(input.sourceEventsSeen) || 0,
    eligibleObservations: Number(input.eligibleObservations) || 0,
    rejectedObservations: Number(input.rejectedObservations) || 0,
    rejectionCounts: (input.rejectionCounts && typeof input.rejectionCounts === 'object') ? input.rejectionCounts : {},
    errors: (Array.isArray(input.errors) ? input.errors : []).map((e) => contentGuard.redact(String(e)).slice(0, 300)).slice(0, 20),
    drift: (Array.isArray(input.drift) ? input.drift : []).map((d) => String(d).slice(0, 300)).slice(0, 10),
    localDedupContext: (Array.isArray(input.localDedupContext) ? input.localDedupContext : [])
      .map((c) => String(c))
      .filter((c) => /^sha256:[a-f0-9]{64}$/.test(c))
      .slice(0, LIMITS.MAX_DEDUP_CONTEXT_LINES),
    submittedAt: new Date(),
  };
}

async function submitObservations(runId, collectorInput, observationsInput, { submittedBy = 'system' } = {}) {
  const run = await getRunOrThrow(runId);
  if (run.status !== 'collecting') {
    throw new MemoryReviewError(`run ${runId} is ${run.status}; observations are only accepted while collecting`, {
      status: 409, code: 'MEMORY_REVIEW_WRONG_STATE',
    });
  }
  if (!Array.isArray(observationsInput)) {
    throw new MemoryReviewError('observations must be an array');
  }
  if (observationsInput.length > LIMITS.MAX_OBSERVATIONS_PER_BATCH) {
    throw new MemoryReviewError(`batch exceeds ${LIMITS.MAX_OBSERVATIONS_PER_BATCH} observations`, {
      code: 'MEMORY_REVIEW_BATCH_TOO_LARGE',
    });
  }
  const collector = normalizeCollector(collectorInput || {});
  collector.submittedBy = String(submittedBy || 'system').slice(0, 64);

  const byHash = new Map(run.observations.map((obs) => [obs.contentHash, obs]));
  let accepted = 0;
  let duplicates = 0;
  const rejected = [];

  observationsInput.forEach((raw, index) => {
    let clean;
    try {
      clean = policy.validateObservation(raw, index);
      contentGuard.assertReviewSafe(clean.text, `observations[${index}].text`);
    } catch (err) {
      rejected.push({ index, code: err.code || 'MEMORY_REVIEW_ERROR', message: contentGuard.redact(String(err.message)).slice(0, 200) });
      return;
    }
    const existing = byHash.get(clean.contentHash);
    if (existing) {
      duplicates += 1;
      const rec = existing.recurrence;
      const sameEvent = existing.sessionId === clean.sessionId && existing.eventId === clean.eventId
        && existing.runtime === clean.runtime;
      if (!sameEvent) rec.observationCount += 1; // resubmission of the same event is idempotent, not recurrence
      if (clean.sessionId && !rec.sessions.includes(clean.sessionId) && rec.sessions.length < 40) {
        rec.sessions.push(clean.sessionId);
      }
      if (!rec.runtimes.includes(clean.runtime)) rec.runtimes.push(clean.runtime);
      return;
    }
    if (run.observations.length >= LIMITS.MAX_OBSERVATIONS_PER_RUN) {
      rejected.push({ index, code: 'MEMORY_REVIEW_RUN_FULL', message: `run holds ${LIMITS.MAX_OBSERVATIONS_PER_RUN} observations` });
      return;
    }
    const observation = {
      observationId: `obs-${clean.contentHash.slice(0, 16)}`,
      ...clean,
      recurrence: {
        observationCount: 1,
        sessions: clean.sessionId ? [clean.sessionId] : [],
        runtimes: [clean.runtime],
      },
    };
    run.observations.push(observation);
    byHash.set(clean.contentHash, run.observations[run.observations.length - 1]);
    accepted += 1;
  });

  const idx = run.collectors.findIndex((c) => c.runtime === collector.runtime
    && c.host === collector.host && c.agentOrProfile === collector.agentOrProfile);
  if (idx >= 0) run.collectors[idx] = collector; else run.collectors.push(collector);

  audit(run, 'observations_submitted', {
    by: collector.submittedBy,
    detail: `${collector.runtime}@${collector.host}: accepted=${accepted} duplicates=${duplicates} rejected=${rejected.length}`,
    level: rejected.length ? 'warn' : 'info',
  });
  await run.save();
  return { runId, accepted, duplicates, rejected, totalObservations: run.observations.length };
}

// ----------------------------------------------------------------- finalize --

async function finalizeCollection(runId, { ragClient } = {}) {
  const run = await getRunOrThrow(runId);
  if (run.status === 'synthesizing') return run; // idempotent re-finalize
  if (run.status !== 'collecting') {
    throw new MemoryReviewError(`run ${runId} is ${run.status}; cannot finalize`, {
      status: 409, code: 'MEMORY_REVIEW_WRONG_STATE',
    });
  }

  if (!run.observations.length) {
    run.status = 'completed';
    run.completedAt = new Date();
    run.summary = { ...(run.summary || {}), noEligibleObservations: true, modelCalled: false };
    audit(run, 'run_completed_empty', { detail: 'no eligible observations; model not called' });
    await run.save();
    return run;
  }

  const [ragContext, priorContext] = await Promise.all([
    dedupService.buildRagDedupContext(run.observations, { ragClient })
      .catch((err) => ({ ragMatches: [], degraded: true, degradedReason: String(err.message).slice(0, 200) })),
    dedupService.loadPriorCandidates(run.runId)
      .catch(() => ({ priors: [], byId: new Map() })),
  ]);

  run.dedupContext = {
    ragMatches: ragContext.ragMatches,
    priorCandidates: priorContext.priors,
    degraded: !!ragContext.degraded,
    degradedReason: ragContext.degradedReason || null,
  };
  run.status = 'synthesizing';
  audit(run, 'collection_finalized', {
    detail: `observations=${run.observations.length} ragMatches=${ragContext.ragMatches.length}`
      + (ragContext.degraded ? ' RAG-DEDUP-DEGRADED' : ''),
    level: ragContext.degraded ? 'warn' : 'info',
  });
  await run.save();
  return run;
}

function buildSynthesisInput(run) {
  if (run.status !== 'synthesizing') {
    throw new MemoryReviewError(`run ${run.runId} is ${run.status}; synthesis input is available while synthesizing`, {
      status: 409, code: 'MEMORY_REVIEW_WRONG_STATE',
    });
  }
  return {
    runId: run.runId,
    observations: run.observations.map((obs) => ({
      id: obs.observationId,
      runtime: obs.runtime,
      project: obs.project,
      trust: obs.trust,
      taints: obs.taints,
      observedAt: obs.observedAt,
      recurrence: obs.recurrence?.observationCount || 1,
      text: obs.text,
    })),
    dedupContext: {
      ragMatches: (run.dedupContext?.ragMatches || []).map((m) => ({
        observationId: m.observationId, source: m.source, documentId: m.documentId, score: m.score, gist: m.gist,
      })),
      priorCandidates: (run.dedupContext?.priorCandidates || []).map((p) => ({
        statement: p.statement, status: p.status,
      })),
      degraded: !!run.dedupContext?.degraded,
    },
    limits: { maxCandidates: LIMITS.MAX_CANDIDATES_PER_RUN, statementMax: LIMITS.STATEMENT_MAX },
    policy: {
      version: policy.POLICY_VERSION,
      scopes: policy.MEMORY_SCOPES,
      sensitivities: policy.SENSITIVITY_LEVELS,
      impacts: policy.IMPACT_LEVELS,
      stabilities: policy.STABILITY_LEVELS,
      exceptionBudget: policy.reviewExceptionBudget(),
    },
  };
}

// --------------------------------------------------------------- candidates --

function riskFor(candidate) {
  const governance = (candidate.type === 'governed_source_change' || candidate.target.kind === 'git_change')
    ? 'high' : (candidate.target.kind === 'skill_draft' ? 'medium' : 'none');
  return {
    secret: false, // secret-bearing candidates are refused outright, never stored
    privacy: candidate.sensitivity === 'highly_private'
      ? 'high' : (candidate.sensitivity === 'private' || candidate.type === 'session_summary' ? 'low' : 'none'),
    promptInjection: false,
    governance,
    staleness: candidate.type === 'stale_memory' ? 'high' : 'none',
  };
}

function temporalFor(candidate) {
  const validFrom = candidate.validFrom ? new Date(candidate.validFrom) : null;
  const validTo = candidate.validTo ? new Date(candidate.validTo) : null;
  const expiresAt = candidate.stability === 'transient'
    ? (validTo || new Date(Date.now() + 45 * 24 * 60 * 60 * 1000))
    : null;
  return { validFrom, validTo, expiresAt };
}

function configureAutomation(run) {
  const mode = policy.automationMode();
  const safeWritesEnabled = mode === 'safe' && policy.serverMode() === 'apply';
  const exceptionBudget = policy.reviewExceptionBudget();
  let reviewExceptions = 0;
  const counts = { autoApply: 0, softStore: 0, review: 0, ignored: 0, parked: 0, shadowed: 0 };

  run.candidates.forEach((candidate) => {
    const decision = policy.automationDecision(candidate);
    candidate.automation = {
      policyVersion: policy.POLICY_VERSION,
      disposition: decision.disposition,
      evidenceClass: decision.evidenceClass,
      reason: decision.reason,
      evaluatedAt: new Date(),
      mode,
    };
    if (mode === 'off') {
      counts.review += 1;
      return;
    }
    if (decision.disposition === 'ignore') {
      candidate.status = 'rejected';
      candidate.review = {
        by: policy.POLICY_VERSION,
        at: new Date(),
        note: `Automatically ignored: ${decision.reason}`,
      };
      counts.ignored += 1;
      return;
    }
    if (decision.disposition === 'review') {
      if (reviewExceptions < exceptionBudget) {
        candidate.status = 'proposed';
        reviewExceptions += 1;
        counts.review += 1;
      } else {
        candidate.status = 'parked';
        candidate.automation.reason = `${decision.reason}; exception-budget-exceeded`;
        counts.parked += 1;
      }
      return;
    }
    if (safeWritesEnabled) {
      candidate.status = 'auto_approved';
      if (decision.disposition === 'soft_store') counts.softStore += 1;
      else counts.autoApply += 1;
    } else {
      candidate.status = 'shadowed';
      counts.shadowed += 1;
    }
  });
  return { mode, safeWritesEnabled, exceptionBudget, counts };
}

function scoreFor(candidate, recurrence) {
  // Transparent ordering score (documented in the design doc): recurrence and
  // runtime diversity dominate, confidence breaks ties. Ordering only — a
  // score never authorizes application.
  return Math.round((
    Math.min(recurrence.observationCount, 5) * 2
    + Math.min(recurrence.independentSessions, 3) * 3
    + Math.min(recurrence.independentRuntimes, 2) * 4
    + Number(candidate.confidence || 0) * 5
  ) * 100) / 100;
}

async function submitCandidates(runId, candidatesInput, { promptVersion, model } = {}) {
  const run = await getRunOrThrow(runId);
  if (run.status !== 'synthesizing') {
    throw new MemoryReviewError(`run ${runId} is ${run.status}; candidates are only accepted while synthesizing`, {
      status: 409, code: 'MEMORY_REVIEW_WRONG_STATE',
    });
  }
  if (!Array.isArray(candidatesInput)) throw new MemoryReviewError('candidates must be an array');
  if (candidatesInput.length > LIMITS.MAX_CANDIDATES_PER_RUN) {
    throw new MemoryReviewError(`too many candidates (max ${LIMITS.MAX_CANDIDATES_PER_RUN})`);
  }

  const observationsById = new Map(run.observations.map((obs) => [obs.observationId, obs]));
  const knownIds = new Set(observationsById.keys());

  let accepted = 0;
  let suppressed = 0;
  const dropped = [];
  const validated = [];

  candidatesInput.forEach((raw, index) => {
    try {
      const clean = policy.validateCandidateInput(raw, index, knownIds);
      contentGuard.assertReviewSafe(`${clean.statement}\n${clean.rationale}`, `candidates[${index}]`);
      validated.push({ clean, index, candidateId: policy.candidateId(clean.type, clean.statement) });
    } catch (err) {
      dropped.push({ index, code: err.code || 'MEMORY_REVIEW_ERROR', message: contentGuard.redact(String(err.message)).slice(0, 200) });
      audit(run, 'candidate_dropped', { level: 'warn', detail: `index=${index} ${err.code || ''}` });
    }
  });
  const priorById = await dedupService.loadPriorCandidatesByIds(
    validated.map((item) => item.candidateId),
    run.runId
  ).catch(() => new Map());
  const candidateRag = await dedupService.searchCandidateDuplicates(
    validated.map(({ clean, candidateId }) => ({ statement: clean.statement, candidateId }))
  ).catch(() => ({ byId: new Map(), degraded: true, failures: 1, attempted: 1 }));
  if (candidateRag.degraded) {
    run.dedupContext.degraded = true;
    run.dedupContext.degradedReason = [
      run.dedupContext.degradedReason,
      `candidate RAG dedup incomplete (${candidateRag.failures}/${candidateRag.attempted})`,
    ].filter(Boolean).join('; ').slice(0, 400);
    audit(run, 'candidate_dedup_degraded', { level: 'warn', detail: run.dedupContext.degradedReason });
  }

  validated.forEach(({ clean, candidateId }) => {
    const evidence = clean.evidenceRefs.map((ref) => {
      const obs = observationsById.get(ref);
      return {
        observationId: ref,
        runtime: obs.runtime,
        host: obs.host,
        agentOrProfile: obs.agentOrProfile,
        project: obs.project,
        sessionId: obs.sessionId,
        eventId: obs.eventId,
        observedAt: obs.observedAt,
        trust: obs.trust,
        sourceRef: obs.sourceRef,
        contentHash: obs.contentHash,
        redactedExcerpt: contentGuard.redact(obs.text).slice(0, LIMITS.EXCERPT_MAX),
      };
    });
    const evidenceHashes = evidence.map((e) => e.contentHash);

    // Prior-disposition policy: a rejection stands until materially new
    // evidence appears; applied candidates are never re-proposed.
    const prior = priorById.get(candidateId);
    if (prior) {
      if (prior.status === 'rejected') {
        const priorHashes = new Set(prior.evidenceHashes || []);
        const hasNewEvidence = evidenceHashes.some((h) => !priorHashes.has(h));
        if (!hasNewEvidence) {
          suppressed += 1;
          audit(run, 'candidate_suppressed', { candidateId, detail: `previously rejected in ${prior.runId}, no new evidence` });
          return;
        }
        clean.conflicts.push({
          authority: 'prior_review',
          sourceRef: prior.runId,
          summary: 'previously rejected; re-proposed because materially new evidence exists',
        });
      } else if (prior.status === 'applied') {
        suppressed += 1;
        audit(run, 'candidate_suppressed', { candidateId, detail: `already applied in ${prior.runId}` });
        return;
      } else if (prior.status === 'deferred') {
        clean.conflicts.push({
          authority: 'prior_review',
          sourceRef: prior.runId,
          summary: 'deferred in a previous run; recurrence is accumulating',
        });
      }
    }

    const sessions = new Set();
    const runtimes = new Set();
    let observationCount = 0;
    for (const ref of clean.evidenceRefs) {
      const obs = observationsById.get(ref);
      observationCount += obs.recurrence?.observationCount || 1;
      (obs.recurrence?.sessions || []).forEach((s) => sessions.add(s));
      (obs.recurrence?.runtimes || []).forEach((r) => runtimes.add(r));
    }
    const recurrence = {
      observationCount,
      independentSessions: sessions.size,
      independentRuntimes: runtimes.size,
    };

    const conflicts = [
      ...clean.conflicts,
      ...dedupService.duplicateConflictsFor({ evidence }, run.dedupContext?.ragMatches),
      ...(candidateRag.byId.get(candidateId) || []),
    ].slice(0, 8);

    const existingIndex = run.candidates.findIndex((c) => c.candidateId === candidateId);
    const candidateDoc = {
      candidateId,
      type: clean.type,
      statement: clean.statement,
      rationale: clean.rationale,
      target: clean.target,
      evidence,
      recurrence,
      confidence: clean.confidence,
      score: 0,
      memoryKey: clean.memoryKey || `${clean.scope}:${clean.target.topic || clean.type}:${candidateId.slice(0, 12)}`,
      scope: clean.scope,
      sensitivity: clean.sensitivity,
      impact: clean.impact,
      stability: clean.stability,
      temporal: temporalFor(clean),
      conflicts,
      risk: riskFor(clean),
      status: 'proposed',
      review: {}, apply: {},
    };
    candidateDoc.score = scoreFor(clean, recurrence);
    if (existingIndex >= 0) {
      const existing = run.candidates[existingIndex];
      if (existing.status !== 'proposed') return; // reviewed candidates are immutable to resubmission
      run.candidates[existingIndex] = candidateDoc; // idempotent upsert
    } else {
      run.candidates.push(candidateDoc);
    }
    accepted += 1;
  });

  if (promptVersion) run.promptVersion = String(promptVersion).slice(0, 80);
  if (model && typeof model === 'object') {
    run.model = {
      provider: String(model.provider || run.model.provider).slice(0, 64),
      model: String(model.model || run.model.model).slice(0, 128),
      temperature: Number(model.temperature) || 0,
    };
  }
  run.candidates.sort((a, b) => (b.score || 0) - (a.score || 0));
  const automation = configureAutomation(run);
  run.candidateCounts = run.candidates.reduce((acc, c) => {
    acc[c.type] = (acc[c.type] || 0) + 1;
    return acc;
  }, {});
  const pending = run.candidates.filter((candidate) => ['proposed', 'deferred'].includes(candidate.status)).length;
  const autoReady = run.candidates.filter((candidate) => candidate.status === 'auto_approved').length;
  run.status = pending || autoReady ? 'ready_for_review' : 'completed';
  if (run.status === 'completed') run.completedAt = new Date();
  run.summary = {
    ...(run.summary || {}),
    modelCalled: true,
    candidateCount: run.candidates.length,
    automation: {
      policyVersion: policy.POLICY_VERSION,
      mode: automation.mode,
      safeWritesEnabled: automation.safeWritesEnabled,
      exceptionBudget: automation.exceptionBudget,
      ...automation.counts,
    },
  };
  audit(run, 'candidates_submitted', {
    detail: `accepted=${accepted} suppressed=${suppressed} dropped=${dropped.length} total=${run.candidates.length}`,
  });
  await run.save();
  const automationFailures = [];
  if (automation.safeWritesEnabled) {
    const applyService = require('./applyService'); // lazy: keep lifecycle/apply modules acyclic at load time
    const autoCandidates = run.candidates.filter((candidate) => candidate.status === 'auto_approved');
    for (const candidate of autoCandidates) {
      try {
        await applyService.applyCandidate(runId, candidate.candidateId, {
          by: policy.POLICY_VERSION,
          automation: true,
        });
      } catch (err) {
        automationFailures.push({
          candidateId: candidate.candidateId,
          code: err.code || 'MEMORY_REVIEW_AUTO_APPLY_FAILED',
          message: contentGuard.redact(String(err.message)).slice(0, 200),
        });
      }
    }
  }
  const finalized = await getRunOrThrow(runId);
  refreshRunReviewStatus(finalized);
  finalized.summary = {
    ...(finalized.summary || {}),
    automationFailures: automationFailures.length,
  };
  await finalized.save();
  return {
    runId,
    status: finalized.status,
    accepted,
    suppressed,
    dropped,
    total: finalized.candidates.length,
    automation: finalized.summary.automation,
    automationFailures,
  };
}

// ------------------------------------------------------------------- review --

function refreshRunReviewStatus(run) {
  if (!run.candidates.length) return;
  const pending = run.candidates.filter((c) => ['proposed', 'deferred', 'auto_approved', 'applying', 'apply_failed'].includes(c.status)).length;
  if (pending === 0) {
    run.status = 'completed';
    run.completedAt = run.completedAt || new Date();
  } else if (pending < run.candidates.length) {
    run.status = 'partially_reviewed';
    run.completedAt = null;
  } else {
    run.status = 'ready_for_review';
    run.completedAt = null;
  }
}

async function reviewCandidate(runId, candidateId, input = {}) {
  policy.assertKnownKeys(input, ['action', 'by', 'note', 'editedStatement', 'editedTarget'], 'review');
  const { action } = input;
  if (!policy.REVIEW_ACTIONS.includes(action)) {
    throw new MemoryReviewError(`action must be one of ${policy.REVIEW_ACTIONS.join(', ')}`);
  }
  const by = String(input.by || '').trim().slice(0, 64);
  if (!by) throw new MemoryReviewError('review.by (reviewer identity) is required');

  const current = await MemoryReviewRun.findOne(
    { runId, 'candidates.candidateId': candidateId },
    { candidates: { $elemMatch: { candidateId } } }
  ).lean();
  const candidate = current?.candidates?.[0];
  if (!candidate) {
    throw new MemoryReviewError(`candidate ${candidateId} not found in ${runId}`, { status: 404, code: 'MEMORY_REVIEW_CANDIDATE_NOT_FOUND' });
  }
  if (!['proposed', 'deferred'].includes(candidate.status)) {
    throw new MemoryReviewError(`candidate is ${candidate.status}; review transitions start from proposed/deferred`, {
      status: 409, code: 'MEMORY_REVIEW_WRONG_STATE',
    });
  }

  const set = {};
  if (action === 'edit_approve') {
    const edited = policy.normalizeText(input.editedStatement);
    if (!edited) throw new MemoryReviewError('edit_approve requires editedStatement');
    if (edited.length > LIMITS.STATEMENT_MAX) throw new MemoryReviewError(`editedStatement exceeds ${LIMITS.STATEMENT_MAX} chars`);
    contentGuard.assertReviewSafe(edited, 'editedStatement');
    set['candidates.$[candidate].review.editedStatement'] = edited;
    if (input.editedTarget && typeof input.editedTarget === 'object') {
      policy.assertKnownKeys(input.editedTarget, ['kind', 'runtime', 'topic'], 'editedTarget');
      const editedTarget = {
        kind: input.editedTarget.kind || candidate.target.kind,
        runtime: input.editedTarget.runtime === undefined
          ? (candidate.target.runtime || null) : (input.editedTarget.runtime || null),
        topic: input.editedTarget.topic === undefined
          ? (candidate.target.topic || null)
          : (policy.normalizeText(input.editedTarget.topic).slice(0, 64) || null),
      };
      policy.validateTargetForType(candidate.type, editedTarget, 'editedTarget');
      set['candidates.$[candidate].review.editedTarget'] = editedTarget;
    } else {
      policy.validateTargetForType(candidate.type, candidate.target, 'candidate.target');
    }
    set['candidates.$[candidate].status'] = 'approved';
  } else if (action === 'approve') {
    policy.validateTargetForType(candidate.type, candidate.target, 'candidate.target');
    set['candidates.$[candidate].status'] = 'approved';
  } else if (action === 'reject') {
    set['candidates.$[candidate].status'] = 'rejected';
  } else if (action === 'defer') {
    set['candidates.$[candidate].status'] = 'deferred';
  }
  const note = input.note ? String(input.note).slice(0, 1000) : null;
  if (note) contentGuard.assertReviewSafe(note, 'review.note');
  const reviewedAt = new Date();
  set['candidates.$[candidate].review.by'] = by;
  set['candidates.$[candidate].review.at'] = reviewedAt;
  set['candidates.$[candidate].review.note'] = note;

  const run = await MemoryReviewRun.findOneAndUpdate(
    {
      runId,
      candidates: {
        $elemMatch: { candidateId, status: { $in: ['proposed', 'deferred'] } },
      },
    },
    {
      $set: set,
      $push: {
        audit: {
          $each: [{ at: reviewedAt, event: `candidate_${action}`, by, level: 'info', candidateId, detail: '' }],
          $slice: -LIMITS.MAX_AUDIT_ENTRIES,
        },
      },
    },
    { new: true, runValidators: true, arrayFilters: [{ 'candidate.candidateId': candidateId }] }
  );
  if (!run) {
    throw new MemoryReviewError('candidate review state changed; reload before retrying', {
      status: 409, code: 'MEMORY_REVIEW_WRONG_STATE',
    });
  }
  refreshRunReviewStatus(run);
  await MemoryReviewRun.updateOne(
    { runId },
    { $set: { status: run.status, completedAt: run.completedAt || null } }
  );
  const reviewed = run.candidates.find((item) => item.candidateId === candidateId);
  return reviewed?.toObject ? reviewed.toObject() : reviewed;
}

async function authorizeApplyRun(runId, { by } = {}) {
  if (policy.serverMode() !== 'apply') {
    throw new MemoryReviewError('run apply authorization requires MEMORY_REVIEW_MODE=apply', {
      status: 403, code: 'MEMORY_REVIEW_APPLY_DISABLED',
    });
  }
  const actor = String(by || '').trim().slice(0, 64);
  if (!actor) throw new MemoryReviewError('apply authorization requires operator identity');
  const existing = await getRunOrThrow(runId);
  if (existing.mode === 'apply' && existing.applyAuthorization?.at) return existing;
  if (existing.status === 'failed' || !existing.candidates.some((c) => ['approved', 'apply_failed'].includes(c.status))) {
    throw new MemoryReviewError('run must contain an approved candidate before apply authorization', {
      status: 409, code: 'MEMORY_REVIEW_NOT_APPROVED',
    });
  }
  const at = new Date();
  const run = await MemoryReviewRun.findOneAndUpdate(
    { runId, mode: { $in: ['shadow', 'review'] }, 'applyAuthorization.at': null },
    {
      $set: { mode: 'apply', applyAuthorization: { by: actor, at } },
      $push: {
        audit: {
          $each: [{ at, event: 'run_apply_authorized', by: actor, level: 'warn', detail: '' }],
          $slice: -LIMITS.MAX_AUDIT_ENTRIES,
        },
      },
    },
    { new: true, runValidators: true }
  );
  if (!run) {
    throw new MemoryReviewError('run apply authorization state changed; reload before retrying', {
      status: 409, code: 'MEMORY_REVIEW_WRONG_STATE',
    });
  }
  return run;
}

async function failRun(runId, { stage, reason } = {}) {
  const run = await getRunOrThrow(runId);
  if (['completed'].includes(run.status)) {
    throw new MemoryReviewError(`run ${runId} already completed`, { status: 409, code: 'MEMORY_REVIEW_WRONG_STATE' });
  }
  run.status = 'failed';
  run.failure = {
    stage: String(stage || 'unknown').slice(0, 40),
    reason: contentGuard.redact(String(reason || '')).slice(0, 600),
    retryable: true,
  };
  audit(run, 'run_failed', { level: 'error', detail: `${run.failure.stage}: ${run.failure.reason}`.slice(0, 400) });
  await run.save();
  return run;
}

// -------------------------------------------------------------------- reads --

async function listRuns({ limit = 20, status } = {}) {
  const bounded = Math.min(Math.max(Math.trunc(Number(limit) || 20), 1), 100);
  const query = status ? { status } : {};
  const runs = await MemoryReviewRun.find(query, {
    runId: 1, runKey: 1, mode: 1, status: 1, window: 1, createdAt: 1, completedAt: 1,
    candidateCounts: 1, summary: 1, failure: 1, collectorVersion: 1,
    'candidates.status': 1,
    'collectors.runtime': 1, 'collectors.errors': 1, 'collectors.drift': 1,
  }).sort({ createdAt: -1 }).limit(bounded).lean();
  runs.forEach((run) => {
    const candidates = run.candidates || [];
    run.reviewCounts = candidates.reduce((counts, candidate) => {
      counts[candidate.status] = (counts[candidate.status] || 0) + 1;
      return counts;
    }, {});
    const collectors = run.collectors || [];
    run.collectorSummary = {
      runtimes: [...new Set(collectors.map((collector) => collector.runtime).filter(Boolean))],
      errors: collectors.reduce((total, collector) => total + (collector.errors || []).length, 0),
      drift: collectors.reduce((total, collector) => total + (collector.drift || []).length, 0),
    };
    run.reconciliation = policy.reconciliationStatus(run);
    delete run.candidates;
    delete run.collectors;
  });
  return { runs, limit: bounded };
}

async function getRunDetail(runId, { includeObservations = false } = {}) {
  const run = await getRunOrThrow(runId);
  const doc = run.toObject();
  doc.reconciliation = policy.reconciliationStatus(doc);
  if (!includeObservations) delete doc.observations;
  return doc;
}

async function buildDigest({ includeStatements = true } = {}) {
  const [actionable, completed, active] = await Promise.all([
    MemoryReviewRun.findOne({ status: { $in: ['ready_for_review', 'partially_reviewed'] } })
      .sort({ createdAt: -1 }).lean(),
    MemoryReviewRun.findOne({ status: 'completed' }).sort({ createdAt: -1 }).lean(),
    MemoryReviewRun.findOne({ status: { $in: ['collecting', 'synthesizing'] } })
      .sort({ createdAt: -1 }).lean(),
  ]);
  const target = actionable || completed || active;
  if (!target) return { text: 'Memory review: no runs recorded yet.', runId: null, pending: 0 };

  const candidates = target.candidates || [];
  const pending = candidates.filter((c) => ['proposed', 'deferred', 'apply_failed'].includes(c.status));
  const applied = candidates.filter((c) => c.status === 'applied');
  const autoApplied = applied.filter((c) => c.apply?.automated);
  const softStored = autoApplied.filter((c) => c.target?.kind === 'soft_memory');
  const shadowed = candidates.filter((c) => c.status === 'shadowed');
  const parked = candidates.filter((c) => c.status === 'parked');
  const reconciliation = active ? policy.reconciliationStatus(active) : null;
  const lines = [
    `Memory review ${target.runId} (${target.status}): ${autoApplied.length} auto-applied (${softStored.length} soft), ${pending.length} exception(s) awaiting review.`,
  ];
  if (reconciliation?.overdue) {
    const missing = reconciliation.missingRuntimes.length
      ? ` Waiting for ${reconciliation.missingRuntimes.join(', ')}.` : '';
    lines.push(`Attention: reconciliation ${active.runId} is overdue.${missing}`);
  }
  if (includeStatements) {
    candidates.forEach((candidate, index) => {
      if (!['proposed', 'deferred', 'apply_failed'].includes(candidate.status)) return;
      lines.push(`  ${index + 1}. [${candidate.type} / ${candidate.scope || 'project'} / ${candidate.sensitivity || 'normal'}] ${String(candidate.statement).slice(0, 140)}`);
    });
  }
  if (shadowed.length) lines.push(`${shadowed.length} safe action(s) were policy-evaluated in shadow mode; nothing was written.`);
  if (parked.length) lines.push(`${parked.length} lower-priority exception(s) were parked beyond the ${policy.reviewExceptionBudget()}-item attention budget.`);
  if (pending.length) lines.push('Only exceptions need individual review in AgentX /memory-review.');
  else lines.push('No human approval is needed for this run.');
  return {
    text: lines.join('\n'),
    runId: target.runId,
    pending: pending.length,
    total: candidates.length,
    autoApplied: autoApplied.length,
    softStored: softStored.length,
    shadowed: shadowed.length,
    parked: parked.length,
    attention: !!reconciliation?.overdue,
    activeRun: active ? {
      runId: active.runId,
      status: active.status,
      createdAt: active.createdAt,
      reconciliation,
    } : null,
  };
}

module.exports = {
  openRun, submitObservations, finalizeCollection,
  buildSynthesisInput, submitCandidates,
  reviewCandidate, authorizeApplyRun, failRun,
  listRuns, getRunDetail, buildDigest, getRunOrThrow, audit,
};
