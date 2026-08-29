'use strict';

const { normalizeWorkerEnvelope, normalizeWorkerReceipt } = require('../../../shared/workerContract');
const {
  compareWorkerEvidence,
  validateWorkerEvidenceReport,
} = require('../../src/services/benchmark/workerEvidenceComparison');
const { envelopeInput, receiptInput } = require('../helpers/workerContractFixtures');

function receiptFor(envelope, harness, overrides = {}) {
  const raw = receiptInput(envelope, {
    identity: {
      ...receiptInput(envelope).identity,
      harness: { name: harness, version: '1.0.0' },
      adapter: { name: `${harness}-adapter`, version: '1.0.0' },
      environment: { id: `${harness}-sandbox`, version: 'image-1', fingerprint: overrides.environmentFingerprint || 'c'.repeat(64) },
    },
    ...overrides,
  });
  delete raw.environmentFingerprint;
  return normalizeWorkerReceipt(raw, { envelope });
}

function evidenceFor(envelope, harness, overrides = {}) {
  return { envelope, receipt: receiptFor(envelope, harness, overrides) };
}

describe('Benchmark worker/harness evidence comparison', () => {
  test('portable profile compares different harnesses only under frozen model, prompt, tools, policies, and envelope', () => {
    const envelope = normalizeWorkerEnvelope(envelopeInput());
    const report = compareWorkerEvidence({
      profile: 'portable',
      generatedAt: '2026-08-28T12:00:00.000Z',
      evidence: [evidenceFor(envelope, 'harness-a'), evidenceFor(envelope, 'harness-b')],
    });
    expect(report).toMatchObject({
      schema: 'agentx.worker-evidence-comparison/v1',
      profile: 'portable',
      receiptCount: 2,
      tupleCount: 2,
      policy: {
        harnessExecution: false,
        routeMutation: false,
        candidatePromotion: false,
        universalWinner: null,
      },
    });
    expect(report.portableBaselineFingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(report.tuples.map((tuple) => tuple.identity.harness.name).sort()).toEqual(['harness-a', 'harness-b']);
    expect(report.tuples.every((tuple) => (
      Object.keys(tuple.identity.environment).join(',') === 'fingerprint'
    ))).toBe(true);
    expect(validateWorkerEvidenceReport(report)).toBe(report);
  });

  test('portable profile fails closed when a material tuple input changes', () => {
    const envelope = normalizeWorkerEnvelope(envelopeInput());
    const changedEnvelope = normalizeWorkerEnvelope(envelopeInput({
      prompt: { reference: 'prompt.portable-v2', fingerprint: '9'.repeat(64) },
    }));
    expect(() => compareWorkerEvidence({
      profile: 'portable',
      evidence: [evidenceFor(envelope, 'harness-a'), evidenceFor(changedEnvelope, 'harness-b')],
    })).toThrow(expect.objectContaining({ code: 'PORTABLE_CONTRACT_MISMATCH' }));
  });

  test('portable profile requires distinct exact harness identities', () => {
    const envelope = normalizeWorkerEnvelope(envelopeInput());
    expect(() => compareWorkerEvidence({
      profile: 'portable',
      evidence: [evidenceFor(envelope, 'harness-a'), evidenceFor(envelope, 'harness-a')],
    })).toThrow(expect.objectContaining({ code: 'PORTABLE_HARNESSES_REQUIRED' }));
  });

  test('rejects a receipt that is not bound to its supplied envelope', () => {
    const envelope = normalizeWorkerEnvelope(envelopeInput());
    const raw = receiptInput(envelope);
    raw.fingerprints.envelope = '9'.repeat(64);
    expect(() => compareWorkerEvidence({
      profile: 'portable',
      evidence: [evidenceFor(envelope, 'harness-a'), { envelope, receipt: raw }],
    })).toThrow(expect.objectContaining({ code: 'RECEIPT_ENVELOPE_MISMATCH' }));
  });

  test('native-ceiling profile preserves exact model+harness pairs with their native tuple inputs', () => {
    const firstEnvelope = normalizeWorkerEnvelope(envelopeInput({ executionProfile: 'native-ceiling' }));
    const secondEnvelope = normalizeWorkerEnvelope(envelopeInput({
      executionProfile: 'native-ceiling',
      prompt: { reference: 'prompt.native-b', fingerprint: '8'.repeat(64) },
      selection: {
        harness: { constraints: ['supports.patch', 'supports.tests'] },
        model: {
          provider: 'provider-a',
          id: 'model-b',
          version: 'native-2',
          digest: `sha256:${'7'.repeat(64)}`,
          constraints: ['tools'],
        },
      },
    }));
    const secondRaw = receiptInput(secondEnvelope);
    secondRaw.identity.harness = { name: 'harness-b', version: '2.0.0' };
    secondRaw.identity.adapter = { name: 'adapter-b', version: '2.0.0' };
    secondRaw.identity.model = {
      ...secondRaw.identity.model,
      name: 'model-b',
      version: 'native-2',
      digest: `sha256:${'7'.repeat(64)}`,
    };
    const report = compareWorkerEvidence({
      profile: 'native-ceiling',
      generatedAt: '2026-08-28T12:00:00.000Z',
      evidence: [
        evidenceFor(firstEnvelope, 'harness-a'),
        { envelope: secondEnvelope, receipt: normalizeWorkerReceipt(secondRaw, { envelope: secondEnvelope }) },
      ],
    });
    expect(report.portableBaselineFingerprint).toBeNull();
    expect(new Set(report.tuples.map((tuple) => tuple.nativePairFingerprint)).size).toBe(2);
    expect(report.tuples.map((tuple) => tuple.identity.model.name).sort()).toEqual(['model-a', 'model-b']);
    expect(report.policy).toMatchObject({
      nativeCeilingPreservesNativeOptimizations: true,
      crossTupleRanking: false,
    });
  });
});
