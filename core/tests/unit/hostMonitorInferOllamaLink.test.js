// Regression coverage for hostMonitorService._inferOllamaLink.
//
// A host-agent reports a hostId that may be a role-style label ('primary',
// 'secondary'). Those labels can collide with ANOTHER configured host's key,
// so the link must be resolved by IP first — otherwise Host Gamma (192.0.2.99,
// reporting HOST_ID=primary) gets linked to the configured 'primary' slot
// (Host Alpha/.105) and shows up under the wrong GPU/host in the Nerve Center.

jest.mock('../../config/logger', () => ({
  info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn()
}));

jest.mock('../../src/helpers/ollamaHostConfig', () => {
  const actual = jest.requireActual('../../src/helpers/ollamaHostConfig');
  return { ...actual, getConfiguredHosts: jest.fn() };
});

const { getConfiguredHosts } = require('../../src/helpers/ollamaHostConfig');
const hostMonitorService = require('../../src/services/hostMonitorService');

const CONFIGURED = [
  { id: 'primary', name: 'Host Alpha', url: 'http://192.0.2.105:11434' },
  { id: 'secondary', name: 'Host Beta', url: 'http://192.0.2.12:11434' },
  { id: 'tertiary', name: 'Host Gamma', url: 'http://192.0.2.99:11434' }
];

describe('hostMonitorService._inferOllamaLink', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    getConfiguredHosts.mockReturnValue(CONFIGURED);
  });

  it('links by IP even when hostId collides with another host key (Host Gamma reports HOST_ID=primary)', () => {
    const link = hostMonitorService._inferOllamaLink({
      ip: '192.0.2.99', hostname: 'Host Gamma', hostId: 'primary'
    });
    expect(link).toEqual({ ollamaHostKey: 'tertiary', ollamaUrl: 'http://192.0.2.99:11434' });
  });

  it('links each real host to its own slot by IP', () => {
    expect(hostMonitorService._inferOllamaLink({ ip: '192.0.2.105', hostname: 'host-alpha', hostId: 'host-alpha' }))
      .toMatchObject({ ollamaHostKey: 'primary' });
    expect(hostMonitorService._inferOllamaLink({ ip: '192.0.2.12', hostname: 'Host Beta', hostId: 'secondary' }))
      .toMatchObject({ ollamaHostKey: 'secondary' });
  });

  it('falls back to hostname/hostId only when no IP match is available', () => {
    expect(hostMonitorService._inferOllamaLink({ ip: '', hostname: 'Host Gamma', hostId: 'whatever' }))
      .toMatchObject({ ollamaHostKey: 'tertiary' });
    expect(hostMonitorService._inferOllamaLink({ ip: '', hostname: '', hostId: 'secondary' }))
      .toMatchObject({ ollamaHostKey: 'secondary' });
  });

  it('returns an empty link when nothing matches', () => {
    expect(hostMonitorService._inferOllamaLink({ ip: '10.0.0.1', hostname: 'nope', hostId: 'nope' }))
      .toEqual({});
  });
});
