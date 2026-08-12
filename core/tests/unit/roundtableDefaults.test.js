const {
  DEFAULT_PANEL,
  DEFAULT_SYNTHESIZER,
  COUNCIL_ADVISORY_GUARD,
  withCouncilAdvisoryGuard
} = require('../../src/services/roundtable/defaults');

describe('roundtable defaults', () => {
  it('uses the registered Qwen Q5 model for the pragmatic panelists', () => {
    const devil = DEFAULT_PANEL.find(panelist => panelist.agentId === 'devils-advocate');
    const pragmatist = DEFAULT_PANEL.find(panelist => panelist.agentId === 'pragmatist');

    expect(devil.model).toBe('ax/qwen2.5:7b-instruct-q5_K_M');
    expect(pragmatist.model).toBe('ax/qwen2.5:7b-instruct-q5_K_M');
    expect(DEFAULT_PANEL.map(panelist => panelist.model)).not.toContain(
      'qwen2.5:7b-instruct-q4_0'
    );
  });

  it('keeps the large model warm for synthesis', () => {
    const finalPanelist = DEFAULT_PANEL[DEFAULT_PANEL.length - 1];

    expect(finalPanelist.agentId).toBe('visionary');
    expect(finalPanelist.model).toBe(DEFAULT_SYNTHESIZER.model);
  });

  it('appends the non-overridable advisory boundary after participant prompts', () => {
    const guarded = withCouncilAdvisoryGuard('Challenge the proposal.');

    expect(guarded).toBe(`Challenge the proposal.\n\n${COUNCIL_ADVISORY_GUARD}`);
    expect(guarded).toContain('has no approval, authorization, tool-use, deployment, or execution authority');
    expect(guarded.endsWith(COUNCIL_ADVISORY_GUARD)).toBe(true);
  });

  it('tells the default synthesizer to honor an explicit answer format', () => {
    expect(DEFAULT_SYNTHESIZER.systemPrompt).toContain('output format or length constraint');
    expect(DEFAULT_SYNTHESIZER.systemPrompt).toContain('return only that requested shape');
  });
});
