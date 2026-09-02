'use strict';

const {
  normalizeWorkerEnvelope,
  normalizeWorkerReceipt,
  projectWorkerReceiptPublic,
} = require('../../../shared/workerContract');
const { envelopeInput, receiptInput } = require('../helpers/workerContractFixtures');

describe('WorkerEnvelope v1', () => {
  test('normalizes a valid envelope and derives nested deterministic fingerprints', () => {
    const envelope = normalizeWorkerEnvelope(envelopeInput());
    expect(envelope).toMatchObject({
      schema: 'agentx.worker-envelope/v1',
      schemaVersion: 1,
      executionProfile: 'portable',
    });
    expect(envelope.tools.schemaFingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(envelope.policies.fingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(envelope.fingerprint).toMatch(/^[a-f0-9]{64}$/);
  });

  test('fails deterministically when a required field is absent', () => {
    const raw = envelopeInput();
    delete raw.task;
    expect(() => normalizeWorkerEnvelope(raw)).toThrow(expect.objectContaining({ code: 'OBJECT_REQUIRED' }));
  });

  test('rejects an invalid budget', () => {
    const raw = envelopeInput();
    raw.budgets.maxTurns = 0;
    expect(() => normalizeWorkerEnvelope(raw)).toThrow(expect.objectContaining({ code: 'INVALID_BUDGET' }));
  });

  test('produces a stable fingerprint across key and set ordering', () => {
    const first = normalizeWorkerEnvelope(envelopeInput());
    const raw = envelopeInput();
    raw.policies.filesystem.allowedOperations = ['update', 'read'];
    raw.selection.harness.constraints = ['supports.tests', 'supports.patch'];
    const second = normalizeWorkerEnvelope(raw);
    expect(second).toEqual(first);
  });
});

describe('WorkerReceipt v1', () => {
  test('normalizes a successful receipt and binds it to the envelope', () => {
    const envelope = normalizeWorkerEnvelope(envelopeInput());
    const receipt = normalizeWorkerReceipt(receiptInput(envelope), { envelope });
    expect(receipt.finalState).toBe('succeeded');
    expect(receipt.failure).toEqual({ classification: null, code: null });
    expect(receipt.executionTupleFingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(receipt.fingerprint).toMatch(/^[a-f0-9]{64}$/);
  });

  test('preserves provider-reported cost provenance and cache usage', () => {
    const envelope = normalizeWorkerEnvelope(envelopeInput());
    const raw = receiptInput(envelope);
    raw.usage.cacheReadTokens = 12;
    raw.usage.cacheWriteTokens = 3;
    raw.usage.costSource = 'provider-reported';
    const receipt = normalizeWorkerReceipt(raw, { envelope });
    expect(receipt.usage).toMatchObject({
      cacheReadTokens: 12,
      cacheWriteTokens: 3,
      costSource: 'provider-reported',
    });
  });

  test('normalizes a failed receipt with bounded tool and human evidence', () => {
    const envelope = normalizeWorkerEnvelope(envelopeInput());
    const receipt = normalizeWorkerReceipt(receiptInput(envelope, {
      finalState: 'failed',
      failure: { classification: 'tool_error', code: 'TOOL_EXIT_NONZERO' },
      toolErrors: [{ tool: 'workspace.patch', code: 'EXIT_NONZERO', count: 2 }],
      humanInterventions: [{ kind: 'approval', count: 1 }],
      violations: [{ category: 'scope', code: 'OUTSIDE_WORKSPACE_ATTEMPT', count: 1 }],
      result: { contractSatisfied: false, fingerprint: null },
    }), { envelope });
    expect(receipt).toMatchObject({
      finalState: 'failed',
      failure: { classification: 'tool_error', code: 'TOOL_EXIT_NONZERO' },
      toolErrors: [{ count: 2 }],
      humanInterventions: [{ count: 1 }],
    });
  });

  test('detects a material receipt modification', () => {
    const envelope = normalizeWorkerEnvelope(envelopeInput());
    const receipt = normalizeWorkerReceipt(receiptInput(envelope), { envelope });
    expect(() => normalizeWorkerReceipt({
      ...receipt,
      usage: { ...receipt.usage, durationMs: receipt.usage.durationMs + 1 },
    }, { envelope })).toThrow(expect.objectContaining({ code: 'RECEIPT_FINGERPRINT_MISMATCH' }));
  });

  test('rejects a success that does not satisfy its result contract', () => {
    const envelope = normalizeWorkerEnvelope(envelopeInput());
    const raw = receiptInput(envelope);
    raw.result.contractSatisfied = false;
    expect(() => normalizeWorkerReceipt(raw, { envelope }))
      .toThrow(expect.objectContaining({ code: 'SUCCESS_RESULT_UNSATISFIED' }));
  });

  test('rejects a success that exceeds an envelope budget', () => {
    const envelope = normalizeWorkerEnvelope(envelopeInput());
    const raw = receiptInput(envelope);
    raw.usage.durationMs = envelope.budgets.maxDurationMs + 1;
    expect(() => normalizeWorkerReceipt(raw, { envelope }))
      .toThrow(expect.objectContaining({ code: 'SUCCESS_EXCEEDS_BUDGET' }));
  });

  test('rejects a receipt that violates an exact envelope selection', () => {
    const envelope = normalizeWorkerEnvelope(envelopeInput({
      selection: {
        harness: { id: 'harness-required', version: '1.0.0', constraints: [] },
        model: { provider: 'provider-a', id: 'model-a', version: '2026-08', constraints: [] },
      },
    }));
    expect(() => normalizeWorkerReceipt(receiptInput(envelope), { envelope }))
      .toThrow(expect.objectContaining({ code: 'RECEIPT_SELECTION_MISMATCH' }));
  });

  test('rejects a success missing evidence required by the envelope', () => {
    const envelope = normalizeWorkerEnvelope(envelopeInput());
    const raw = receiptInput(envelope);
    raw.evidence.tests = [];
    expect(() => normalizeWorkerReceipt(raw, { envelope }))
      .toThrow(expect.objectContaining({ code: 'SUCCESS_MISSING_EVIDENCE' }));
  });

  test.each([
    ['harness', (raw) => { raw.identity.harness.version = '9.0.0'; }],
    ['adapter', (raw) => { raw.identity.adapter.version = '9.0.0'; }],
    ['model digest', (raw) => { raw.identity.model.digest = `sha256:${'9'.repeat(64)}`; }],
    ['API', (raw) => { raw.identity.api.version = '2099-01'; }],
    ['prompt', (raw) => { raw.fingerprints.prompt = '9'.repeat(64); }],
    ['tools', (raw) => { raw.fingerprints.tools = '8'.repeat(64); }],
    ['policies', (raw) => { raw.fingerprints.policies = '7'.repeat(64); }],
    ['environment', (raw) => { raw.identity.environment.fingerprint = '6'.repeat(64); }],
  ])('changes the exact execution tuple fingerprint when %s identity changes', (_name, mutate) => {
    const envelope = normalizeWorkerEnvelope(envelopeInput());
    const baseline = normalizeWorkerReceipt(receiptInput(envelope));
    const changedRaw = receiptInput(envelope);
    mutate(changedRaw);
    const changed = normalizeWorkerReceipt(changedRaw);
    expect(changed.executionTupleFingerprint).not.toBe(baseline.executionTupleFingerprint);
    expect(changed.fingerprint).not.toBe(baseline.fingerprint);
  });

  test('public projection allowlists evidence and omits secrets, transcript, content, and private paths', () => {
    const envelope = normalizeWorkerEnvelope(envelopeInput());
    const raw = receiptInput(envelope);
    raw.secret = 'bearer-secret';
    raw.transcript = [{ role: 'user', content: 'private conversation' }];
    raw.prompt = 'private prompt content';
    raw.evidence.artifacts[0].path = 'X:\\fixture-private\\artifact.json';
    raw.identity.environment.id = 'deployment-node-private';
    raw.identity.environment.version = 'runtime-private';
    const projected = projectWorkerReceiptPublic(raw, { envelope });
    const serialized = JSON.stringify(projected);
    expect(serialized).not.toMatch(/bearer-secret|private conversation|private prompt|fixture-private|artifact\.json|transcript|secret|deployment-node-private|runtime-private/);
    expect(projected.identity.harness).toEqual({ name: 'harness-a', version: '1.2.3' });
    expect(projected.identity.environment).toEqual({ fingerprint: 'c'.repeat(64) });
    expect(projected.evidence.artifacts[0]).toEqual({ id: 'artifact-001', digest: `sha256:${'e'.repeat(64)}` });
  });
});
