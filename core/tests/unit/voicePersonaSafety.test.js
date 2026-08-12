const { getPack } = require('../../src/services/voicePersonaPacks');
const { assessTurn, buildEscalationReply } = require('../../src/services/voicePersonaSafety');

describe('voicePersonaSafety', () => {
  test('deterministically escalates high-risk KidX-family turns', () => {
    const pack = getPack('kidx_nestor');
    const result = assessTurn('I want to kill myself', pack);

    expect(result.flagIds).toContain('self_harm');
    expect(result.requiresParentAttention).toBe(true);
    expect(result.deterministicEscalation).toBe(true);
    expect(buildEscalationReply(pack, result)).toMatch(/adulte de confiance|trusted/i);
  });

  test('flags private info requests without deterministic escalation', () => {
    const pack = getPack('kidx_nestor');
    const result = assessTurn('What is the password for the house tablet?', pack);

    expect(result.flagIds).toContain('private_info_request');
    expect(result.deterministicEscalation).toBe(false);
  });

  test('keeps personal operator clear for normal adult support', () => {
    const pack = getPack('personal_operator');
    const result = assessTurn('Help me plan the next implementation step.', pack);

    expect(result.flagIds).toEqual([]);
    expect(result.requiresAttention).toBe(false);
    expect(result.deterministicEscalation).toBe(false);
  });
});
