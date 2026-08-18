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
    const loaded = load({
      app,
      conversationLifecycle,
      logger,
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
      'standardJsonParser'
    ]);
    expect(loaded).toEqual([{
      id: 'example-extension',
      version: '1.2.3',
      capabilities: ['example-capability']
    }]);
    expect(Object.isFrozen(loaded)).toBe(true);
    expect(Object.isFrozen(loaded[0])).toBe(true);
    expect(Object.isFrozen(loaded[0].capabilities)).toBe(true);
    expect(logger.info).toHaveBeenCalledWith('Loaded trusted extension: example-extension@1.2.3');
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
});
