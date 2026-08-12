const { getPack } = require('../../src/services/voicePersonaPacks');
const { analyzeAlerts, countFlags } = require('../../src/services/voicePersonaAlerts');

describe('voicePersonaAlerts', () => {
  test('counts recent audit safety flags', () => {
    const counts = countFlags([
      { safety: { flags: ['self_harm', 'emotional_distress'] } },
      { safety: { flags: ['emotional_distress'] } }
    ]);

    expect(counts).toEqual({
      self_harm: 1,
      emotional_distress: 2
    });
  });

  test('raises attention for deterministic escalation flags', () => {
    const pack = getPack('kidx_nestor');
    const result = analyzeAlerts(pack, [
      {
        traceId: 'trace-1',
        sessionId: 'session-1',
        input: { sha256: 'abc', preview: 'preview' },
        safety: { flags: ['self_harm'] },
        createdAt: new Date()
      }
    ]);

    expect(result.status).toBe('attention');
    expect(result.alerts[0].severity).toBe('high');
    expect(result.alerts[0].flagId).toBe('self_harm');
  });

  test('raises review for repeated medium flags', () => {
    const pack = getPack('kidx_nestor');
    const result = analyzeAlerts(pack, [
      { safety: { flags: ['emotional_distress'] } },
      { safety: { flags: ['emotional_distress'] } }
    ]);

    expect(result.status).toBe('review');
    expect(result.alerts[0].severity).toBe('medium');
  });
});
