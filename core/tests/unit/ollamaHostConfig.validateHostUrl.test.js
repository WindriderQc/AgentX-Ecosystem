/**
 * Task 0182 — validateHostUrl helper.
 *
 * Verifies the allowlist gate that fronts every mutating route accepting a
 * caller-supplied Ollama host. Keep this test in sync with route-level
 * integration tests (`tests/routes/hostAllowlist.api.test.js`).
 */

describe('validateHostUrl (task 0182)', () => {
  let validateHostUrl;
  let getConfiguredHosts;
  let originalEnv;

  beforeEach(() => {
    jest.resetModules();
    originalEnv = { ...process.env };
    process.env.OLLAMA_HOST = 'http://192.0.2.99:11434';
    process.env.OLLAMA_HOST_NAME = 'Host Gamma';
    process.env.OLLAMA_HOST_2 = 'http://192.0.2.12:11434';
    process.env.OLLAMA_HOST_2_NAME = 'Host Beta';
    process.env.OLLAMA_HOST_3 = 'http://localhost:11434';
    ({ validateHostUrl, getConfiguredHosts } = require('../../src/helpers/ollamaHostConfig'));
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('accepts an empty / undefined host (caller meant "no override")', () => {
    expect(validateHostUrl(undefined)).toEqual(expect.objectContaining({ valid: true, host: null }));
    expect(validateHostUrl(null)).toEqual(expect.objectContaining({ valid: true, host: null }));
    expect(validateHostUrl('')).toEqual(expect.objectContaining({ valid: true, host: null }));
    expect(validateHostUrl('   ')).toEqual(expect.objectContaining({ valid: true, host: null }));
  });

  it('accepts an exact configured URL match', () => {
    const result = validateHostUrl('http://192.0.2.99:11434');
    expect(result.valid).toBe(true);
    expect(result.host).toBe('http://192.0.2.99:11434');
  });

  it('accepts trailing-slash variant of a configured URL', () => {
    const result = validateHostUrl('http://192.0.2.99:11434/');
    expect(result.valid).toBe(true);
    expect(result.host).toBe('http://192.0.2.99:11434');
  });

  it('treats 127.0.0.1 and localhost as equivalent (loopback rule)', () => {
    // Configured: http://localhost:11434 (third host).
    expect(validateHostUrl('http://127.0.0.1:11434').valid).toBe(true);
    expect(validateHostUrl('http://localhost:11434').valid).toBe(true);
  });

  it('accepts a configured host by name (e.g. "Host Gamma")', () => {
    const result = validateHostUrl('Host Gamma');
    expect(result.valid).toBe(true);
    expect(result.host).toBe('http://192.0.2.99:11434');
  });

  it('accepts a configured host by id (e.g. "secondary")', () => {
    const result = validateHostUrl('secondary');
    expect(result.valid).toBe(true);
    expect(result.host).toBe('http://192.0.2.12:11434');
  });

  it('honors configured host display names from env', () => {
    jest.resetModules();
    process.env.OLLAMA_HOST_NAME = 'Primary Runtime';
    process.env.OLLAMA_HOST_2_NAME = 'Secondary Runtime';
    ({ validateHostUrl, getConfiguredHosts } = require('../../src/helpers/ollamaHostConfig'));

    expect(getConfiguredHosts()).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'primary', name: 'Primary Runtime', url: 'http://192.0.2.99:11434' }),
      expect.objectContaining({ id: 'secondary', name: 'Secondary Runtime', url: 'http://192.0.2.12:11434' }),
    ]));
    expect(validateHostUrl('Secondary Runtime')).toEqual(expect.objectContaining({
      valid: true,
      host: 'http://192.0.2.12:11434'
    }));
  });

  it('rejects an arbitrary unknown host with allowlist guidance', () => {
    const result = validateHostUrl('http://192.0.2.77:11434');
    expect(result.valid).toBe(false);
    expect(result.host).toBeNull();
    expect(result.message).toMatch(/not in the configured allowlist/i);
    expect(result.message).toContain('http://192.0.2.99:11434');
  });

  it('rejects an attacker URL pretending to be a known port', () => {
    const result = validateHostUrl('http://evil.example/api/generate');
    expect(result.valid).toBe(false);
    expect(result.message).toMatch(/allowlist/i);
  });

  it('rejects a known host on a non-configured port (different service)', () => {
    const result = validateHostUrl('http://192.0.2.99:11435');
    expect(result.valid).toBe(false);
  });

  it('rejects when no hosts are configured at all', () => {
    jest.resetModules();
    delete process.env.OLLAMA_HOST;
    delete process.env.OLLAMA_HOST_1;
    delete process.env.OLLAMA_HOST_PRIMARY;
    delete process.env.OLLAMA_HOST_2;
    delete process.env.OLLAMA_HOST_HEAVY;
    delete process.env.OLLAMA_HOST_SECONDARY;
    delete process.env.OLLAMA_HOST_3;
    delete process.env.OLLAMA_HOST_TERTIARY;
    const { validateHostUrl: freshValidate } = require('../../src/helpers/ollamaHostConfig');
    const result = freshValidate('http://192.0.2.99:11434');
    expect(result.valid).toBe(false);
    expect(result.message).toContain('(none configured)');
  });
});
