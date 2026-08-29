const readinessUi = require('../../public/js/chat/chat-model-readiness.js');

describe('chat model readiness helper', () => {
  it('builds labels that distinguish profiled and unprofiled models', () => {
    expect(readinessUi.buildOptionLabel({
      name: 'fast-model',
      readiness: { stage: 'profiled', profileDepth: 'standard', benchmarkQualified: true, stale: false }
    }, false)).toBe('fast-model - Profiled');

    expect(readinessUi.buildOptionLabel({
      name: 'mystery-model',
      readiness: { stage: 'available' }
    }, false)).toBe('mystery-model - Not profiled');
  });

  it('sorts ready models ahead of unprofiled models', () => {
    const models = [
      { name: 'zeta', readiness: { stage: 'available' } },
      { name: 'alpha', readiness: { stage: 'benchmarked' } },
      { name: 'beta', readiness: { stage: 'profiled' } }
    ];

    models.sort(readinessUi.compareForDropdown);

    expect(models.map((model) => model.name)).toEqual(['alpha', 'beta', 'zeta']);
  });

  it('disables unprofiled options when the hard gate is enabled', () => {
    const optionEl = {
      disabled: false,
      setAttribute: jest.fn()
    };

    readinessUi.applyOptionState(optionEl, {
      name: 'mystery-model',
      readiness: { stage: 'available' }
    }, true);

    expect(optionEl.disabled).toBe(true);
    expect(optionEl.textContent).toContain('Not profiled - blocked');
  });

  it('does not treat quick or stale evidence as chat-ready', () => {
    expect(readinessUi.getReadinessMeta({
      readiness: { stage: 'profiled', profileDepth: 'quick', benchmarkQualified: false, stale: false }
    }, true)).toMatchObject({ ready: false, blocked: true, label: 'Quick profile only' });

    expect(readinessUi.getReadinessMeta({
      readiness: { stage: 'profiled', profileDepth: 'standard', benchmarkQualified: true, stale: true }
    }, true)).toMatchObject({ ready: false, blocked: true, label: 'Profile stale' });
  });

  it('labels intentionally deferred evidence without claiming the model is unprofiled', () => {
    const model = {
      name: 'live-model',
      readiness: { stage: 'available', evidenceState: 'deferred' }
    };

    expect(readinessUi.getReadinessMeta(model, false)).toMatchObject({
      ready: false,
      blocked: false,
      label: 'Live on host'
    });
    expect(readinessUi.buildOptionLabel(model, false)).toBe('live-model - Live on host');
    expect(readinessUi.getReadinessMeta(model, true)).toMatchObject({
      blocked: true,
      label: 'Profile evidence required'
    });
  });

  it('offers the first selectable installed model without selecting it', () => {
    const options = [
      { value: '', textContent: 'Model chosen by mode', disabled: false },
      { value: 'blocked-model:latest', textContent: 'Blocked model', disabled: true },
      { value: 'qwen2.5:3b', textContent: 'qwen2.5:3b - Live on host', disabled: false }
    ];

    expect(readinessUi.findManualRecoveryCandidate(options)).toEqual({
      model: 'qwen2.5:3b',
      label: 'qwen2.5:3b - Live on host'
    });
    expect(options.every((option) => option.selected !== true)).toBe(true);
  });

  it('describes an explicit local Manual recovery without changing routing truth', () => {
    const recovery = readinessUi.describeManualRouteRecovery({
      mode: 'router',
      unavailableKind: 'route setup',
      routeModel: 'gemma4:26b-a4b-it-qat'
    }, 'Standard', [
      { value: '', textContent: 'Model chosen by mode', disabled: false },
      { value: 'qwen2.5:3b', textContent: 'qwen2.5:3b', disabled: false }
    ]);

    expect(recovery).toMatchObject({
      title: 'Standard route unavailable',
      actionLabel: 'Use qwen2.5:3b manually',
      candidate: { model: 'qwen2.5:3b' }
    });
    expect(recovery.detail).toContain('gemma4:26b-a4b-it-qat');
    expect(recovery.detail).toContain('switch chat to explicit Manual control and save that choice locally');
    expect(recovery.detail).toContain('configured Standard route will not be changed');
  });

  it('does not offer a model action outside the configured-route failure state', () => {
    expect(readinessUi.describeManualRouteRecovery({
      mode: 'router',
      unavailableKind: null
    }, 'Standard', [{ value: 'qwen2.5:3b', disabled: false }])).toBeNull();
  });

  it('routes users to Manual controls when no installed option is selectable', () => {
    const recovery = readinessUi.describeManualRouteRecovery({
      mode: 'router',
      unavailableKind: 'route setup',
      routeModel: 'missing-model'
    }, 'Standard', [
      { value: '', disabled: false },
      { value: 'profile-gated-model', disabled: true }
    ]);

    expect(recovery.candidate).toBeNull();
    expect(recovery.actionLabel).toBe('Review manual controls');
    expect(recovery.detail).toContain('No selectable installed model is listed');
  });
});
