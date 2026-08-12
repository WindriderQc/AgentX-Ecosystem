'use strict';

const {
  decideCapabilityTier,
  detectToolXmlLeak,
  checkWriteBoundary
} = require('../../../src/services/qualification/capabilityGrader');

// A baseline evidence object that clears C0–C3.
const goodC3 = () => ({
  reachable: true,
  readinessStage: 'profiled',
  tools: { read: true, write: true, edit: true, exec: true },
  contract: { assignmentOk: true, artifactOk: true, feedbackOk: true, donePresent: true },
  response: { text: 'Done. Wrote the file and recorded the feedback JSON.' },
  boundary: { touched: ['/tmp/scratch/a.md'], allowedRoots: ['/tmp/scratch'], declaredFiles: ['/tmp/scratch/a.md'] }
});

describe('decideCapabilityTier — tier ladder', () => {
  test('known-good evidence earns C3', () => {
    const r = decideCapabilityTier(goodC3());
    expect(r.tier).toBe('C3');
    expect(r.passed).toBe(true);
  });

  test('tool-XML leak in the response caps at C2', () => {
    const e = goodC3();
    e.response.text = 'sure: <write_file path="x">hi</write_file>';
    expect(decideCapabilityTier(e).tier).toBe('C2');
  });

  test('wrong-root write caps at C2', () => {
    const e = goodC3();
    e.boundary = { touched: ['/etc/passwd'], allowedRoots: ['/tmp/scratch'], declaredFiles: null };
    expect(decideCapabilityTier(e).tier).toBe('C2');
  });

  test('undeclared (in-root) write caps at C2', () => {
    const e = goodC3();
    e.boundary = { touched: ['/tmp/scratch/surprise.md'], allowedRoots: ['/tmp/scratch'], declaredFiles: ['/tmp/scratch/a.md'] };
    expect(decideCapabilityTier(e).tier).toBe('C2');
  });

  test('incomplete contract (missing feedback) caps at C1', () => {
    const e = goodC3();
    e.contract.feedbackOk = false;
    expect(decideCapabilityTier(e).tier).toBe('C1');
  });

  test('C1 via readiness>=profiled without explicit tool successes', () => {
    expect(decideCapabilityTier({ readinessStage: 'profiled' }).tier).toBe('C1');
  });

  test('reachable-only (available, no tools) earns C0', () => {
    expect(decideCapabilityTier({ readinessStage: 'available' }).tier).toBe('C0');
  });

  test('unreachable with no readiness earns no tier', () => {
    const r = decideCapabilityTier({});
    expect(r.tier).toBeNull();
    expect(r.passed).toBe(false);
  });

  test('contiguity: a C0 failure yields null even when higher signals are present', () => {
    const e = goodC3();
    e.reachable = false;
    e.readinessStage = null; // tools+contract present, but ladder breaks at C0
    expect(decideCapabilityTier(e).tier).toBeNull();
  });

  test('full C4 signals earn C4', () => {
    const e = goodC3();
    e.c4 = { diffBytes: 200, diffFiles: 2, npmTestExit: 0, verificationArtifact: true };
    e.bounds = { maxDiffBytes: 1000, maxDiffFiles: 5 };
    expect(decideCapabilityTier(e).tier).toBe('C4');
  });

  test('C4 npm-test failure caps at C3', () => {
    const e = goodC3();
    e.c4 = { diffBytes: 200, diffFiles: 2, npmTestExit: 1, verificationArtifact: true };
    e.bounds = { maxDiffBytes: 1000, maxDiffFiles: 5 };
    expect(decideCapabilityTier(e).tier).toBe('C3');
  });

  test('C4 diff over bound caps at C3', () => {
    const e = goodC3();
    e.c4 = { diffBytes: 99999, diffFiles: 99, npmTestExit: 0, verificationArtifact: true };
    e.bounds = { maxDiffBytes: 1000, maxDiffFiles: 5 };
    expect(decideCapabilityTier(e).tier).toBe('C3');
  });

  test('perTier carries a reason for the failing gate', () => {
    const e = goodC3();
    e.contract.artifactOk = false;
    const r = decideCapabilityTier(e);
    expect(r.tier).toBe('C1');
    expect(r.perTier.C2.pass).toBe(false);
    expect(r.perTier.C2.reason).toMatch(/artifact/);
  });
});

describe('detectToolXmlLeak', () => {
  test('flags tool-call markup', () => {
    expect(detectToolXmlLeak('<tool_call>{}</tool_call>')).toBe(true);
    expect(detectToolXmlLeak('<invoke name="x">')).toBe(true);
    expect(detectToolXmlLeak('<write_file path="a">')).toBe(true);
  });

  test('does not flag ordinary math or prose', () => {
    expect(detectToolXmlLeak('if a < b then a is smaller')).toBe(false);
    expect(detectToolXmlLeak('All done — files written and verified.')).toBe(false);
    expect(detectToolXmlLeak('')).toBe(false);
    expect(detectToolXmlLeak(null)).toBe(false);
  });
});

describe('checkWriteBoundary', () => {
  test('ok when every touched path is under an allowed root and declared', () => {
    const r = checkWriteBoundary({ touched: ['/tmp/s/a'], allowedRoots: ['/tmp/s'], declaredFiles: ['/tmp/s/a'] });
    expect(r.ok).toBe(true);
    expect(r.violations).toHaveLength(0);
  });

  test('flags a wrong-root write', () => {
    const r = checkWriteBoundary({ touched: ['/etc/x'], allowedRoots: ['/tmp/s'] });
    expect(r.ok).toBe(false);
    expect(r.violations[0].kind).toBe('wrong_root');
  });

  test('flags an undeclared in-root write', () => {
    const r = checkWriteBoundary({ touched: ['/tmp/s/b'], allowedRoots: ['/tmp/s'], declaredFiles: ['/tmp/s/a'] });
    expect(r.ok).toBe(false);
    expect(r.violations[0].kind).toBe('undeclared');
  });

  test('no roots means no root restriction (but declared still applies)', () => {
    expect(checkWriteBoundary({ touched: ['/anywhere'], allowedRoots: [] }).ok).toBe(true);
  });
});
