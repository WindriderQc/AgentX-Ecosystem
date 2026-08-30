'use strict';

const {
  ROUTE_DECISION_VERSION,
  REJECTION_REASONS,
  DECISION_MODES,
  ROUTE_OUTCOME_CODES,
  ROUTE_OUTCOME_STAGES,
  buildRouteDecision,
  finalizeRouteDecision,
  characterizeRouteRequest,
  fingerprintRuntimeOptions,
  assertNoPayload,
} = require('../../src/services/routing/routeDecision');
const {
  decisionForTelemetry,
  sanitizedRouteDecision,
  sanitizeRoutingTrace,
} = require('../../src/services/routing/inferenceTelemetry');
const { projectInferenceLog } = require('../../src/services/routing/inferenceLogReadProjection');

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
      selectionSource: 'scheduler',
      requestedPolicy: 'nestor',
      effectivePolicy: 'unknown',
      effectiveLane: 'automated',
      policyDowngraded: true,
      outcomeStage: ROUTE_OUTCOME_STAGES.EXECUTION,
      outcomeCode: ROUTE_OUTCOME_CODES.ROUTE_SELECTED,
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
    expect(decision.selectionSource).toBe('scheduler');
    expect(decision.policy).toEqual({
      requested: 'nestor',
      effective: 'unknown',
      lane: 'automated',
      downgraded: true,
    });
    expect(decision.outcome).toEqual({
      stage: 'execution',
      code: 'route_selected',
      reasonCode: null,
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

  test('unknown outcome values degrade to stable unknowns', () => {
    const decision = buildRouteDecision({
      outcomeStage: 'made-up-stage',
      outcomeCode: 'made-up-code',
      outcomeReasonCode: 'bounded-detail',
    });
    expect(decision.outcome).toEqual({
      stage: ROUTE_OUTCOME_STAGES.UNKNOWN,
      code: ROUTE_OUTCOME_CODES.UNKNOWN,
      reasonCode: null,
    });
  });

  test('keeps the closed retry execution failure reason code', () => {
    const decision = buildRouteDecision({
      outcomeStage: ROUTE_OUTCOME_STAGES.FALLBACK,
      outcomeCode: ROUTE_OUTCOME_CODES.FALLBACK_REFUSED,
      outcomeReasonCode: 'retry_execution_failed',
    });
    expect(decision.outcome.reasonCode).toBe('retry_execution_failed');
  });

  test.each([
    ['success', ROUTE_OUTCOME_CODES.EXECUTION_SUCCEEDED],
    ['error', ROUTE_OUTCOME_CODES.UPSTREAM_ERROR],
    ['timeout', ROUTE_OUTCOME_CODES.UPSTREAM_TIMEOUT],
  ])('terminalizes a selection decision after %s', (status, code) => {
    const selected = buildRouteDecision({
      selectedModel: 'model:1',
      outcomeStage: ROUTE_OUTCOME_STAGES.SELECTION,
      outcomeCode: ROUTE_OUTCOME_CODES.ROUTE_SELECTED,
    });
    const terminal = finalizeRouteDecision(selected, {
      status,
      durationMs: 1234,
      reasonCode: status === 'success' ? null : 'OLLAMA_UPSTREAM_ERROR',
    });

    expect(terminal.outcome).toEqual({
      stage: ROUTE_OUTCOME_STAGES.EXECUTION,
      code,
      reasonCode: status === 'success' ? null : 'ollama_upstream_error',
    });
    expect(terminal.latency.totalMs).toBe(1234);
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

  test('option fingerprints ignore content-bearing and non-scalar option values', () => {
    const baseline = fingerprintRuntimeOptions({ temperature: 0.2 });
    expect(fingerprintRuntimeOptions({ temperature: 0.2, stop: ['secret-a'] })).toBe(baseline);
    expect(fingerprintRuntimeOptions({ temperature: 0.2, grammar: 'secret-b' })).toBe(baseline);
    expect(fingerprintRuntimeOptions({ stop: ['secret-a'] }))
      .toBe(fingerprintRuntimeOptions({ stop: ['different-secret'] }));
  });

  test('the telemetry writer backfills routing and options provenance instead of persisting nulls', () => {
    const decision = sanitizedRouteDecision(buildRouteDecision({ selectedModel: 'model:1' }));
    expect(decision.configVersion).toMatch(/^router-(?:[a-f0-9]{16}|unversioned-v1)$/);
    expect(decision.optionsFingerprint).toMatch(/^[a-f0-9]{16}$/);
  });

  test('the telemetry writer drops secret-bearing host targets before persistence', () => {
    const secret = 'sk-private-token-123';
    const hostileUrl = `http://primary:11434/${secret}?token=${secret}`;
    const decision = sanitizedRouteDecision({
      decisionVersion: 1,
      requested: { host: hostileUrl, hostUrl: hostileUrl },
      primary: { host: `/private/${secret}`, hostUrl: hostileUrl },
      selected: { model: 'model:1', host: hostileUrl, hostUrl: hostileUrl },
      actual: { model: 'model:1', host: hostileUrl, hostUrl: hostileUrl },
      rejections: [{ host: hostileUrl, hostUrl: hostileUrl, reason: 'host_offline' }],
    });

    expect(JSON.stringify(decision)).not.toContain(secret);
    for (const target of [
      decision.requested, decision.primary, decision.selected, decision.actual,
      decision.rejections[0]
    ]) {
      expect(target.host).toBeNull();
      expect(target.hostUrl).toBeNull();
    }

    const dotSegmentDecision = sanitizedRouteDecision({
      decisionVersion: 1,
      selected: {
        model: 'model:1',
        host: 'primary',
        hostUrl: `http://primary:11434/${secret}/..`,
      },
      actual: {
        model: 'model:1',
        host: 'primary',
        hostUrl: `http://primary:11434/${secret}/%2e%2e`,
      },
    });
    expect(JSON.stringify(dotSegmentDecision)).not.toContain(secret);
    expect(dotSegmentDecision.selected.hostUrl).toBe('http://primary:11434');
    expect(dotSegmentDecision.actual.hostUrl).toBe('http://primary:11434');
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

    test('legacy routing traces retain evidence but strip payload and raw option values', () => {
      const secret = 'ROUTE_TRACE_SECRET_FIXTURE_7d9f';
      const sanitized = sanitizeRoutingTrace({
        request: {
          requestedModel: 'model:1',
          preview: {
            prompt: { chars: secret.length, preview: secret },
            system: { chars: secret.length, preview: secret },
            messages: [{ role: 'user', chars: secret.length, preview: secret }],
          },
        },
        selected: { routingSource: 'model_router' },
        ollama: {
          endpoint: '/api/generate',
          think: secret,
          keepAlive: secret,
          options: { stop: [secret], temperature: 0.2 },
        },
      });

      expect(JSON.stringify(sanitized)).not.toContain(secret);
      expect(sanitized.request).not.toHaveProperty('preview');
      expect(sanitized.ollama).not.toHaveProperty('options');
      expect(sanitized.ollama).not.toHaveProperty('think');
      expect(sanitized.ollama).not.toHaveProperty('keepAlive');
      expect(sanitized.ollama.optionsFingerprint).toMatch(/^[a-f0-9]{16}$/);
      expect(sanitized.selected.routingSource).toBe('model_router');
    });

    test('routing traces drop hostile unrecognized keys at every depth', () => {
      const secret = 'HOSTILE_TRACE_SECRET_5a91';
      const sanitized = sanitizeRoutingTrace({
        payload: secret,
        request: {
          requestedModel: 'model:1',
          query: secret,
          requestBody: { instruction: secret },
          summary: {
            mode: 'generate',
            promptChars: 12,
            options: { stop: [secret], temperature: 0.2 },
            hostile: secret,
          },
        },
        selected: { routingSource: 'model_router', hostile: secret },
        ollama: { endpoint: '/api/generate', options: { stop: [secret] }, payload: secret },
      });

      expect(JSON.stringify(sanitized)).not.toContain(secret);
      expect(sanitized.request).not.toHaveProperty('query');
      expect(sanitized.request).not.toHaveProperty('requestBody');
      expect(sanitized.request.summary).not.toHaveProperty('hostile');
      expect(sanitized.selected).not.toHaveProperty('hostile');
      expect(sanitized.ollama).not.toHaveProperty('payload');
      expect(sanitized.request.summary.optionsFingerprint).toMatch(/^[a-f0-9]{16}$/);
      expect(sanitized.ollama.optionsFingerprint).toMatch(/^[a-f0-9]{16}$/);
    });

    test('routing traces drop legacy prose even when it resembles a stable identifier', () => {
      const hostile = [
        'legacypayloadsecret',
        'secret@example.test',
        '/private/customer/path',
        'sk-private-token-123',
      ];
      const sanitized = sanitizeRoutingTrace({
        request: { callerDetail: hostile[0], requestedModel: 'model:1' },
        recommendation: {
          model: 'model:1', source: 'scheduler', reason: hostile[1],
          scheduler: {
            host: 'primary', reason: hostile[2], warnings: hostile,
            scored: [{ host: 'primary', score: 4, reasons: hostile }],
          },
        },
        difference: { differsFromRecommendation: true, reasons: hostile },
      });

      const encoded = JSON.stringify(sanitized);
      hostile.forEach((secret) => expect(encoded).not.toContain(secret));
      expect(sanitized.request.callerDetail).toBeNull();
      expect(sanitized.recommendation.reason).toBeNull();
      expect(sanitized.recommendation.scheduler.reason).toBeNull();
      expect(sanitized.recommendation.scheduler.warnings).toEqual([]);
      expect(sanitized.recommendation.scheduler.scored[0].reasons).toEqual([]);
      expect(sanitized.difference.reasons).toEqual([]);
    });

    test('legacy decisions expose only semantic codes and validated fingerprints', () => {
      const secret = 'legacypayloadsecret';
      const projected = projectInferenceLog({
        _id: 'legacy-row',
        routeDecision: {
          decidedAt: 'not-a-date',
          selectionSource: secret,
          optionsFingerprint: secret,
          fallbackReason: secret,
          degradedReason: secret,
          outcome: { stage: 'execution', code: 'upstream_error', reasonCode: secret },
          selected: { model: 'model:1', host: 'primary', hostUrl: 'http://primary:11434' },
        },
      });

      expect(JSON.stringify(projected)).not.toContain(secret);
      expect(projected.routeDecision.selectionSource).toBeNull();
      expect(projected.routeDecision.optionsFingerprint).toBeNull();
      expect(projected.routeDecision.decidedAt).toBeNull();
      expect(projected.routeDecision.fallbackReason).toBeNull();
      expect(projected.routeDecision.outcome.reasonCode).toBeNull();
    });

    test('public log projection preserves cancellation classification without its prose', () => {
      const secret = 'private caller cancellation detail';
      const projected = projectInferenceLog({
        status: 'error',
        error: `Inference request cancelled: ${secret}`,
        timestamp: '2026-08-28T12:00:00.000Z',
      });

      expect(projected).toEqual(expect.objectContaining({
        status: 'error',
        error: null,
        cancelled: true,
      }));
      expect(JSON.stringify(projected)).not.toContain(secret);
    });

    test('public log projection rejects secret-bearing URL paths and caller detail', () => {
      const secret = 'sk-private-token-123';
      const hostileOrigin = `http://primary:11434/${secret}`;
      const hostileEndpoint = `http://primary:11434/api/generate/${secret}`;
      const projected = projectInferenceLog({
        host: hostileOrigin,
        hostKey: `/private/${secret}`,
        callerDetail: secret,
        routedHost: `http://primary/${secret}`,
        routedHostUrl: hostileOrigin,
        routingTrace: {
          request: { hostOverride: hostileOrigin },
          configured: { host: `/private/${secret}`, hostUrl: hostileOrigin },
          recommendation: {
            source: 'scheduler',
            hostUrl: hostileOrigin,
            scheduler: { hostUrl: hostileOrigin },
          },
          selected: {
            hostKey: `http://primary/${secret}`,
            hostUrl: hostileOrigin,
            routingSource: 'model_router',
          },
          inferenceContract: { artifact: { host: hostileOrigin } },
          ollama: { endpoint: '/api/generate', url: hostileEndpoint },
        },
        routeDecision: {
          decidedAt: '2026-08-28T12:00:00.000Z',
          attribution: { caller: 'proxy', callerDetail: secret, service: 'core' },
          selected: {
            model: 'model:1', host: `http://primary/${secret}`, hostUrl: hostileOrigin,
          },
          actual: {
            model: 'model:1', host: `/private/${secret}`, hostUrl: hostileOrigin,
          },
        },
      });

      expect(JSON.stringify(projected)).not.toContain(secret);
      expect(projected.host).toBeNull();
      expect(projected.hostKey).toBeNull();
      expect(projected.callerDetail).toBeNull();
      expect(projected.routedHost).toBeNull();
      expect(projected.routedHostUrl).toBeNull();
      expect(projected.routingTrace.request.hostOverride).toBeNull();
      expect(projected.routingTrace.configured.host).toBeNull();
      expect(projected.routingTrace.configured.hostUrl).toBeNull();
      expect(projected.routingTrace.recommendation.hostUrl).toBeNull();
      expect(projected.routingTrace.recommendation.scheduler.hostUrl).toBeNull();
      expect(projected.routingTrace.selected.hostUrl).toBeNull();
      expect(projected.routingTrace.selected.hostKey).toBeNull();
      expect(projected.routingTrace.inferenceContract.artifact.host).toBeNull();
      expect(projected.routingTrace.ollama.url).toBeNull();
      expect(projected.routeDecision.attribution.callerDetail).toBeNull();
      expect(projected.routeDecision.selected.host).toBeNull();
      expect(projected.routeDecision.selected.hostUrl).toBeNull();
      expect(projected.routeDecision.actual.host).toBeNull();
      expect(projected.routeDecision.actual.hostUrl).toBeNull();

      const valid = projectInferenceLog({
        host: 'http://primary:11434',
        routedHostUrl: 'http://secondary:11434/',
        routingTrace: {
          selected: { hostUrl: 'http://primary:11434', routingSource: 'model_router' },
          ollama: {
            endpoint: '/api/generate',
            url: 'http://primary:11434/api/generate',
          },
        },
      });
      expect(valid.host).toBe('http://primary:11434');
      expect(valid.routedHostUrl).toBe('http://secondary:11434');
      expect(valid.routingTrace.selected.hostUrl).toBe('http://primary:11434');
      expect(valid.routingTrace.ollama.url).toBe('http://primary:11434/api/generate');

      const dotSecret = 'DOTSEG_SECRET_9f2a';
      const dotSegments = projectInferenceLog({
        host: `http://primary:11434/${dotSecret}/..`,
        routedHostUrl: `http://primary:11434/${dotSecret}/%2e%2e`,
        routingTrace: {
          selected: {
            routingSource: 'model_router',
            hostUrl: `http://primary:11434/${dotSecret}/..`,
          },
          ollama: {
            endpoint: '/api/generate',
            url: `http://primary:11434/${dotSecret}/../api/generate`,
          },
        },
        routeDecision: {
          decidedAt: '2026-08-28T12:00:00.000Z',
          selected: {
            model: 'model:1', host: 'primary',
            hostUrl: `http://primary:11434/${dotSecret}/%2e%2e`,
          },
        },
      });
      expect(JSON.stringify(dotSegments)).not.toContain(dotSecret);
      expect(dotSegments.host).toBe('http://primary:11434');
      expect(dotSegments.routedHostUrl).toBe('http://primary:11434');
      expect(dotSegments.routingTrace.selected.hostUrl).toBe('http://primary:11434');
      expect(dotSegments.routingTrace.ollama.url).toBe('http://primary:11434/api/generate');
      expect(dotSegments.routeDecision.selected.hostUrl).toBe('http://primary:11434');
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
