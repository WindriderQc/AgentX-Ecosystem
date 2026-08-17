const fs = require('fs');
const path = require('path');

jest.mock('fs');

const {
  parseExtensionModules,
  loadAgentXExtensions,
  extensionOwnsCapability
} = require('../../src/extensions/extensionLoader');

describe('Agent X extension loader', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    fs.statSync.mockReturnValue({ isDirectory: () => false });
  });

  test('parses a single path or a JSON path array', () => {
    expect(parseExtensionModules('/opt/agentx/a.js')).toEqual(['/opt/agentx/a.js']);
    expect(parseExtensionModules('["/opt/agentx/a.js","/opt/agentx/b.js"]'))
      .toEqual(['/opt/agentx/a.js', '/opt/agentx/b.js']);
  });

  test('does not load configured extensions in the demo profile', () => {
    const requireModule = jest.fn();
    const loaded = loadAgentXExtensions({
      app: {}, express: {}, mongoose: {}, logger: {}, profile: 'demo',
      env: { AGENTX_EXTENSION_MODULES: '/opt/agentx/a.js' }, requireModule
    });
    expect(loaded).toEqual([]);
    expect(requireModule).not.toHaveBeenCalled();
  });

  test('loads a full-profile extension and records its capability', () => {
    const modulePath = path.resolve('printer-extension.js');
    fs.realpathSync.mockReturnValue(modulePath);
    const register = jest.fn();
    const requireModule = jest.fn(() => ({
      id: 'example-operations-adapter',
      version: '1.0.0',
      capabilities: ['example-capability'],
      register
    }));
    const app = {};
    const conversationLifecycle = { capabilities: { contractVersion: 1 } };

    const loaded = loadAgentXExtensions({
      app, express: {}, mongoose: {}, logger: {}, profile: 'full',
      conversationLifecycle,
      env: { AGENTX_EXTENSION_MODULES: modulePath }, requireModule
    });

    expect(register).toHaveBeenCalledWith(expect.objectContaining({
      app,
      profile: 'full',
      conversationLifecycle
    }));
    expect(loaded).toEqual([expect.objectContaining({ id: 'example-operations-adapter' })]);
    expect(extensionOwnsCapability(loaded, 'example-capability')).toBe(true);
  });

  test('rejects duplicate capability ownership', () => {
    const a = path.resolve('a.js');
    const b = path.resolve('b.js');
    fs.realpathSync.mockImplementation((value) => value);
    const requireModule = jest.fn((value) => ({
      id: value === a ? 'extension-a' : 'extension-b',
      capabilities: ['example-capability'],
      register: jest.fn()
    }));

    expect(() => loadAgentXExtensions({
      app: {}, express: {}, mongoose: {}, logger: {}, profile: 'full',
      env: { AGENTX_EXTENSION_MODULES: JSON.stringify([a, b]) }, requireModule
    })).toThrow('capability is owned twice');
  });
});
