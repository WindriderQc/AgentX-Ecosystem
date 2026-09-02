'use strict';

jest.mock('../../config/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../../src/services/hostPreferenceService', () => ({ getByHost: jest.fn(async () => null) }));

const { explainModelUnavailability } = require('../../src/services/chat/modelUnavailability');

const hosts = [
  { id: 'primary', name: 'UGAlien', url: 'http://192.168.2.199:11434' },
  { id: 'tertiary', name: 'UGFrank', url: 'http://192.168.2.99:11434' }
];

function fakeFetch(inventory) {
  return jest.fn(async (url) => {
    const origin = new URL(url).origin;
    return { ok: true, json: async () => ({ models: (inventory[origin] || []).map(name => ({ name })) }) };
  });
}

describe('explainModelUnavailability', () => {
  test('names the host that answered 404 and the reserved host that has the model', async () => {
    const detail = await explainModelUnavailability(
      { model: 'qwen3.8:27b-mtp-q8_0', upstreamUrl: 'http://192.168.2.99:11434/api/chat' },
      {
        hosts,
        fetch: fakeFetch({ 'http://192.168.2.199:11434': ['qwen3.8:27b-mtp-q8_0', 'gemma4:31b-it-q8_0'] }),
        getPreference: async () => ({ status: 'benchmarking', benchmarkClaim: { batchId: 'b1' } })
      }
    );

    expect(detail.tried).toEqual({ hostKey: 'tertiary', name: 'UGFrank', url: 'http://192.168.2.99:11434' });
    expect(detail.installedOn).toEqual([
      { hostKey: 'primary', name: 'UGAlien', url: 'http://192.168.2.199:11434', status: 'benchmarking', unavailableBecause: 'reserved by a benchmark claim' }
    ]);
    expect(detail.message).toMatch(/not installed on UGFrank \(tertiary/);
    expect(detail.message).toMatch(/installed on: UGAlien \(primary\) — currently reserved by a benchmark claim/);
    expect(detail.message).toMatch(/Retry once that host is released/);
  });

  test('states plainly when the model is installed nowhere', async () => {
    const detail = await explainModelUnavailability(
      { model: 'nope:1b', upstreamUrl: 'http://192.168.2.199:11434/api/chat' },
      { hosts, fetch: fakeFetch({}), getPreference: async () => null }
    );
    expect(detail.installedOn).toEqual([]);
    expect(detail.message).toMatch(/not found on any other configured Ollama host/);
  });

  test('survives inventory probes that fail or time out', async () => {
    const detail = await explainModelUnavailability(
      { model: 'x:1b', upstreamUrl: 'http://192.168.2.199:11434/api/chat' },
      { hosts, fetch: jest.fn(async () => { throw new Error('ECONNREFUSED'); }), getPreference: async () => null }
    );
    expect(detail.installedOn).toEqual([]);
    expect(detail.message).toMatch(/Model x:1b is not installed/);
  });
});
