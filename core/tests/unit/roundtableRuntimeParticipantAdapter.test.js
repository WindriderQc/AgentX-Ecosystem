'use strict';

const {
  buildRuntimePrompt,
  callRuntimeParticipant,
  validateRuntimeConfiguration,
} = require('../../src/services/roundtable/runtimeParticipantAdapter');

describe('roundtable Codex participant bridge', () => {
  test('builds a bounded advisory prompt', () => {
    const prompt = buildRuntimePrompt(
      [{ role: 'user', content: 'Evaluate the proposal.' }],
      { agentId: 'reviewer', role: 'Reviewer' }
    );
    expect(prompt).toContain('advisory only');
    expect(prompt).toContain('do not execute commands');
    expect(prompt).toContain('Do not reveal hidden chain-of-thought');
    expect(prompt).toContain('[USER]\nEvaluate the proposal.');
  });

  test('keeps the guard when a long transcript is truncated', () => {
    const prompt = buildRuntimePrompt(
      [{ role: 'user', content: 'x'.repeat(40000) }],
      { agentId: 'reviewer', role: 'Reviewer' }
    );
    expect(prompt).toContain('advisory only');
    expect(prompt.length).toBeLessThanOrEqual(30000);
  });

  test('uses only the server-configured Codex bridge URL', async () => {
    let requestedUrl;
    const result = await callRuntimeParticipant(
      { runtime: 'codex', agentId: 'codex-reviewer', role: 'Codex', runtimeConfig: { sessionKey: 'rt-2' } },
      [{ role: 'user', content: 'Review this design.' }],
      { roundtableId: 'rt-2', round: 1, timeoutMs: 5000 },
      {
        env: {
          ROUNDTABLE_RUNTIME_PARTICIPANTS_ENABLED: 'true',
          ROUNDTABLE_CODEX_BRIDGE_URL: 'http://codex-bridge.internal/turn',
          ROUNDTABLE_CODEX_BRIDGE_TOKEN: 'private-token',
        },
        fetchImpl: async (url, options) => {
          requestedUrl = url;
          expect(options.headers.Authorization).toBe('Bearer private-token');
          return { ok: true, json: async () => ({ response: 'Looks sound.', sessionId: 's-1' }) };
        },
      }
    );
    expect(requestedUrl).toBe('http://codex-bridge.internal/turn');
    expect(result).toEqual(expect.objectContaining({ response: 'Looks sound.', runtimeRef: 's-1', error: null }));
  });

  test('fails closed for unsupported runtimes and disabled bridges', async () => {
    const unsupported = await callRuntimeParticipant(
      { runtime: 'external-runtime', agentId: 'external', role: 'External' },
      [{ role: 'user', content: 'Discuss.' }],
      { roundtableId: 'rt-3', round: 1, timeoutMs: 5000 },
      { env: {} }
    );
    expect(unsupported.error).toContain('Unsupported runtime participant');

    expect(() => validateRuntimeConfiguration([{ runtime: 'codex' }], {}))
      .toThrow('Runtime participants are disabled');
  });

  test('requires an HTTP(S) Codex bridge', () => {
    expect(() => validateRuntimeConfiguration([{ runtime: 'codex' }], {
      ROUNDTABLE_RUNTIME_PARTICIPANTS_ENABLED: 'true',
      ROUNDTABLE_CODEX_BRIDGE_URL: 'file:///tmp/not-allowed',
    })).toThrow('http or https');
    expect(validateRuntimeConfiguration([{ runtime: 'codex' }], {
      ROUNDTABLE_RUNTIME_PARTICIPANTS_ENABLED: 'true',
      ROUNDTABLE_CODEX_BRIDGE_URL: 'https://codex.example/turn',
    })).toBe(true);
  });
});
