// Integration tests for the Ecosystem Memory Review capability.
// Real Mongo (shared mongodb-memory-server via setup-env); RAG client mocked so
// dedup/apply paths are controllable and no network is touched.

const express = require('express');
const request = require('supertest');

jest.mock('../../src/services/ragServiceClient', () => {
  const fake = {
    searchSimilarChunks: jest.fn().mockResolvedValue([]),
    upsertDocumentWithChunks: jest.fn().mockResolvedValue({ documentId: 'doc-1', chunkCount: 1, status: 'completed' }),
  };
  return {
    getRagServiceClient: () => fake,
    __fake: fake,
  };
});

const { __fake: fakeRag } = require('../../src/services/ragServiceClient');
const MemoryReviewRun = require('../../models/MemoryReviewRun');
const PipelineTask = require('../../models/PipelineTask');

function createApp() {
  const app = express();
  app.use(express.json({ limit: '1mb' }));
  app.use('/api/memory-review', require('../../routes/memory-review'));
  return app;
}

// One shared listener for the whole suite — per-request ephemeral servers
// (supertest's default with a bare app) exhaust Windows ephemeral ports.
const app = createApp();
let server;
beforeAll((done) => { server = app.listen(0, '127.0.0.1', done); });
afterAll((done) => { server.close(done); });

function obs(text, over = {}) {
  return {
    runtime: 'claude-code',
    host: 'testhost',
    sessionId: 'sess-1',
    eventId: `ev-${Math.random().toString(36).slice(2, 8)}`,
    observedAt: '2026-08-09T00:00:00Z',
    trust: 'explicit_memory_request',
    taints: [],
    text,
    sourceRef: 'proj/sess-1.jsonl',
    ...over,
  };
}

function collectorMeta(over = {}) {
  return {
    runtime: 'claude-code',
    host: 'testhost',
    watermarkBefore: 'wm:before',
    watermarkAfter: 'wm:after',
    sourceFilesSeen: 1,
    sourceEventsSeen: 5,
    eligibleObservations: 1,
    rejectedObservations: 0,
    rejectionCounts: {},
    errors: [],
    ...over,
  };
}

function candidate(statement, over = {}) {
  return {
    type: 'preference',
    statement,
    rationale: 'stated directly by the owner',
    target: { kind: 'shared_fact', runtime: null, topic: 'prefs' },
    evidenceRefs: over.evidenceRefs || [],
    confidence: 0.8,
    conflicts: [],
    ...over,
  };
}

async function openRun(runKey) {
  const res = await request(server).post('/api/memory-review/runs')
    .send({ runKey, mode: 'shadow', window: { from: 'a', to: 'b', timezone: 'America/Toronto' } })
    .expect(200);
  return res.body.data;
}

async function seedRunWithObservation(runKey, text = 'Prefer local-first tooling everywhere.') {
  const run = await openRun(runKey);
  const submit = await request(server)
    .post(`/api/memory-review/runs/${run.runId}/observations`)
    .send({ collector: collectorMeta(), observations: [obs(text)] })
    .expect(200);
  const observationId = `obs-${require('../../src/services/memoryReview/policy').contentHash(text).slice(0, 16)}`;
  return { run, submit: submit.body.data, observationId };
}

afterEach(async () => {
  delete process.env.MEMORY_REVIEW_MODE;
  fakeRag.searchSimilarChunks.mockReset().mockResolvedValue([]);
  fakeRag.upsertDocumentWithChunks.mockReset().mockResolvedValue({ documentId: 'doc-1', chunkCount: 1, status: 'completed' });
  await MemoryReviewRun.deleteMany({});
});

describe('config and mode gate', () => {
  test('default mode is shadow and apply is disabled', async () => {
    const res = await request(server).get('/api/memory-review/config').expect(200);
    expect(res.body.data.mode).toBe('shadow');
    expect(res.body.data.applyEnabled).toBe(false);
  });

  test('an invalid env value never enables apply', async () => {
    process.env.MEMORY_REVIEW_MODE = 'APPLY PLEASE';
    const res = await request(server).get('/api/memory-review/config').expect(200);
    expect(res.body.data.mode).toBe('shadow');
  });
});

describe('run lifecycle', () => {
  test('run creation is idempotent by runKey', async () => {
    const first = await openRun('test-idem');
    const second = await openRun('test-idem');
    expect(second.runId).toBe(first.runId);
    expect(await MemoryReviewRun.countDocuments({ runKey: 'test-idem' })).toBe(1);
  });

  test('a completed run key reopens as a new run', async () => {
    const first = await openRun('test-reopen');
    await request(server).post(`/api/memory-review/runs/${first.runId}/finalize`).expect(200); // empty -> completed
    const second = await openRun('test-reopen');
    expect(second.runId).not.toBe(first.runId);
  });

  test('empty run completes without a model call marker', async () => {
    const run = await openRun('test-empty');
    const res = await request(server).post(`/api/memory-review/runs/${run.runId}/finalize`).expect(200);
    expect(res.body.data.status).toBe('completed');
    expect(res.body.data.summary.noEligibleObservations).toBe(true);
    expect(res.body.data.summary.modelCalled).toBe(false);
  });
});

describe('observation submission', () => {
  test('accepts a valid observation and is idempotent on resubmission', async () => {
    const run = await openRun('test-obs');
    const fixed = obs('Prefer local-first tooling everywhere.', { eventId: 'ev-fixed-1' });
    const submit = await request(server)
      .post(`/api/memory-review/runs/${run.runId}/observations`)
      .send({ collector: collectorMeta(), observations: [fixed] })
      .expect(200);
    expect(submit.body.data.accepted).toBe(1);
    const again = await request(server)
      .post(`/api/memory-review/runs/${run.runId}/observations`)
      .send({ collector: collectorMeta(), observations: [fixed] })
      .expect(200);
    expect(again.body.data.accepted).toBe(0);
    expect(again.body.data.duplicates).toBe(1);
    const doc = await MemoryReviewRun.findOne({ runId: run.runId });
    expect(doc.observations).toHaveLength(1);
    // same event resubmitted -> idempotent, recurrence NOT inflated
    expect(doc.observations[0].recurrence.observationCount).toBe(1);
  });

  test('repetition across sessions strengthens recurrence', async () => {
    const { run } = await seedRunWithObservation('test-recur');
    await request(server)
      .post(`/api/memory-review/runs/${run.runId}/observations`)
      .send({
        collector: collectorMeta({ runtime: 'codex' }),
        observations: [obs('Prefer local-first tooling everywhere.', { runtime: 'codex', sessionId: 'sess-2', eventId: 'other' })],
      })
      .expect(200);
    const doc = await MemoryReviewRun.findOne({ runId: run.runId });
    expect(doc.observations[0].recurrence.observationCount).toBe(2);
    expect(doc.observations[0].recurrence.sessions).toEqual(expect.arrayContaining(['sess-1', 'sess-2']));
    expect(doc.observations[0].recurrence.runtimes).toEqual(expect.arrayContaining(['claude-code', 'codex']));
  });

  test('ineligible trust classes are rejected per item', async () => {
    const run = await openRun('test-trust');
    const res = await request(server)
      .post(`/api/memory-review/runs/${run.runId}/observations`)
      .send({
        collector: collectorMeta(),
        observations: [
          obs('assistant said so', { trust: 'assistant_claim' }),
          obs('tool printed this', { trust: 'tool_output' }),
          obs('ordinary role-user turn', { trust: 'explicit_owner_instruction' }),
          obs('legit', {}),
        ],
      })
      .expect(200);
    expect(res.body.data.accepted).toBe(1);
    expect(res.body.data.rejected).toHaveLength(3);
    expect(res.body.data.rejected[0].code).toBe('MEMORY_REVIEW_INELIGIBLE_TRUST');
  });

  test('secret-like text is refused server-side and not echoed back', async () => {
    const run = await openRun('test-secret');
    const res = await request(server)
      .post(`/api/memory-review/runs/${run.runId}/observations`)
      .send({ collector: collectorMeta(), observations: [obs('my password: hunter2hunter22')] })
      .expect(200);
    expect(res.body.data.accepted).toBe(0);
    expect(res.body.data.rejected[0].code).toBe('MEMORY_REVIEW_SECRET_REFUSED');
    expect(JSON.stringify(res.body)).not.toContain('hunter2hunter22');
  });

  test('raw transcript-shaped payloads are refused outright', async () => {
    const run = await openRun('test-raw');
    const res = await request(server)
      .post(`/api/memory-review/runs/${run.runId}/observations`)
      .send({
        collector: collectorMeta(),
        observations: [{ ...obs('x'), transcript: [{ role: 'user', content: 'full dump' }] }],
      })
      .expect(200);
    expect(res.body.data.rejected[0].code).toBe('MEMORY_REVIEW_RAW_TRANSCRIPT_REFUSED');
  });

  test('oversized observation text is rejected', async () => {
    const run = await openRun('test-size');
    const res = await request(server)
      .post(`/api/memory-review/runs/${run.runId}/observations`)
      .send({ collector: collectorMeta(), observations: [obs('y'.repeat(1300))] })
      .expect(200);
    expect(res.body.data.rejected[0].code).toBe('MEMORY_REVIEW_OVERSIZE');
  });

  test('batch size limit is enforced', async () => {
    const run = await openRun('test-batch');
    const many = Array.from({ length: 201 }, (_, i) => obs(`fact number ${i}`));
    const res = await request(server)
      .post(`/api/memory-review/runs/${run.runId}/observations`)
      .send({ collector: collectorMeta(), observations: many })
      .expect(400);
    expect(res.body.code).toBe('MEMORY_REVIEW_BATCH_TOO_LARGE');
  });

  test('observations are refused once collection is finalized', async () => {
    const { run } = await seedRunWithObservation('test-state');
    await request(server).post(`/api/memory-review/runs/${run.runId}/finalize`).expect(200);
    const res = await request(server)
      .post(`/api/memory-review/runs/${run.runId}/observations`)
      .send({ collector: collectorMeta(), observations: [obs('late arrival')] })
      .expect(409);
    expect(res.body.code).toBe('MEMORY_REVIEW_WRONG_STATE');
  });
});

describe('finalize and synthesis input', () => {
  test('finalize moves to synthesizing and is idempotent', async () => {
    const { run } = await seedRunWithObservation('test-fin');
    const first = await request(server).post(`/api/memory-review/runs/${run.runId}/finalize`).expect(200);
    expect(first.body.data.status).toBe('synthesizing');
    const second = await request(server).post(`/api/memory-review/runs/${run.runId}/finalize`).expect(200);
    expect(second.body.data.status).toBe('synthesizing');
  });

  test('RAG being down degrades dedup but never blocks the run', async () => {
    fakeRag.searchSimilarChunks.mockRejectedValue(new Error('qdrant unreachable'));
    const { run } = await seedRunWithObservation('test-ragdown');
    const res = await request(server).post(`/api/memory-review/runs/${run.runId}/finalize`).expect(200);
    expect(res.body.data.status).toBe('synthesizing');
    expect(res.body.data.dedupDegraded).toBe(true);
  });

  test('synthesis input exposes sanitized observations and dedup context only', async () => {
    fakeRag.searchSimilarChunks.mockResolvedValue([
      { text: 'existing memory gist', score: 0.9, metadata: { documentId: 'nestor-memory:x' } },
    ]);
    const { run, observationId } = await seedRunWithObservation('test-syn');
    await request(server).post(`/api/memory-review/runs/${run.runId}/finalize`).expect(200);
    const res = await request(server).get(`/api/memory-review/runs/${run.runId}/synthesis-input`).expect(200);
    const input = res.body.data;
    expect(input.observations).toHaveLength(1);
    expect(input.observations[0].id).toBe(observationId);
    expect(input.dedupContext.ragMatches.length).toBeGreaterThan(0);
    expect(input.limits.maxCandidates).toBe(30);
  });
});

describe('candidate submission', () => {
  async function readyRun(runKey) {
    const seeded = await seedRunWithObservation(runKey);
    await request(server).post(`/api/memory-review/runs/${seeded.run.runId}/finalize`).expect(200);
    return seeded;
  }

  test('valid candidate accepted with server-derived id; resubmission idempotent', async () => {
    const { run, observationId } = await readyRun('test-cand');
    const body = { candidates: [candidate('Owner prefers local-first tooling.', { evidenceRefs: [observationId] })] };
    const first = await request(server).post(`/api/memory-review/runs/${run.runId}/candidates`).send(body).expect(200);
    expect(first.body.data.accepted).toBe(1);
    expect(first.body.data.status).toBe('ready_for_review');
    const doc = await MemoryReviewRun.findOne({ runId: run.runId });
    expect(doc.candidates).toHaveLength(1);
    expect(doc.candidates[0].candidateId).toHaveLength(32);
    expect(doc.candidates[0].evidence[0].observationId).toBe(observationId);
    // idempotent resubmission needs the run back in synthesizing: simulate a retry
    doc.status = 'synthesizing';
    await doc.save();
    await request(server).post(`/api/memory-review/runs/${run.runId}/candidates`).send(body).expect(200);
    const after = await MemoryReviewRun.findOne({ runId: run.runId });
    expect(after.candidates).toHaveLength(1);
  });

  test('unknown evidence refs and secret statements are dropped, not stored', async () => {
    const { run, observationId } = await readyRun('test-cand-bad');
    const res = await request(server).post(`/api/memory-review/runs/${run.runId}/candidates`).send({
      candidates: [
        candidate('cites nothing real', { evidenceRefs: ['obs-doesnotexist00'] }),
        candidate('store api_key = abcd1234efgh5678', { evidenceRefs: [observationId] }),
        candidate('good durable preference', { evidenceRefs: [observationId] }),
      ],
    }).expect(200);
    expect(res.body.data.accepted).toBe(1);
    expect(res.body.data.dropped).toHaveLength(2);
    const doc = await MemoryReviewRun.findOne({ runId: run.runId });
    expect(doc.candidates).toHaveLength(1);
    expect(JSON.stringify(doc.candidates)).not.toContain('abcd1234efgh5678');
  });

  test('unknown extra fields on a candidate are refused (no smuggled approvals)', async () => {
    const { run, observationId } = await readyRun('test-cand-extra');
    const sneaky = { ...candidate('sneaky', { evidenceRefs: [observationId] }), status: 'approved' };
    const res = await request(server).post(`/api/memory-review/runs/${run.runId}/candidates`)
      .send({ candidates: [sneaky] }).expect(200);
    expect(res.body.data.accepted).toBe(0);
    expect(res.body.data.dropped[0].code).toBe('MEMORY_REVIEW_UNKNOWN_FIELDS');
  });

  test('high-score RAG match on cited evidence surfaces a duplicate conflict', async () => {
    fakeRag.searchSimilarChunks.mockResolvedValue([
      { text: 'already stored fact', score: 0.91, metadata: { documentId: 'nestor-memory:dup' } },
    ]);
    const { run, observationId } = await readyRun('test-dupconf');
    await request(server).post(`/api/memory-review/runs/${run.runId}/candidates`).send({
      candidates: [candidate('possibly already known', { evidenceRefs: [observationId] })],
    }).expect(200);
    const doc = await MemoryReviewRun.findOne({ runId: run.runId });
    expect(doc.candidates[0].conflicts.some((c) => c.authority === 'rag')).toBe(true);
  });
});

describe('review workflow', () => {
  async function runWithCandidate(runKey, statement = 'Owner prefers concise summaries.') {
    const { run, observationId } = await seedRunWithObservation(runKey, `please remember: ${statement}`);
    await request(server).post(`/api/memory-review/runs/${run.runId}/finalize`).expect(200);
    await request(server).post(`/api/memory-review/runs/${run.runId}/candidates`).send({
      candidates: [candidate(statement, { evidenceRefs: [observationId] })],
    }).expect(200);
    const doc = await MemoryReviewRun.findOne({ runId: run.runId });
    return { run, candidateId: doc.candidates[0].candidateId };
  }

  test('approve derives reviewer identity server-side and transitions atomically', async () => {
    const { run, candidateId } = await runWithCandidate('test-rev-a');
    const ok = await request(server)
      .post(`/api/memory-review/runs/${run.runId}/candidates/${candidateId}/review`)
      .send({ action: 'approve', by: 'forged-client-name' }).expect(200);
    expect(ok.body.data.status).toBe('approved');
    // second review of a decided candidate is refused
    const again = await request(server)
      .post(`/api/memory-review/runs/${run.runId}/candidates/${candidateId}/review`)
      .send({ action: 'reject', by: 'operator' }).expect(409);
    expect(again.body.code).toBe('MEMORY_REVIEW_WRONG_STATE');
    const doc = await MemoryReviewRun.findOne({ runId: run.runId });
    expect(doc.status).toBe('completed'); // all candidates reviewed
    expect(doc.audit.some((a) => a.event === 'candidate_approve' && a.by === 'loopback-operator')).toBe(true);
    expect(doc.audit.some((a) => a.by === 'forged-client-name')).toBe(false);
  });

  test('candidate type cannot route itself to an unrelated apply adapter', async () => {
    const { run, observationId } = await seedRunWithObservation('test-cand-route-policy');
    await request(server).post(`/api/memory-review/runs/${run.runId}/finalize`).expect(200);
    const res = await request(server).post(`/api/memory-review/runs/${run.runId}/candidates`).send({
      candidates: [candidate('summary cannot become a task', {
        type: 'session_summary',
        target: { kind: 'pipeline_task', runtime: null, topic: 'followup' },
        evidenceRefs: [observationId],
      })],
    }).expect(200);
    expect(res.body.data.accepted).toBe(0);
    expect(res.body.data.dropped[0].code).toBe('MEMORY_REVIEW_TARGET_POLICY');
  });

  test('concurrent review attempts have exactly one winner', async () => {
    const { run, candidateId } = await runWithCandidate('test-rev-race');
    const results = await Promise.all([
      request(server)
        .post(`/api/memory-review/runs/${run.runId}/candidates/${candidateId}/review`)
        .send({ action: 'approve' }),
      request(server)
        .post(`/api/memory-review/runs/${run.runId}/candidates/${candidateId}/review`)
        .send({ action: 'reject' }),
    ]);
    expect(results.map((res) => res.status).sort()).toEqual([200, 409]);
    const doc = await MemoryReviewRun.findOne({ runId: run.runId }).lean();
    const reviewAudits = doc.audit.filter((item) => item.event.startsWith('candidate_'));
    expect(reviewAudits).toHaveLength(1);
  });

  test('edit_approve preserves the original statement separately', async () => {
    const { run, candidateId } = await runWithCandidate('test-rev-e', 'Owner prefers tabs.');
    const res = await request(server)
      .post(`/api/memory-review/runs/${run.runId}/candidates/${candidateId}/review`)
      .send({ action: 'edit_approve', by: 'operator', editedStatement: 'Owner prefers tabs in Python only.' })
      .expect(200);
    expect(res.body.data.status).toBe('approved');
    expect(res.body.data.statement).toBe('Owner prefers tabs.');
    expect(res.body.data.review.editedStatement).toBe('Owner prefers tabs in Python only.');
  });

  test('defer keeps the candidate reviewable and the run open', async () => {
    const { run, candidateId } = await runWithCandidate('test-rev-d');
    await request(server)
      .post(`/api/memory-review/runs/${run.runId}/candidates/${candidateId}/review`)
      .send({ action: 'defer', by: 'operator' }).expect(200);
    const doc = await MemoryReviewRun.findOne({ runId: run.runId });
    expect(doc.candidates[0].status).toBe('deferred');
    expect(doc.status).not.toBe('completed');
    await request(server)
      .post(`/api/memory-review/runs/${run.runId}/candidates/${candidateId}/review`)
      .send({ action: 'approve', by: 'operator' }).expect(200);
  });

  test('there is no bulk approve surface', async () => {
    const { run } = await runWithCandidate('test-rev-bulk');
    await request(server).post(`/api/memory-review/runs/${run.runId}/review-all`).send({}).expect(404);
    await request(server).post(`/api/memory-review/runs/${run.runId}/approve-all`).send({}).expect(404);
  });

  test('rejected claim is suppressed in later runs without new evidence', async () => {
    const statement = 'Owner wants weekly summaries.';
    const { run, candidateId } = await runWithCandidate('test-suppress', statement);
    await request(server)
      .post(`/api/memory-review/runs/${run.runId}/candidates/${candidateId}/review`)
      .send({ action: 'reject', by: 'operator' }).expect(200);

    // second run, SAME evidence text -> suppressed
    const seeded2 = await seedRunWithObservation('test-suppress-2', `please remember: ${statement}`);
    await request(server).post(`/api/memory-review/runs/${seeded2.run.runId}/finalize`).expect(200);
    const res2 = await request(server).post(`/api/memory-review/runs/${seeded2.run.runId}/candidates`).send({
      candidates: [candidate(statement, { evidenceRefs: [seeded2.observationId] })],
    }).expect(200);
    expect(res2.body.data.accepted).toBe(0);
    expect(res2.body.data.suppressed).toBe(1);

    // third run, materially NEW evidence -> re-proposed with a prior_review conflict
    const seeded3 = await seedRunWithObservation('test-suppress-3', 'a different phrasing: weekly summaries please, every Monday');
    await request(server).post(`/api/memory-review/runs/${seeded3.run.runId}/finalize`).expect(200);
    const res3 = await request(server).post(`/api/memory-review/runs/${seeded3.run.runId}/candidates`).send({
      candidates: [candidate(statement, { evidenceRefs: [seeded3.observationId] })],
    }).expect(200);
    expect(res3.body.data.accepted).toBe(1);
    const doc3 = await MemoryReviewRun.findOne({ runId: seeded3.run.runId });
    expect(doc3.candidates[0].conflicts.some((c) => c.authority === 'prior_review')).toBe(true);
  });
});

describe('apply gating and adapters', () => {
  async function approvedCandidate(runKey, targetOver = {}) {
    const statement = `Durable fact for ${runKey}.`;
    const seeded = await seedRunWithObservation(runKey, `remember this: ${statement}`);
    await request(server).post(`/api/memory-review/runs/${seeded.run.runId}/finalize`).expect(200);
    const kind = targetOver.kind || 'shared_fact';
    const type = kind === 'pipeline_task' ? 'task_or_followup' : 'preference';
    await request(server).post(`/api/memory-review/runs/${seeded.run.runId}/candidates`).send({
      candidates: [candidate(statement, {
        type,
        evidenceRefs: [seeded.observationId],
        target: { kind: 'shared_fact', runtime: null, topic: 'facts', ...targetOver },
      })],
    }).expect(200);
    const doc = await MemoryReviewRun.findOne({ runId: seeded.run.runId });
    const candidateId = doc.candidates[0].candidateId;
    await request(server)
      .post(`/api/memory-review/runs/${seeded.run.runId}/candidates/${candidateId}/review`)
      .send({ action: 'approve', by: 'operator' }).expect(200);
    return { runId: seeded.run.runId, candidateId };
  }

  async function authorizeRun(runId) {
    process.env.MEMORY_REVIEW_MODE = 'apply';
    return request(server)
      .post(`/api/memory-review/runs/${runId}/authorize-apply`)
      .send({ by: 'forged-client-name' })
      .expect(200);
  }

  test('apply is refused in shadow mode even for an approved candidate', async () => {
    const { runId, candidateId } = await approvedCandidate('test-apply-shadow');
    const res = await request(server)
      .post(`/api/memory-review/runs/${runId}/candidates/${candidateId}/apply`)
      .send({ by: 'operator' }).expect(403);
    expect(res.body.code).toBe('MEMORY_REVIEW_APPLY_DISABLED');
  });

  test('apply is refused for an unapproved candidate even in apply mode', async () => {
    const seeded = await seedRunWithObservation('test-apply-unapproved');
    await request(server).post(`/api/memory-review/runs/${seeded.run.runId}/finalize`).expect(200);
    await request(server).post(`/api/memory-review/runs/${seeded.run.runId}/candidates`).send({
      candidates: [candidate('unapproved statement', { evidenceRefs: [seeded.observationId] })],
    }).expect(200);
    const doc = await MemoryReviewRun.findOne({ runId: seeded.run.runId });
    process.env.MEMORY_REVIEW_MODE = 'apply';
    await MemoryReviewRun.updateOne(
      { runId: seeded.run.runId },
      { $set: { mode: 'apply', applyAuthorization: { by: 'test', at: new Date() } } }
    );
    const res = await request(server)
      .post(`/api/memory-review/runs/${seeded.run.runId}/candidates/${doc.candidates[0].candidateId}/apply`)
      .send({ by: 'operator' }).expect(409);
    expect(res.body.code).toBe('MEMORY_REVIEW_NOT_APPROVED');
  });

  test('shared_fact adapter writes through nestor-memory and duplicate apply is a no-op', async () => {
    const { runId, candidateId } = await approvedCandidate('test-apply-fact');
    await authorizeRun(runId);
    const first = await request(server)
      .post(`/api/memory-review/runs/${runId}/candidates/${candidateId}/apply`)
      .send({ by: 'operator' }).expect(200);
    expect(first.body.data.status).toBe('applied');
    expect(first.body.data.result).toContain('nestor-memory');
    expect(fakeRag.upsertDocumentWithChunks).toHaveBeenCalledTimes(1);
    const upsertArgs = fakeRag.upsertDocumentWithChunks.mock.calls[0][1];
    expect(upsertArgs.source).toBe('nestor-memory');
    expect(upsertArgs.documentId).toContain('memory-review');

    const second = await request(server)
      .post(`/api/memory-review/runs/${runId}/candidates/${candidateId}/apply`)
      .send({ by: 'operator' }).expect(200);
    expect(second.body.data.alreadyApplied).toBe(true);
    expect(fakeRag.upsertDocumentWithChunks).toHaveBeenCalledTimes(1);
  });

  test('concurrent apply attempts acquire only one adapter lease', async () => {
    const { runId, candidateId } = await approvedCandidate('test-apply-race');
    await authorizeRun(runId);
    let release;
    let signalStarted;
    const started = new Promise((resolve) => { signalStarted = resolve; });
    fakeRag.upsertDocumentWithChunks.mockImplementationOnce(() => new Promise((resolve) => {
      signalStarted();
      release = () => resolve({ documentId: 'doc-race', chunkCount: 1, status: 'completed' });
    }));
    const first = request(server)
      .post(`/api/memory-review/runs/${runId}/candidates/${candidateId}/apply`)
      .send({})
      .then((res) => res);
    await started;
    const second = await request(server)
      .post(`/api/memory-review/runs/${runId}/candidates/${candidateId}/apply`)
      .send({});
    expect(second.status).toBe(409);
    expect(second.body.code).toBe('MEMORY_REVIEW_APPLY_IN_PROGRESS');
    release();
    const completed = await first;
    expect(completed.status).toBe(200);
    expect(fakeRag.upsertDocumentWithChunks).toHaveBeenCalledTimes(1);
  });

  test('pipeline_task adapter creates a real approval-gated task', async () => {
    const { runId, candidateId } = await approvedCandidate('test-apply-task', { kind: 'pipeline_task' });
    await authorizeRun(runId);
    const res = await request(server)
      .post(`/api/memory-review/runs/${runId}/candidates/${candidateId}/apply`)
      .send({ by: 'operator' }).expect(200);
    expect(res.body.data.result).toMatch(/pipeline task \d{4} created/);
    const pipelineId = res.body.data.result.match(/(\d{4})/)[1];
    const task = await PipelineTask.findOne({ pipelineId });
    expect(task).toBeTruthy();
    expect(task.source).toBe('memory-review');
    expect(task.spec).toContain('memory-review candidate');
    await PipelineTask.deleteOne({ pipelineId });
  });

  test('runtime_local adapter is proposal-only and writes nothing external', async () => {
    const { runId, candidateId } = await approvedCandidate('test-apply-local', { kind: 'runtime_local', runtime: 'codex' });
    await authorizeRun(runId);
    const res = await request(server)
      .post(`/api/memory-review/runs/${runId}/candidates/${candidateId}/apply`)
      .send({ by: 'operator' }).expect(200);
    expect(res.body.data.result).toContain('runtime-local proposal generated for codex');
    expect(res.body.data.result).toContain('NEVER by editing its SQLite');
    expect(fakeRag.upsertDocumentWithChunks).not.toHaveBeenCalled();
    expect(await PipelineTask.countDocuments({ source: 'memory-review' })).toBe(0);
  });

  test('adapter failure marks apply_failed, audits, and stays retryable', async () => {
    const { runId, candidateId } = await approvedCandidate('test-apply-fail');
    await authorizeRun(runId);
    fakeRag.upsertDocumentWithChunks.mockRejectedValueOnce(new Error('rag exploded'));
    await request(server)
      .post(`/api/memory-review/runs/${runId}/candidates/${candidateId}/apply`)
      .send({ by: 'operator' }).expect(502);
    let doc = await MemoryReviewRun.findOne({ runId });
    expect(doc.candidates[0].status).toBe('apply_failed');
    expect(doc.audit.some((a) => a.event === 'candidate_apply_failed')).toBe(true);
    // retry succeeds
    const retry = await request(server)
      .post(`/api/memory-review/runs/${runId}/candidates/${candidateId}/apply`)
      .send({ by: 'operator' }).expect(200);
    expect(retry.body.data.status).toBe('applied');
  });

  test('secret smuggled via edit is re-guarded at apply time', async () => {
    const { runId, candidateId } = await approvedCandidate('test-apply-guard');
    // simulate a bad edit landing in the DB (bypassing the API guard)
    await MemoryReviewRun.updateOne(
      { runId },
      { $set: { 'candidates.0.review.editedStatement': 'password: hunter2hunter22' } }
    );
    await authorizeRun(runId);
    const res = await request(server)
      .post(`/api/memory-review/runs/${runId}/candidates/${candidateId}/apply`)
      .send({ by: 'operator' }).expect(400);
    expect(res.body.code).toBe('MEMORY_REVIEW_SECRET_REFUSED');
    expect(fakeRag.upsertDocumentWithChunks).not.toHaveBeenCalled();
  });
});

describe('reads and reporting', () => {
  test('insights aggregate product signals without exposing candidate statements', async () => {
    const { run, observationId } = await seedRunWithObservation('test-insights', 'Remember that concise UI labels are preferred.');
    await request(server).post(`/api/memory-review/runs/${run.runId}/finalize`).expect(200);
    await request(server).post(`/api/memory-review/runs/${run.runId}/candidates`).send({
      candidates: [candidate('Use concise UI labels.', { evidenceRefs: [observationId] })],
    }).expect(200);
    const detail = await request(server).get(`/api/memory-review/runs/${run.runId}`).expect(200);
    const candidateId = detail.body.data.candidates[0].candidateId;
    await request(server)
      .post(`/api/memory-review/runs/${run.runId}/candidates/${candidateId}/review`)
      .send({ action: 'approve' }).expect(200);

    const res = await request(server).get('/api/memory-review/insights?limit=999').expect(200);
    expect(res.body.data.window.limit).toBe(100);
    expect(res.body.data.totals).toEqual(expect.objectContaining({
      runs: 1, candidates: 1, pending: 0, reviewed: 1,
      eligibleObservations: 1,
    }));
    expect(res.body.data.quality.approvalPrecision).toBeNull();
    expect(res.body.data.quality.evidence).toEqual(expect.objectContaining({
      state: 'partial',
      missingRuntimes: expect.arrayContaining(['agentx', 'codex', 'external']),
    }));
    expect(res.body.data.quality.metrics.approvalPrecision).toEqual(expect.objectContaining({
      value: null,
      lastValue: 100,
      denominator: 1,
      state: 'partial',
    }));
    expect(res.body.data.runtimes).toEqual(expect.arrayContaining([
      expect.objectContaining({ runtime: 'claude-code', health: 'healthy', eligible: 1 }),
    ]));
    expect(res.body.data.distributions.candidateTypes.preference).toBe(1);
    expect(res.body.data.safeDigest).not.toContain('collectors healthy');
    expect(JSON.stringify(res.body.data)).not.toContain('Use concise UI labels');
  });

  test('run listing paginates and the digest names pending candidates', async () => {
    const { run, observationId } = await seedRunWithObservation('test-digest');
    await request(server).post(`/api/memory-review/runs/${run.runId}/finalize`).expect(200);
    await request(server).post(`/api/memory-review/runs/${run.runId}/candidates`).send({
      candidates: [candidate('Digest-worthy preference.', { evidenceRefs: [observationId] })],
    }).expect(200);

    const list = await request(server).get('/api/memory-review/runs?limit=5').expect(200);
    expect(list.body.data.runs.length).toBeGreaterThan(0);
    expect(list.body.data.runs[0]).not.toHaveProperty('observations');
    expect(list.body.data.runs[0]).not.toHaveProperty('candidates');
    expect(list.body.data.runs[0].reviewCounts).toEqual(expect.objectContaining({ proposed: 1 }));
    expect(list.body.data.runs[0].collectorSummary).toEqual(expect.objectContaining({
      runtimes: expect.arrayContaining(['claude-code']), errors: 0,
    }));
    expect(list.body.data.runs[0].reconciliation).toEqual(expect.objectContaining({ active: false, overdue: false }));

    const digest = await request(server).get('/api/memory-review/digest').expect(200);
    expect(digest.body.data.pending).toBe(1);
    expect(digest.body.data.text).toContain('Digest-worthy preference.');
    expect(digest.body.data.text).toContain('No changes are applied without approval');
  });

  test('digest prefers completed truth while surfacing an overdue active handoff', async () => {
    const completed = await openRun('test-completed-truth');
    await request(server).post(`/api/memory-review/runs/${completed.runId}/finalize`).expect(200);
    const active = await openRun('test-late-handoff');
    await MemoryReviewRun.collection.updateOne(
      { runId: active.runId },
      { $set: { createdAt: new Date(Date.now() - 3 * 60 * 60 * 1000) } }
    );

    const digest = await request(server).get('/api/memory-review/digest').expect(200);
    expect(digest.body.data).toEqual(expect.objectContaining({
      runId: completed.runId, pending: 0, attention: true,
    }));
    expect(digest.body.data.activeRun).toEqual(expect.objectContaining({ runId: active.runId }));
    expect(digest.body.data.activeRun.reconciliation).toEqual(expect.objectContaining({ overdue: true }));
    expect(digest.body.data.text).toContain(`reconciliation ${active.runId} is overdue`);
  });

  test('audit trail is exposed and bounded', async () => {
    const { run } = await seedRunWithObservation('test-audit');
    const res = await request(server).get(`/api/memory-review/runs/${run.runId}/audit`).expect(200);
    const events = res.body.data.audit.map((a) => a.event);
    expect(events).toEqual(expect.arrayContaining(['run_opened', 'observations_submitted']));
  });

  test('run detail excludes observations unless explicitly requested', async () => {
    const { run } = await seedRunWithObservation('test-detail');
    const bare = await request(server).get(`/api/memory-review/runs/${run.runId}`).expect(200);
    expect(bare.body.data).not.toHaveProperty('observations');
    expect(bare.body.data.reconciliation).toEqual(expect.objectContaining({ active: true, overdue: false }));
    const full = await request(server).get(`/api/memory-review/runs/${run.runId}?includeObservations=true`).expect(200);
    expect(full.body.data.observations).toHaveLength(1);
  });
});
