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
});
