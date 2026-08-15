'use strict';

const {
  EVIDENCE,
  UNKNOWN_REASONS,
  sanitizeIdentity,
  summarizeIdentityUse,
  retirementEvidence,
} = require('../../src/services/identityUseService');

/** Stand-in for the InferenceLog model — only `aggregate` is used. */
function fakeModel(rowsByCall) {
  const calls = [];
  return {
    calls,
    aggregate: jest.fn(async (pipeline) => {
      calls.push(pipeline);
      const next = rowsByCall.shift();
      if (next instanceof Error) throw next;
      return next || [];
    }),
  };
}

const NOW = new Date('2026-08-09T00:00:00Z');

describe('identity sanitization (0529)', () => {
  test('reduces a caller path to its leading identity segment', () => {
    // `nestor/panel/ask` is one identity plus operation detail. Keeping the
    // detail would fragment the aggregate into near-duplicates and widen what
    // the report exposes.
    expect(sanitizeIdentity('nestor/panel/ask')).toBe('nestor');
    expect(sanitizeIdentity('clawdx-coder:0529')).toBe('clawdx-coder');
    expect(sanitizeIdentity('  LeadX  ')).toBe('leadx');
  });

  test('strips unexpected characters and bounds length', () => {
    expect(sanitizeIdentity('weird$$name!!')).toBe('weird--name--');
    expect(sanitizeIdentity('x'.repeat(200))).toHaveLength(64);
    expect(sanitizeIdentity(null)).toBeNull();
    expect(sanitizeIdentity('   ')).toBeNull();
  });
});

describe('identity use evidence (0529)', () => {
  test('measures identities inside the retention window', async () => {
    const model = fakeModel([
      [{ _id: { caller: 'chat', callerDetail: 'nestor/panel/ask', runtime: 'agentx' }, count: 4, lastSeen: NOW }],
      [{ _id: { caller: 'chat', callerDetail: 'nestor/panel/ask', runtime: 'agentx' }, count: 9, lastSeen: NOW }],
    ]);

    const summary = await summarizeIdentityUse({ windows: [7, 30], now: NOW, model });
    const nestor = summary.identities.find((i) => i.identity === 'nestor');

    expect(nestor.windows[7]).toMatchObject({ status: EVIDENCE.MEASURED, count: 4 });
    expect(nestor.windows[30]).toMatchObject({ status: EVIDENCE.MEASURED, count: 9 });
    expect(nestor.runtimes).toEqual(['agentx']);
  });

  test('a window longer than retention is unknown, never zero', async () => {
    // The trap this module exists for. InferenceLog has a 30-day TTL, so a
    // 90-day query returns nothing — and "0 uses in 90 days" would be a lie
    // that argues for retiring a live identity.
    const model = fakeModel([[], []]);
    const summary = await summarizeIdentityUse({ windows: [7, 30, 90], now: NOW, model });

    expect(summary.retentionDays).toBe(30);
    expect(summary.unanswerableWindows).toEqual([90]);
    // The 90-day window is never even queried — asking is what produces the zero.
    expect(model.aggregate).toHaveBeenCalledTimes(2);
  });

  test('the 90-day answer is unknown for every identity', async () => {
    const model = fakeModel([
      [{ _id: { caller: 'chat', callerDetail: 'client-42', runtime: 'external' }, count: 1, lastSeen: NOW }],
      [{ _id: { caller: 'chat', callerDetail: 'client-42', runtime: 'external' }, count: 1, lastSeen: NOW }],
    ]);
    const summary = await summarizeIdentityUse({ windows: [7, 30, 90], now: NOW, model });
    const leadx = summary.identities.find((i) => i.identity === 'client-42');

    expect(leadx.windows[90]).toMatchObject({
      status: EVIDENCE.UNKNOWN,
      reason: UNKNOWN_REASONS.WINDOW_EXCEEDS_RETENTION,
      count: null,
    });
    // `count: null`, not 0 — there is no number to report.
    expect(leadx.windows[90].count).not.toBe(0);
  });

  test('a source failure makes that window unknown for every identity', async () => {
    // Including identities first discovered by a *later* window, which is why
    // the marking is applied after the loop rather than inside the catch.
    const model = fakeModel([
      new Error('mongo unreachable'),
      [{ _id: { caller: 'chat', callerDetail: 'codex', runtime: 'codex' }, count: 3, lastSeen: NOW }],
    ]);

    const summary = await summarizeIdentityUse({ windows: [7, 30], now: NOW, model });
    const codex = summary.identities.find((i) => i.identity === 'codex');

    expect(codex.windows[7]).toMatchObject({
      status: EVIDENCE.UNKNOWN,
      reason: UNKNOWN_REASONS.SOURCE_UNAVAILABLE,
      count: null,
    });
    expect(codex.windows[30]).toMatchObject({ status: EVIDENCE.MEASURED, count: 3 });
  });

  test('an identity with no rows is genuinely measured as zero', async () => {
    // The counterpart: when the source answered and the identity simply is not
    // in it, that IS a finding. Only absent evidence is unknown.
    const model = fakeModel([[], []]);
    const summary = await summarizeIdentityUse({ windows: [7, 30], now: NOW, model });
    expect(summary.identities).toEqual([]);
  });
});

describe('retirement evidence (0529)', () => {
  const measured = (count) => ({ windows: { 30: { windowDays: 30, status: EVIDENCE.MEASURED, count } } });

  test('zero measured uses is evidence for retirement', () => {
    expect(retirementEvidence(measured(0), 30)).toMatchObject({
      verdict: EVIDENCE.MEASURED, safeToRetire: true, unusedFor: 30,
    });
  });

  test('recent use blocks retirement', () => {
    expect(retirementEvidence(measured(12), 30)).toMatchObject({
      verdict: EVIDENCE.MEASURED, safeToRetire: false,
    });
  });

  test.each([
    ['unknown window', { windows: { 30: { status: EVIDENCE.UNKNOWN, reason: UNKNOWN_REASONS.WINDOW_EXCEEDS_RETENTION } } }],
    ['missing window', { windows: {} }],
    ['missing entry', undefined],
  ])('%s is never permission to retire', (_label, entry) => {
    // Consolidation must be blocked by absence of evidence, not enabled by it.
    expect(retirementEvidence(entry, 30)).toMatchObject({
      verdict: EVIDENCE.UNKNOWN, safeToRetire: false,
    });
  });
});
