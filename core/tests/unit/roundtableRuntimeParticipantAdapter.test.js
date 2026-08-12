const {
  buildRuntimePrompt,
  callRuntimeParticipant,
  extractHermesResponse,
  extractOpenClawResponse,
  shellQuote,
  validateRuntimeConfiguration
} = require('../../src/services/roundtable/runtimeParticipantAdapter');

describe('roundtable runtime participant adapter', () => {
  test('builds an advisory-only prompt without exposing hidden reasoning', () => {
    const prompt = buildRuntimePrompt(
      [{ role: 'user', content: 'Evaluate the proposal.' }],
      { agentId: 'leadx', role: 'Operations reviewer' }
    );
    expect(prompt).toContain('advisory only');
    expect(prompt).toContain('do not execute commands');
    expect(prompt).toContain('Do not reveal hidden chain-of-thought');
    expect(prompt).toContain('[USER]\nEvaluate the proposal.');
  });

  test('keeps the advisory guard when a long transcript is truncated', () => {
    const prompt = buildRuntimePrompt(
      [{ role: 'user', content: 'x'.repeat(40000) }],
      { agentId: 'leadx', role: 'Operations reviewer' }
    );
    expect(prompt).toContain('advisory only');
    expect(prompt).toContain('do not execute commands');
    expect(prompt.length).toBeLessThanOrEqual(30000);
  });

  test('quotes apostrophes for the remote shell boundary', () => {
    expect(shellQuote("it's bounded")).toBe("'it'\"'\"'s bounded'");
  });

  test('extracts only final OpenClaw payload text', () => {
    expect(extractOpenClawResponse({
      result: {
        payloads: [{ text: 'Final answer' }],
        thinking: 'private reasoning'
      }
    })).toBe('Final answer');
  });

  test('removes Hermes session metadata from final text', () => {
    expect(extractHermesResponse('Useful answer\nsession_id: abc-123')).toBe('Useful answer');
  });

  test('calls an OpenClaw identity through the configured SSH target without delivery', async () => {
    let captured;
    const result = await callRuntimeParticipant(
      {
        runtime: 'openclaw',
        agentId: 'leadx',
        role: 'LeadX',
        runtimeConfig: { sessionKey: 'agent:leadx:roundtable-test' }
      },
      [{ role: 'user', content: "What's the operational risk?" }],
      { roundtableId: 'rt-1', round: 1, timeoutMs: 5000 },
      {
        env: {
          ROUNDTABLE_RUNTIME_PARTICIPANTS_ENABLED: 'true',
          ROUNDTABLE_RUNTIME_SSH_TARGET: 'yb@192.0.2.66',
          ROUNDTABLE_OPENCLAW_AGENT_ALLOWLIST: 'leadx'
        },
        sshRunner: async (target, command) => {
          captured = { target, command };
          return JSON.stringify({ result: { payloads: [{ text: 'Use the existing gateway.' }] } });
        }
      }
    );

    expect(result.error).toBeNull();
    expect(result.response).toBe('Use the existing gateway.');
    expect(result.thinking).toBeNull();
    expect(result.runtimeRef).toBe('agent:leadx:roundtable-test');
    expect(captured.target).toBe('yb@192.0.2.66');
    expect(captured.command).toContain("'leadx'");
    expect(captured.command).toContain('advisory only');
    expect(captured.command).not.toContain('--deliver');
  });

  test('uses only the server-configured Codex bridge URL', async () => {
    let requestedUrl;
    const result = await callRuntimeParticipant(
      {
        runtime: 'codex',
        agentId: 'codex-reviewer',
        role: 'Codex',
        runtimeConfig: { endpoint: 'http://attacker.invalid', sessionKey: 'rt-2' }
      },
      [{ role: 'user', content: 'Review this design.' }],
      { roundtableId: 'rt-2', round: 1, timeoutMs: 5000 },
      {
        env: {
          ROUNDTABLE_RUNTIME_PARTICIPANTS_ENABLED: 'true',
          ROUNDTABLE_CODEX_BRIDGE_URL: 'http://codex-bridge.internal/turn',
          ROUNDTABLE_CODEX_BRIDGE_TOKEN: 'private-token'
        },
        fetchImpl: async (url, options) => {
          requestedUrl = url;
          expect(options.headers.Authorization).toBe('Bearer private-token');
          return { ok: true, json: async () => ({ response: 'Looks sound.', sessionId: 's-1' }) };
        }
      }
    );

    expect(requestedUrl).toBe('http://codex-bridge.internal/turn');
    expect(result.response).toBe('Looks sound.');
    expect(result.runtimeRef).toBe('s-1');
  });

  test('requires and passes a dedicated Hermes toolset', async () => {
    let command;
    const result = await callRuntimeParticipant(
      { runtime: 'hermes', agentId: 'hermes', role: 'Hermes' },
      [{ role: 'user', content: 'Moderate the evidence.' }],
      { roundtableId: 'rt-h', round: 1, timeoutMs: 5000 },
      {
        env: {
          ROUNDTABLE_RUNTIME_PARTICIPANTS_ENABLED: 'true',
          ROUNDTABLE_RUNTIME_SSH_TARGET: 'yb@192.0.2.66',
          ROUNDTABLE_HERMES_TOOLSETS: 'roundtable-readonly'
        },
        sshRunner: async (_target, value) => {
          command = value;
          return 'Hermes position.';
        }
      }
    );
    expect(result.response).toBe('Hermes position.');
    expect(command).toContain("--toolsets 'roundtable-readonly'");
  });

  test('fails closed when real runtime participation is not enabled', async () => {
    const result = await callRuntimeParticipant(
      { runtime: 'hermes', agentId: 'hermes', role: 'Hermes' },
      [{ role: 'user', content: 'Discuss.' }],
      { roundtableId: 'rt-3', round: 1, timeoutMs: 5000 },
      { env: {} }
    );
    expect(result.error).toContain('Runtime participants are disabled');
  });

  test('validates every required server-owned runtime route before starting', () => {
    expect(() => validateRuntimeConfiguration(
      [{ runtime: 'openclaw' }],
      { ROUNDTABLE_RUNTIME_PARTICIPANTS_ENABLED: 'true' }
    )).toThrow('SSH target');
    expect(() => validateRuntimeConfiguration(
      [{ runtime: 'codex' }],
      {
        ROUNDTABLE_RUNTIME_PARTICIPANTS_ENABLED: 'true',
        ROUNDTABLE_CODEX_BRIDGE_URL: 'file:///tmp/not-allowed'
      }
    )).toThrow('http or https');
    expect(() => validateRuntimeConfiguration(
      [{ runtime: 'openclaw', agentId: 'leadx' }],
      {
        ROUNDTABLE_RUNTIME_PARTICIPANTS_ENABLED: 'true',
        ROUNDTABLE_RUNTIME_SSH_TARGET: 'yb@192.0.2.66'
      }
    )).toThrow('not allowlisted');
    expect(validateRuntimeConfiguration(
      [{ runtime: 'hermes' }, { runtime: 'codex' }],
      {
        ROUNDTABLE_RUNTIME_PARTICIPANTS_ENABLED: 'true',
        ROUNDTABLE_RUNTIME_SSH_TARGET: 'yb@192.0.2.66',
        ROUNDTABLE_HERMES_TOOLSETS: 'roundtable-readonly',
        ROUNDTABLE_CODEX_BRIDGE_URL: 'http://codex.internal/turn'
      }
    )).toBe(true);
  });
});
