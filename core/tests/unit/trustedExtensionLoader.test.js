const fs = require('fs');
const path = require('path');

const {
  EXTENSION_ENV,
  TRUSTED_EXTENSION_CONTRACT_VERSION,
  parseExtensionModules,
  loadTrustedExtensions
} = require('../../src/extensions/trustedExtensionLoader');

describe('trusted extension loader', () => {
  const extensionA = path.resolve(__filename);
  const extensionB = path.resolve(__dirname, '../../src/extensions/trustedExtensionLoader.js');

  function load(overrides = {}) {
    return loadTrustedExtensions({
      app: {},
      express: {},
      mongoose: {},
      logger: {},
      profile: 'full',
      standardJsonParser: jest.fn(),
      conversationLifecycle: { capabilities: { provider: 'agentx-core', contractVersion: 1 } },
      runtimeServices: {
        contractVersion: 1,
        inference: { execute: jest.fn() },
        routing: { getEffectiveSnapshot: jest.fn() }
      },
      security: {
        contractVersion: 1,
        requireOperatorAccess: jest.fn(),
        requireOperatorUiAccess: jest.fn()
      },
      env: { [EXTENSION_ENV]: extensionA },
      requireModule: jest.fn(() => ({
        id: 'example-extension',
        version: '1.2.3',
        capabilities: ['example-capability'],
        register: jest.fn()
      })),
      ...overrides
    });
  }

  test('parses empty, single-path, and JSON-array configuration', () => {
    expect(parseExtensionModules()).toEqual([]);
    expect(parseExtensionModules(`  ${extensionA}  `)).toEqual([extensionA]);
    expect(parseExtensionModules(JSON.stringify([extensionA, extensionB])))
      .toEqual([extensionA, extensionB]);
    expect(() => parseExtensionModules('[broken'))
      .toThrow(`${EXTENSION_ENV} must be a JSON array`);
    const malformedSecret = 'private-token-inside-malformed-json';
    try {
      parseExtensionModules(`["${malformedSecret}`);
    } catch (error) {
      expect(error.message).not.toContain(malformedSecret);
    }
    expect(() => parseExtensionModules(JSON.stringify([extensionA, ''])))
      .toThrow('non-empty module paths');
  });

  test('is disabled by default and outside the full profile', () => {
    const requireModule = jest.fn();
    expect(loadTrustedExtensions({
      profile: 'full',
      env: {},
      requireModule
    })).toEqual([]);

    const logger = { warn: jest.fn() };
    expect(loadTrustedExtensions({
      profile: 'demo',
      env: { [EXTENSION_ENV]: extensionA },
      requireModule,
      logger
    })).toEqual([]);
    expect(requireModule).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('disabled outside the full profile'));
  });

  test('loads an absolute module and exposes only the versioned trusted contract', () => {
    const register = jest.fn();
    const app = {};
    const conversationLifecycle = { capabilities: { provider: 'agentx-core', contractVersion: 1 } };
    const logger = { info: jest.fn() };
    const requireOperatorAccess = jest.fn();
    const requireOperatorUiAccess = jest.fn();
    const deploymentSecret = 'do-not-expose-this-token';
    const privateAddress = 'https://private-adapter.invalid:9999';
    const loaded = load({
      app,
      conversationLifecycle,
      logger,
      security: {
        contractVersion: 1,
        requireOperatorAccess,
        requireOperatorUiAccess,
        expectedOperatorToken: () => deploymentSecret,
        privateAddress
      },
      env: {
        [EXTENSION_ENV]: extensionA,
        PRIVATE_ADAPTER_TOKEN: deploymentSecret,
        PRIVATE_ADAPTER_URL: privateAddress
      },
      requireModule: jest.fn(() => ({
        id: 'example-extension',
        version: '1.2.3',
        capabilities: ['example-capability', 'example-capability'],
        register
      }))
    });

    expect(register).toHaveBeenCalledTimes(1);
    expect(register).toHaveBeenCalledWith(expect.objectContaining({
      contractVersion: TRUSTED_EXTENSION_CONTRACT_VERSION,
      app,
      profile: 'full',
      conversationLifecycle,
      extensionRoot: path.dirname(extensionA)
    }));
    expect(Object.keys(register.mock.calls[0][0]).sort()).toEqual([
      'app',
      'contractVersion',
      'conversationLifecycle',
      'express',
      'extensionRoot',
      'logger',
      'mongoose',
      'profile',
      'runtimeServices',
      'security',
      'standardJsonParser'
    ]);
    const injected = register.mock.calls[0][0];
    expect(injected.security).toEqual({
      contractVersion: 1,
      requireOperatorAccess,
      requireOperatorUiAccess
    });
    expect(Object.isFrozen(injected.security)).toBe(true);
    expect(injected.security.expectedOperatorToken).toBeUndefined();
    expect(injected.security.privateAddress).toBeUndefined();
    expect(loaded).toEqual([{
      id: 'example-extension',
      version: '1.2.3',
      capabilities: ['example-capability']
    }]);
    expect(Object.isFrozen(loaded)).toBe(true);
    expect(Object.isFrozen(loaded[0])).toBe(true);
    expect(Object.isFrozen(loaded[0].capabilities)).toBe(true);
    expect(logger.info).toHaveBeenCalledWith('Loaded trusted extension: example-extension@1.2.3');
    expect(JSON.stringify(loaded)).not.toContain(deploymentSecret);
    expect(JSON.stringify(loaded)).not.toContain(privateAddress);
    expect(JSON.stringify(logger.info.mock.calls)).not.toContain(deploymentSecret);
    expect(JSON.stringify(logger.info.mock.calls)).not.toContain(privateAddress);
  });

  test('rejects relative paths and malformed manifests before registration', () => {
    expect(() => load({ env: { [EXTENSION_ENV]: 'relative-extension.js' } }))
      .toThrow('entries must be absolute paths');
    expect(() => load({ requireModule: jest.fn(() => jest.fn()) }))
      .toThrow('must export a manifest object');
    expect(() => load({ requireModule: jest.fn(() => ({
      id: 'UPPERCASE', version: '1.0.0', register: jest.fn()
    })) })).toThrow('invalid id');
    expect(() => load({ requireModule: jest.fn(() => ({
      id: 'example-extension', version: 'latest', register: jest.fn()
    })) })).toThrow('semantic version');
    expect(() => load({ requireModule: jest.fn(() => ({
      id: 'example-extension', version: '1.0.0', capabilities: ['bad_capability'], register: jest.fn()
    })) })).toThrow('invalid capability');
  });

  test('rejects duplicate module paths, ids, and capability ownership', () => {
    expect(() => load({
      env: { [EXTENSION_ENV]: JSON.stringify([extensionA, extensionA]) }
    })).toThrow('configured twice');

    expect(() => load({
      env: { [EXTENSION_ENV]: JSON.stringify([extensionA, extensionB]) },
      requireModule: jest.fn(() => ({
        id: 'same-extension', version: '1.0.0', capabilities: [], register: jest.fn()
      }))
    })).toThrow('Duplicate trusted extension id');

    expect(() => load({
      env: { [EXTENSION_ENV]: JSON.stringify([extensionA, extensionB]) },
      requireModule: jest.fn((modulePath) => ({
        id: modulePath === extensionA ? 'extension-a' : 'extension-b',
        version: '1.0.0',
        capabilities: ['same-capability'],
        register: jest.fn()
      }))
    })).toThrow('capability is owned twice');
  });

  test('requires synchronous registration', () => {
    expect(() => load({
      requireModule: jest.fn(() => ({
        id: 'async-extension',
        version: '1.0.0',
        register: async () => {}
      }))
    })).toThrow('must be synchronous');

    expect(() => load({
      requireModule: jest.fn(() => ({
        id: 'thenable-extension',
        version: '1.0.0',
        register: () => Promise.resolve()
      }))
    })).toThrow('must be synchronous');
  });

  test('fails startup when a configured extension cannot receive the generic runtime contracts', () => {
    expect(() => load({ runtimeServices: null }))
      .toThrow('runtimeServices contract v1');
    expect(() => load({ security: null }))
      .toThrow('security contract v1');
  });

  test('fails closed without reflecting module paths or extension-thrown secrets', () => {
    const privateAddress = 'https://private-adapter.invalid:9999';
    const deploymentSecret = 'operator-token-that-must-not-be-logged';
    const missingPath = path.resolve(__dirname, `missing-${deploymentSecret}.js`);

    expect(() => load({ env: { [EXTENSION_ENV]: missingPath } }))
      .toThrow('Configured trusted extension path could not be resolved.');
    try {
      load({ env: { [EXTENSION_ENV]: missingPath } });
    } catch (error) {
      expect(error.message).not.toContain(missingPath);
      expect(error.message).not.toContain(deploymentSecret);
    }

    const loadFailure = new Error(`${deploymentSecret} at ${privateAddress}`);
    expect(() => load({ requireModule: jest.fn(() => { throw loadFailure; }) }))
      .toThrow('Configured trusted extension module could not be loaded.');
    try {
      load({ requireModule: jest.fn(() => { throw loadFailure; }) });
    } catch (error) {
      expect(error.message).not.toContain(deploymentSecret);
      expect(error.message).not.toContain(privateAddress);
    }

    const registerFailure = new Error(`${deploymentSecret} at ${privateAddress}`);
    expect(() => load({
      requireModule: jest.fn(() => ({
        id: 'failing-extension',
        version: '1.0.0',
        register: () => { throw registerFailure; }
      }))
    })).toThrow('Trusted extension failing-extension registration failed.');
  });

  test('ships no extension activation or private implementation in the product defaults', () => {
    const repositoryRoot = path.resolve(__dirname, '../../..');
    const compose = fs.readFileSync(path.join(repositoryRoot, 'docker-compose.yml'), 'utf8');
    const defaultEnv = fs.readFileSync(path.join(repositoryRoot, 'config', 'agentx.env'), 'utf8');
    expect(compose).not.toMatch(/^\s*AGENTX_EXTENSION_MODULES\s*:/m);
    expect(defaultEnv).not.toMatch(/^\s*AGENTX_EXTENSION_MODULES\s*=/m);

    const productExtensionFiles = fs.readdirSync(
      path.resolve(__dirname, '../../src/extensions'),
      { withFileTypes: true }
    ).map((entry) => entry.name).sort();
    expect(productExtensionFiles).toEqual([
      'trustedExtensionLoader.js',
      'trustedRuntimeNavigation.js',
      'trustedRuntimeServices.js'
    ]);
  });
});
