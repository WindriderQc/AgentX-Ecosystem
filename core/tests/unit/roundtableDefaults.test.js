const {
  DEFAULT_PANEL,
  DEFAULT_SYNTHESIZER,
  buildCouncilDefaults,
  configuredModelFromEnv,
  discoveredModelNames,
  COUNCIL_ADVISORY_GUARD,
  withCouncilAdvisoryGuard
} = require('../../src/services/roundtable/defaults');

describe('roundtable defaults', () => {
  it('uses one explicitly configured model for every role', () => {
    expect(new Set(DEFAULT_PANEL.map(panelist => panelist.model))).toEqual(
      new Set([DEFAULT_SYNTHESIZER.model])
    );
  });

  it('keeps one selected model for the final panelist and synthesis', () => {
    const finalPanelist = DEFAULT_PANEL[DEFAULT_PANEL.length - 1];

    expect(finalPanelist.agentId).toBe('visionary');
    expect(finalPanelist.model).toBe(DEFAULT_SYNTHESIZER.model);
  });

  it('does not invent a model when neither configuration nor discovery provides one', () => {
    const defaults = buildCouncilDefaults();

    expect(defaults.panel.every((panelist) => panelist.model === '')).toBe(true);
    expect(defaults.synthesizer.model).toBe('');
    expect(defaults.models).toEqual([]);
    expect(defaults.readiness).toMatchObject({
      canStart: false,
      selectedModel: null,
      selectedSource: 'none',
      downloadsImplicit: false
    });
  });

  it('builds a useful preset only from live chat-capable discovery', () => {
    const catalog = [
      { name: 'gone-model', deployment: { status: 'gone' } },
      { name: 'nomic-embed-text:v1.5', deployment: { status: 'available' } },
      { name: 'blocked-model', chatAllowed: false, deployment: { status: 'available' } },
      {
        name: 'normalized-model',
        deployment: { status: 'available', resolvedName: 'runtime/model-b:latest' }
      },
      { name: 'runtime/model-a', deployment: { status: 'available' } }
    ];

    expect(discoveredModelNames(catalog)).toEqual([
      'runtime/model-a',
      'runtime/model-b:latest'
    ]);
    const defaults = buildCouncilDefaults({ catalog });
    expect(defaults.readiness).toMatchObject({
      canStart: true,
      selectedModel: 'runtime/model-a',
      selectedSource: 'runtime-discovery',
      selectedModelDiscovered: true,
      discoveredCount: 2
    });
    expect(new Set(defaults.panel.map((panelist) => panelist.model))).toEqual(
      new Set(['runtime/model-a'])
    );
    expect(defaults.synthesizer.model).toBe('runtime/model-a');
  });

  it('prefers an explicit deployment model and identifies its source', () => {
    expect(configuredModelFromEnv({
      AGENTX_DEFAULT_CHAT_MODEL: 'configured/model',
      OLLAMA_MODEL: 'lower-priority/model'
    })).toEqual({
      model: 'configured/model',
      source: 'environment:AGENTX_DEFAULT_CHAT_MODEL'
    });

    const defaults = buildCouncilDefaults({
      catalog: [{ name: 'runtime/model-a', deployment: { status: 'available' } }],
      configuredModel: 'configured/model',
      configuredSource: 'environment:AGENTX_DEFAULT_CHAT_MODEL'
    });
    expect(defaults.models).toEqual(['configured/model', 'runtime/model-a']);
    expect(defaults.readiness).toMatchObject({
      selectedModel: 'configured/model',
      selectedSource: 'environment:AGENTX_DEFAULT_CHAT_MODEL',
      selectedModelDiscovered: false
    });
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
