// memoryReview/applyService.js — the ONLY code path that turns an approved
// candidate into a real write, and it is four-gated:
//   1. server mode gate: MEMORY_REVIEW_MODE must be exactly 'apply'
//      (default is shadow; a missing/typo'd env can never enable apply);
//   2. the specific run has an explicit audited apply authorization;
//   3. candidate status gate: only 'approved' (or a failed retry) applies;
//   4. adapter gate: type and target must match the server-owned allowlist.
// An atomic lease prevents concurrent adapter calls; every writable adapter
// carries a stable idempotency key for crash/lost-response retry safety.
// The content guard runs AGAIN on the final text immediately before the write.
//
// Adapter semantics:
//   shared_fact    -> nestor-memory via nestorMemoryService (its own secret
//                     guard runs a fourth time inside saveMemory)
//   artifact       -> agent-artifacts RAG lane, stable documentId upsert
//   pipeline_task  -> Mongo pipeline task (approval-gated by definition here)
//   git_change     -> pipeline task carrying an exact change proposal — never
//                     a direct edit of governed files
//   skill_draft    -> pipeline task for skill authoring — never an install
//   runtime_local  -> generates an owner-specific pending proposal payload;
//                     WRITES NOTHING anywhere (the owning runtime applies it
//                     manually until a separately-approved adapter exists)

const nestorMemoryService = require('../nestorMemoryService');
const pipelineTaskService = require('../pipelineTaskService');
const { getRagServiceClient } = require('../ragServiceClient');
const MemoryReviewRun = require('../../../models/MemoryReviewRun');
const policy = require('./policy');
const contentGuard = require('./contentGuard');

const { MemoryReviewError } = policy;
const APPLY_LEASE_MS = 5 * 60 * 1000;

function effectiveStatement(candidate) {
  return candidate.review?.editedStatement || candidate.statement;
}

function effectiveTarget(candidate) {
  const edited = candidate.review?.editedTarget;
  if (edited && edited.kind) {
    return { kind: edited.kind, runtime: edited.runtime || null, topic: edited.topic || null };
  }
  return candidate.target;
}

function evidenceSummaryLines(candidate) {
  return (candidate.evidence || []).slice(0, 6).map((e) =>
    `- ${e.runtime}@${e.host || '?'} session=${e.sessionId || '?'} trust=${e.trust} hash=${(e.contentHash || '').slice(0, 12)}`);
}

// ------------------------------------------------------------------ adapters --

async function applySharedFact(run, candidate, deps) {
  const statement = effectiveStatement(candidate);
  const target = effectiveTarget(candidate);
  const save = deps.saveMemory || nestorMemoryService.saveMemory;
  const result = await save({
    text: statement,
    type: 'fact',
    agent: 'memory-review',
    topic: target.topic || 'general',
    tags: ['memory-review', `run:${run.runId}`, `candidate:${candidate.candidateId.slice(0, 12)}`],
    id: `memory-review-${candidate.candidateId}`,
  }, deps.saveMemoryOpts || {});
  return {
    result: `nestor-memory upsert ${result.documentId}`,
    rollbackRef: `DELETE rag document ${result.documentId}`,
  };
}

async function applyArtifact(run, candidate, deps) {
  const statement = effectiveStatement(candidate);
  const target = effectiveTarget(candidate);
  const client = deps.ragClient || getRagServiceClient();
  const documentId = `artifact:memory-review:${candidate.candidateId}`;
  const text = [
    `# Memory review ${candidate.type}: ${target.topic || candidate.candidateId.slice(0, 12)}`,
    '',
    `- kind: memory-review-${candidate.type}`,
    `- run: ${run.runId}`,
    `- approved-by: ${candidate.review?.by || 'unknown'}`,
    `- date: ${new Date().toISOString().slice(0, 10)}`,
    '',
    statement,
    '',
    candidate.rationale ? `Why durable: ${candidate.rationale}` : '',
    '',
    'Evidence references (bounded, no raw transcripts):',
    ...evidenceSummaryLines(candidate),
  ].filter(Boolean).join('\n');
  contentGuard.assertReviewSafe(text, 'artifact body');
  const result = await client.upsertDocumentWithChunks(text, {
    source: 'agent-artifacts',
    documentId,
    tags: ['memory-review', `kind:${candidate.type}`, `run:${run.runId}`,
      ...(target.topic ? [`topic:${target.topic}`] : [])],
    chunkSize: 500,
    chunkOverlap: 50,
  });
  return {
    result: `agent-artifacts upsert ${documentId} (${result?.chunkCount ?? '?'} chunks)`,
    rollbackRef: `DELETE rag document ${documentId}`,
  };
}

function taskSpecFor(run, candidate, statement, headline) {
  return [
    `# ${headline}`,
    '',
    `Proposed by Ecosystem Memory Review run ${run.runId}, candidate ${candidate.candidateId}.`,
    `Approved by: ${candidate.review?.by || 'unknown'} at ${candidate.review?.at || 'unknown'}.`,
    '',
    '## Objective', statement,
    '',
    candidate.rationale ? `## Rationale\n${candidate.rationale}` : '',
    '',
    '## Evidence (bounded references, originals stay on their hosts)',
    ...evidenceSummaryLines(candidate),
    '',
    '## Constraints',
    '- This task was generated from an approved memory-review candidate; verify the claim against runtime truth before acting.',
    '- Do not modify protected governance files without Architect/human review.',
  ].filter(Boolean).join('\n');
}

async function applyPipelineTask(run, candidate, deps, { headline } = {}) {
  const statement = effectiveStatement(candidate);
  const create = deps.createTask || pipelineTaskService.createTaskInMongo;
  const title = statement.slice(0, 110);
  const created = await create({
    title,
    objective: statement,
    service: '',
    spec: taskSpecFor(run, candidate, statement, headline || 'Memory review follow-up'),
    epic: 'Memory Review',
    source: 'memory-review',
    sourceKey: `candidate:${candidate.candidateId}`,
  });
  return {
    result: `pipeline task ${created.pipelineId} created`,
    rollbackRef: `pipeline task ${created.pipelineId} (close as cancelled)`,
  };
}

function applyRuntimeLocal(run, candidate) {
  const statement = effectiveStatement(candidate);
  const target = effectiveTarget(candidate);
  const owner = target.runtime || 'unknown-runtime';
  const proposal = {
    proposalFor: owner,
    candidateId: candidate.candidateId,
    runId: run.runId,
    statement,
    rationale: candidate.rationale || null,
    suggestedHome: {
      'claude-code': 'project auto-memory (MEMORY.md + topic file) — apply via /remember or a manual edit by Claude Code itself',
      codex: 'Codex-native memory — apply inside a Codex session; NEVER by editing its SQLite directly',
      external: 'the owning runtime through its own explicit write-approval flow',
    }[owner] || 'owning runtime decides',
    note: 'Proposal only. AgentX did not and will not write this into the runtime; the owner applies it explicitly.',
  };
  return {
    result: `runtime-local proposal generated for ${owner}: ${JSON.stringify(proposal).slice(0, 1500)}`,
    rollbackRef: null,
  };
}

// ------------------------------------------------------------------ gateway --

async function applyCandidate(runId, candidateId, { by, deps = {} } = {}) {
  const mode = policy.serverMode();
  if (mode !== 'apply') {
    throw new MemoryReviewError(
      `apply is disabled: server mode is '${mode}' (set MEMORY_REVIEW_MODE=apply after operator authorization)`,
      { status: 403, code: 'MEMORY_REVIEW_APPLY_DISABLED' }
    );
  }
  const reviewer = String(by || '').trim().slice(0, 64);
  if (!reviewer) throw new MemoryReviewError('apply requires by (operator identity)');

  let run = await MemoryReviewRun.findOne({ runId });
  if (!run) {
    throw new MemoryReviewError(`run ${runId} not found`, {
      status: 404, code: 'MEMORY_REVIEW_RUN_NOT_FOUND',
    });
  }
  let candidate = run.candidates.find((c) => c.candidateId === candidateId);
  if (!candidate) {
    throw new MemoryReviewError(`candidate ${candidateId} not found in ${runId}`, {
      status: 404, code: 'MEMORY_REVIEW_CANDIDATE_NOT_FOUND',
    });
  }
  if (candidate.status === 'applied') {
    return { // idempotent: re-applying an applied candidate is a no-op
      candidateId, status: 'applied', alreadyApplied: true,
      result: candidate.apply?.result, rollbackRef: candidate.apply?.rollbackRef,
    };
  }
  if (run.mode !== 'apply' || !run.applyAuthorization?.at) {
    throw new MemoryReviewError('this run has not been explicitly authorized for apply', {
      status: 403, code: 'MEMORY_REVIEW_RUN_APPLY_DISABLED',
    });
  }
  if (!['approved', 'apply_failed'].includes(candidate.status)) {
    const leaseExpired = candidate.status === 'applying'
      && candidate.apply?.leaseUntil
      && new Date(candidate.apply.leaseUntil).getTime() <= Date.now();
    if (candidate.status === 'applying' && !leaseExpired) {
      throw new MemoryReviewError('candidate apply is already in progress', {
        status: 409, code: 'MEMORY_REVIEW_APPLY_IN_PROGRESS',
      });
    }
    if (!leaseExpired) {
      throw new MemoryReviewError(`candidate is ${candidate.status}; only approved candidates apply`, {
        status: 409, code: 'MEMORY_REVIEW_NOT_APPROVED',
      });
    }
  }
  const target = effectiveTarget(candidate);
  policy.validateTargetForType(candidate.type, target, 'apply target');
  if (!policy.APPLY_ADAPTERS.includes(target.kind)) {
    throw new MemoryReviewError(`target kind '${target.kind}' has no apply adapter`, {
      status: 400, code: 'MEMORY_REVIEW_NO_ADAPTER',
    });
  }

  // Final validation immediately before the write — statement may have been
  // edited at review time, and policy may have tightened since synthesis.
  contentGuard.assertReviewSafe(effectiveStatement(candidate), 'apply statement');

  const startedAt = new Date();
  const leaseUntil = new Date(startedAt.getTime() + APPLY_LEASE_MS);
  const attemptId = `memory-review:${runId}:${candidateId}`.slice(0, 200);
  run = await MemoryReviewRun.findOneAndUpdate(
    {
      runId,
      mode: 'apply',
      'applyAuthorization.at': { $ne: null },
      candidates: {
        $elemMatch: {
          candidateId,
          $or: [
            { status: { $in: ['approved', 'apply_failed'] } },
            { status: 'applying', 'apply.leaseUntil': { $lte: startedAt } },
          ],
        },
      },
    },
    {
      $set: {
        'candidates.$[candidate].status': 'applying',
        'candidates.$[candidate].apply.adapter': target.kind,
        'candidates.$[candidate].apply.attemptId': attemptId,
        'candidates.$[candidate].apply.by': reviewer,
        'candidates.$[candidate].apply.startedAt': startedAt,
        'candidates.$[candidate].apply.leaseUntil': leaseUntil,
        'candidates.$[candidate].apply.attemptedAt': startedAt,
        'candidates.$[candidate].apply.result': null,
      },
      $push: {
        audit: {
          $each: [{ at: startedAt, event: 'candidate_apply_started', by: reviewer, level: 'info', candidateId, detail: target.kind }],
          $slice: -policy.LIMITS.MAX_AUDIT_ENTRIES,
        },
      },
    },
    { new: true, runValidators: true, arrayFilters: [{ 'candidate.candidateId': candidateId }] }
  );
  if (!run) {
    const latest = await MemoryReviewRun.findOne({ runId }).lean();
    const latestCandidate = latest?.candidates?.find((item) => item.candidateId === candidateId);
    if (latestCandidate?.status === 'applied') {
      return {
        candidateId, status: 'applied', alreadyApplied: true,
        result: latestCandidate.apply?.result, rollbackRef: latestCandidate.apply?.rollbackRef,
      };
    }
    throw new MemoryReviewError('candidate apply state changed or is already leased', {
      status: 409, code: 'MEMORY_REVIEW_APPLY_IN_PROGRESS',
    });
  }
  candidate = run.candidates.find((item) => item.candidateId === candidateId);
  try {
    let outcome;
    if (target.kind === 'shared_fact') outcome = await applySharedFact(run, candidate, deps);
    else if (target.kind === 'artifact') outcome = await applyArtifact(run, candidate, deps);
    else if (target.kind === 'pipeline_task') outcome = await applyPipelineTask(run, candidate, deps);
    else if (target.kind === 'git_change') {
      outcome = await applyPipelineTask(run, candidate, deps, {
        headline: 'Governed source-of-truth change proposal (do not auto-edit)',
      });
    } else if (target.kind === 'skill_draft') {
      outcome = await applyPipelineTask(run, candidate, deps, {
        headline: 'Skill draft authoring proposal (never auto-installed into any runtime)',
      });
    } else if (target.kind === 'runtime_local') outcome = applyRuntimeLocal(run, candidate);

    const result = String(outcome.result).slice(0, 2000);
    const rollbackRef = outcome.rollbackRef ? String(outcome.rollbackRef).slice(0, 400) : null;
    const finishedAt = new Date();
    const finished = await MemoryReviewRun.findOneAndUpdate(
      {
        runId,
        candidates: { $elemMatch: { candidateId, status: 'applying', 'apply.attemptId': attemptId } },
      },
      {
        $set: {
          'candidates.$[candidate].status': 'applied',
          'candidates.$[candidate].apply.result': result,
          'candidates.$[candidate].apply.rollbackRef': rollbackRef,
          'candidates.$[candidate].apply.leaseUntil': null,
        },
        $push: {
          audit: {
            $each: [{ at: finishedAt, event: 'candidate_applied', by: reviewer, level: 'info', candidateId, detail: target.kind }],
            $slice: -policy.LIMITS.MAX_AUDIT_ENTRIES,
          },
        },
      },
      { new: true, runValidators: true, arrayFilters: [{ 'candidate.candidateId': candidateId }] }
    );
    if (!finished) {
      throw new Error('adapter completed but apply receipt could not be persisted; retry after lease expiry');
    }
    candidate = finished.candidates.find((item) => item.candidateId === candidateId);
  } catch (err) {
    const failedAt = new Date();
    const failure = contentGuard.redact(`FAILED: ${err.message}`).slice(0, 2000);
    await MemoryReviewRun.findOneAndUpdate(
      {
        runId,
        candidates: { $elemMatch: { candidateId, status: 'applying', 'apply.attemptId': attemptId } },
      },
      {
        $set: {
          'candidates.$[candidate].status': 'apply_failed',
          'candidates.$[candidate].apply.result': failure,
          'candidates.$[candidate].apply.leaseUntil': null,
        },
        $push: {
          audit: {
            $each: [{ at: failedAt, event: 'candidate_apply_failed', by: reviewer, level: 'error', candidateId, detail: target.kind }],
            $slice: -policy.LIMITS.MAX_AUDIT_ENTRIES,
          },
        },
      },
      { new: true, runValidators: true, arrayFilters: [{ 'candidate.candidateId': candidateId }] }
    );
    throw new MemoryReviewError(`apply failed (${target.kind}): ${contentGuard.redact(String(err.message))}`, {
      status: 502, code: 'MEMORY_REVIEW_APPLY_FAILED',
    });
  }
  return {
    candidateId,
    status: candidate.status,
    adapter: target.kind,
    result: candidate.apply.result,
    rollbackRef: candidate.apply.rollbackRef,
  };
}

module.exports = {
  applyCandidate,
  effectiveStatement,
  effectiveTarget,
};
