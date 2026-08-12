const readinessUi = require('../../public/js/chat/chat-model-readiness.js');

describe('chat model readiness helper', () => {
  it('builds labels that distinguish profiled and unprofiled models', () => {
    expect(readinessUi.buildOptionLabel({
      name: 'fast-model',
      readiness: { stage: 'profiled' }
    }, false)).toBe('fast-model - Profiled');

    expect(readinessUi.buildOptionLabel({
      name: 'mystery-model',
      readiness: { stage: 'available' }
    }, false)).toBe('mystery-model - Not profiled');
  });

  it('sorts ready models ahead of unprofiled models', () => {
    const models = [
      { name: 'zeta', readiness: { stage: 'available' } },
      { name: 'alpha', readiness: { stage: 'adapted' } },
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
});
