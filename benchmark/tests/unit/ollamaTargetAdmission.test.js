'use strict';

const {
  admitOllamaTarget,
  admitOllamaTargetResolved,
  EXTRA_TARGETS_ENV
} = require('../../src/helpers/ollamaTargetAdmission');
const {
  readBoundedJson,
  ResponseBodyLimitError
} = require('../../src/helpers/boundedJsonResponse');
const { probeHostInventory } = require('../../src/services/benchmark/judgeReadiness');
const { checkHost } = require('../../src/services/hostTestService');

describe('bounded Ollama target admission', () => {
  test.each([
    ['localhost:11434', 'http://localhost:11434'],
    ['http://127.0.0.1:11434/', 'http://127.0.0.1:11434'],
    ['http://192.168.50.22:11434', 'http://192.168.50.22:11434'],
    ['https://10.10.0.7:11434', 'https://10.10.0.7:11434'],
    ['http://ollama:11434', 'http://ollama:11434'],
    ['http://host.docker.internal:11434', 'http://host.docker.internal:11434'],
    ['http://[::1]:11434', 'http://[::1]:11434']
  ])('admits supported loopback, LAN, and Docker target %s', (input, expected) => {
    expect(admitOllamaTarget(input, { env: {} })).toBe(expected);
  });

  test.each([
    'ftp://ollama:11434',
    'http://user:secret@ollama:11434',
    'http://ollama:11434/api/tags',
    'http://ollama:11434?next=http://169.254.169.254/latest/meta-data',
    'http://ollama:11434/#http://169.254.169.254/latest/meta-data'
  ])('rejects URL structure that could change the admitted origin: %s', (input) => {
    expect(() => admitOllamaTarget(input, { env: {} })).toThrow();
  });

  test.each([
    'http://0.0.0.0:11434',
    'http://169.254.169.254:11434',
    'http://100.100.100.200:11434',
    'http://224.0.0.1:11434',
    'http://metadata.google.internal:11434',
    'http://instance-data.ec2.internal:11434',
    'http://[::]:11434',
    'http://[fe80::1]:11434',
    'http://[ff02::1]:11434',
    'http://[::ffff:169.254.169.254]:11434'
  ])('rejects metadata, unspecified, link-local, and multicast target %s', (input) => {
    expect(() => admitOllamaTarget(input, { env: {} })).toThrow(/forbidden/i);
  });

  test('requires an exact configured or operator allowlisted origin for non-standard ports', () => {
    const target = 'https://ollama.gateway.lan:8443';
    expect(() => admitOllamaTarget(target, { env: {} })).toThrow(/port must be 11434/i);

    expect(admitOllamaTarget(target, {
      configuredHosts: [{ url: target }],
      env: {}
    })).toBe(target);

    expect(admitOllamaTarget(target, {
      env: { [EXTRA_TARGETS_ENV]: `http://other.lan:8080, ${target}` }
    })).toBe(target);
  });

  test('an allowlist cannot opt a metadata target back in', () => {
    const target = 'http://169.254.169.254:8080';
    expect(() => admitOllamaTarget(target, {
      configuredHosts: [{ url: target }],
      env: { [EXTRA_TARGETS_ENV]: target }
    })).toThrow(/forbidden/i);
  });

  test('rejects a DNS alias when any resolved address is link-local metadata', async () => {
    const lookup = jest.fn(async () => [
      { address: '192.168.50.20', family: 4 },
      { address: '169.254.169.254', family: 4 }
    ]);

    await expect(admitOllamaTargetResolved('http://ollama-gateway.example:11434', {
      env: {},
      lookup
    })).rejects.toThrow(/resolves to a forbidden link-local/i);
  });

  test('admits a DNS name when every resolved address is a safe LAN address', async () => {
    await expect(admitOllamaTargetResolved('http://ollama-gateway.example:11434', {
      env: {},
      lookup: jest.fn(async () => [{ address: '10.20.30.40', family: 4 }])
    })).resolves.toBe('http://ollama-gateway.example:11434');
  });
});

describe('bounded Ollama JSON bodies', () => {
  test('parses a streamed JSON body within the byte limit', async () => {
    const body = {
      async *[Symbol.asyncIterator]() {
        yield Buffer.from('{"models":');
        yield Buffer.from('[]}');
      }
    };
    await expect(readBoundedJson({ body }, { maxBytes: 32 })).resolves.toEqual({ models: [] });
  });

  test('stops reading and rejects as soon as the byte limit is crossed', async () => {
    const destroy = jest.fn();
    const body = {
      destroy,
      async *[Symbol.asyncIterator]() {
        yield Buffer.alloc(8, 0x20);
        yield Buffer.alloc(8, 0x20);
        throw new Error('reader continued past the limit');
      }
    };

    await expect(readBoundedJson({ body }, { maxBytes: 12 })).rejects.toBeInstanceOf(ResponseBodyLimitError);
    expect(destroy).toHaveBeenCalled();
  });
});

describe('Ollama inventory redirects', () => {
  test('judge inventory probes return the redirect as a failure without following it', async () => {
    const fetchImpl = jest.fn(async () => ({
      ok: false,
      status: 302,
      json: async () => ({})
    }));

    const result = await probeHostInventory('http://ollama:11434', { fetchImpl, timeoutMs: 100 });

    expect(result).toMatchObject({ reachable: false, models: [], error: 'inventory returned HTTP 302' });
    expect(fetchImpl).toHaveBeenCalledWith('http://ollama:11434/api/tags', expect.objectContaining({
      method: 'GET',
      redirect: 'manual'
    }));
  });

  test('profiler host checks return the redirect as a failure without following it', async () => {
    const fetchImpl = jest.fn(async () => ({
      ok: false,
      status: 307,
      json: async () => ({})
    }));
    const transportAdapter = async ({ fetchImpl: dispatch, init, target }) => ({
      response: await dispatch(target, init),
      peerVerification: 'connect-time'
    });

    const result = await checkHost('http://redirect-test-ollama:11434', {
      fetchImpl,
      transportAdapter
    });

    expect(result).toMatchObject({ available: false, models: [], error: 'HTTP 307' });
    expect(fetchImpl).toHaveBeenCalledWith('http://redirect-test-ollama:11434/api/tags', expect.objectContaining({
      method: 'GET',
      redirect: 'manual'
    }));
  });

  test('judge inventory rejects an oversized streamed body', async () => {
    const fetchImpl = jest.fn(async () => ({
      ok: true,
      status: 200,
      body: {
        async *[Symbol.asyncIterator]() {
          yield Buffer.alloc(1024 * 1024, 0x20);
          yield Buffer.from('{}');
        }
      }
    }));

    const result = await probeHostInventory('http://ollama:11434', { fetchImpl, timeoutMs: 1000 });
    expect(result).toMatchObject({ reachable: false, models: [] });
    expect(result.error).toMatch(/byte limit/i);
  });
});
