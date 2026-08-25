'use strict';

const {
  ROUTE_DECISION_VERSION,
  REJECTION_REASONS,
  DECISION_MODES,
  buildRouteDecision,
  characterizeRouteRequest,
  fingerprintRuntimeOptions,
  assertNoPayload,
} = require('../../src/services/routing/routeDecision');
const { decisionForTelemetry, sanitizedRouteDecision } = require('../../src/services/routing/inferenceTelemetry');

describe('RouteDecision v1 contract (0519)', () => {
  test('carries every contract field with stable names', () => {
    const decision = buildRouteDecision({
      configVersion: 'router-2026-08-08',
      correlationId: 'corr-abc',
      decidedAt: new Date('2026-08-08T12:00:00Z'),
      caller: 'chat',
      callerDetail: 'nestor/panel/ask',
      service: 'core',
      runtime: 'external',
      agentId: 'client-42',
      consumerContract: 'nestor-v1',
      workItemId: '0519',
      taskType: 'daily_operator',
      profile: 'answer_light',
      mode: DECISION_MODES.EXPLICIT_TASK,
      requestedModel: 'ax/gemma4:26b-a4b-it-qat',
      primaryModel: 'ax/gemma4:26b-a4b-it-qat',
      primaryHost: 'primary',
      selectedModel: 'ax/gemma4:26b-a4b-it-qat',
      selectedHost: 'primary',
      selectedHostUrl: 'http://192.0.2.199:11434',
      rejections: [{ model: 'ax/gemma4:31b-it-qat', host: 'primary', reason: REJECTION_REASONS.INSUFFICIENT_VRAM }],
      runtimeOptions: { num_ctx: 83558, temperature: 0.2 },
      attempt: 2,
      classificationMs: 12,
      decisionMs: 3,
      totalMs: 1500,
    });

    expect(decision.decisionVersion).toBe(ROUTE_DECISION_VERSION);
    expect(decision.configVersion).toBe('router-2026-08-08');
    expect(decision.correlationId).toBe('corr-abc');
    expect(decision.decidedAt).toBe('2026-08-08T12:00:00.000Z');

    expect(decision.attribution).toMatchObject({
      caller: 'chat',
      callerDetail: 'nestor/panel/ask',
      service: 'core',
      runtime: 'external',
      agentId: 'client-42',
      consumerContract: 'nestor-v1',
      workItemId: '0519',
    });
    expect(decision.intent).toMatchObject({
      taskType: 'daily_operator',
      profile: 'answer_light',
      mode: 'explicit_task',
    });
    expect(decision.selected).toMatchObject({ model: 'ax/gemma4:26b-a4b-it-qat', host: 'primary' });
    expect(decision.rejections).toEqual([
      expect.objectContaining({ model: 'ax/gemma4:31b-it-qat', reason: 'insufficient_vram' }),
    ]);
    expect(decision.attempt).toBe(2);
    expect(decision.latency).toEqual({ classificationMs: 12, decisionMs: 3, totalMs: 1500 });
    expect(typeof decision.optionsFingerprint).toBe('string');
  });

  test('actual defaults to selected, and diverging from it means fallback', () => {
    // No fallback: consumers must not have to re-derive "actual == selected".
    const clean = buildRouteDecision({
      selectedModel: 'a', selectedHost: 'primary', selectedHostUrl: 'http://p:11434',
    });
    expect(clean.actual).toEqual(clean.selected);
    expect(clean.fallbackUsed).toBe(false);

    // Divergence is itself the signal — a caller that forgets the flag still
    // produces a correctly-labelled fallback.
    const fellBack = buildRouteDecision({
      selectedModel: 'a', selectedHost: 'primary', selectedHostUrl: 'http://p:11434',
      actualModel: 'b', actualHost: 'secondary', actualHostUrl: 'http://s:11434',
    });
    expect(fellBack.fallbackUsed).toBe(true);
    expect(fellBack.selected.model).toBe('a');
    expect(fellBack.actual.model).toBe('b');
  });

  test('unknown rejection reasons degrade to `unknown` rather than inventing a label', () => {
    const decision = buildRouteDecision({
      selectedModel: 'a',
      rejections: [{ model: 'b', reason: 'because-i-said-so' }, { model: 'c' }],
    });
    expect(decision.rejections.map((r) => r.reason)).toEqual(['unknown', 'unknown']);
  });

  test('option fingerprints are order-independent and change with values', () => {
    const a = fingerprintRuntimeOptions({ num_ctx: 8192, temperature: 0.2 });
    const b = fingerprintRuntimeOptions({ temperature: 0.2, num_ctx: 8192 });
    const c = fingerprintRuntimeOptions({ num_ctx: 65536, temperature: 0.2 });

    expect(a).toBe(b);          // key order is not a behaviour change
    expect(a).not.toBe(c);      // a num_ctx change is (it rebuilds the runner)
    expect(fingerprintRuntimeOptions({})).toMatch(/^[a-f0-9]{16}$/);
    expect(fingerprintRuntimeOptions(null)).toBe(fingerprintRuntimeOptions({}));
  });

  test('the telemetry writer backfills routing and options provenance instead of persisting nulls', () => {
    const decision = sanitizedRouteDecision(buildRouteDecision({ selectedModel: 'model:1' }));
    expect(decision.configVersion).toMatch(/^router-(?:[a-f0-9]{16}|unversioned-v1)$/);
    expect(decision.optionsFingerprint).toMatch(/^[a-f0-9]{16}$/);
  });

  test('the telemetry writer synthesizes provenance when a caller supplies no route decision', () => {
    const decision = decisionForTelemetry({
      caller: 'proxy',
      callerDetail: 'openclaw-runtime-bridge',
      model: 'model:1',
      host: 'http://primary:11434',
      runtimeOptions: { num_ctx: 262144 },
      durationMs: 180000
    });

    expect(decision).toMatchObject({
      attribution: { caller: 'proxy', callerDetail: 'openclaw-runtime-bridge' },
      actual: { model: 'model:1', hostUrl: 'http://primary:11434' },
      latency: { totalMs: 180000 }
    });
    expect(decision.configVersion).toMatch(/^router-(?:[a-f0-9]{16}|unversioned-v1)$/);
    expect(decision.optionsFingerprint).toMatch(/^[a-f0-9]{16}$/);
  });

  describe('privacy guarantee', () => {
    test.each([
      ['prompt', { prompt: 'secret question' }],
      ['messages', { messages: [{ role: 'user' }] }],
      ['nested completion', { intent: { completion: 'secret answer' } }],
      ['deeply nested transcript', { a: { b: { c: { transcript: 'secret' } } } }],
      ['inside an array', { rejections: [{ reason: 'x', content: 'secret' }] }],
    ])('assertNoPayload rejects %s', (_label, payload) => {
      expect(() => assertNoPayload(payload)).toThrow(
        expect.objectContaining({ code: 'ROUTE_DECISION_PAYLOAD_LEAK' })
      );
    });

    test('a built decision never contains a forbidden key', () => {
      const decision = buildRouteDecision({
        selectedModel: 'a',
        caller: 'chat',
        runtimeOptions: { num_ctx: 4096 },
      });
      expect(() => assertNoPayload(decision)).not.toThrow();
    });
  });
});

describe('characterizing the existing routeRequest paths (0519)', () => {
  // The four shapes routeRequest returns today. 0519 requires these be
  // describable without changing selection, so each is asserted against the
  // literal object that branch produces.
  const context = { caller: 'chat', correlationId: 'corr-1' };

  test('explicit preferred model', () => {
    const decision = characterizeRouteRequest({
      model: 'ax/qwen3-coder:30b', target: 'http://192.0.2.199:11434', taskType: 'user_specified',
      routed: false, autoRouted: false, classificationMs: 0, host: 'primary',
    }, context);

    expect(decision.intent.mode).toBe('explicit_model');
    expect(decision.requested.model).toBe('ax/qwen3-coder:30b');
    expect(decision.selected.model).toBe('ax/qwen3-coder:30b');
    expect(decision.degraded).toBe(false);
  });

  test('explicit task type', () => {
    const decision = characterizeRouteRequest({
      model: 'ax/gemma4:26b-a4b-it-qat', target: 'http://192.0.2.199:11434',
      taskType: 'code_generation', routed: true, autoRouted: false, classificationMs: 0, host: 'primary',
    }, context);

    expect(decision.intent.mode).toBe('explicit_task');
    expect(decision.intent.taskType).toBe('code_generation');
  });

  test('classifier auto-routing records its classification cost', () => {
    const decision = characterizeRouteRequest({
      model: 'ax/gemma4:e4b', target: 'http://192.0.2.12:11434', taskType: 'general_chat',
      routed: true, autoRouted: true, classificationMs: 87, host: 'secondary',
    }, context);

    expect(decision.intent.mode).toBe('classified');
    expect(decision.latency.classificationMs).toBe(87);
  });

  test('front-door default', () => {
    const decision = characterizeRouteRequest({
      model: 'qwen3:8b', target: 'http://192.0.2.12:11434', taskType: 'default',
      routed: false, autoRouted: false, classificationMs: 0, host: 'secondary',
    }, context);

    expect(decision.intent.mode).toBe('default');
  });

  test('a host mid-swap becomes a named degraded state with a rejection reason', () => {
    // The old shape only hinted at this with a loose `hostBusy` boolean, which
    // nothing could alert on.
    const decision = characterizeRouteRequest({
      model: 'ax/qwen3-coder:30b', target: 'http://192.0.2.199:11434', taskType: 'user_specified',
      routed: false, autoRouted: false, classificationMs: 0, host: 'primary',
      hostBusy: true, hostStatus: 'swapping',
    }, context);

    expect(decision.degraded).toBe(true);
    expect(decision.degradedReason).toBe('host_swapping');
    expect(decision.rejections).toEqual([
      expect.objectContaining({ reason: REJECTION_REASONS.HOST_BUSY }),
    ]);
  });

  test('every path yields the same shape, so consumers need no branch checks', () => {
    const shapes = [
      { taskType: 'user_specified' },
      { taskType: 'code_generation', routed: true },
      { taskType: 'general_chat', routed: true, autoRouted: true },
      { taskType: 'default' },
    ].map((result) => characterizeRouteRequest({ model: 'm', host: 'primary', ...result }, context));

    const keys = shapes.map((d) => Object.keys(d).sort().join(','));
    expect(new Set(keys).size).toBe(1);
    expect(shapes.every((d) => d.decisionVersion === ROUTE_DECISION_VERSION)).toBe(true);
    expect(shapes.every((d) => d.attribution.caller === 'chat')).toBe(true);
  });
});
