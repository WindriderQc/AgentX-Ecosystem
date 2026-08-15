jest.mock('../../config/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn()
}));

describe('hostUsageAggregator host labels', () => {
  let hostUsageAggregator;

  beforeEach(() => {
    jest.resetModules();
    hostUsageAggregator = require('../../src/services/hostUsageAggregator');
  });

  it('builds host labels from the platform registry schema', () => {
    const lookup = hostUsageAggregator.buildHostLabelLookup({
      hosts: {
        ugexample: {
          display_name: 'UGExample',
          address: '10.0.0.44',
          os_hostname: 'ug-example-host',
          aliases: ['example']
        }
      }
    });

    expect(lookup.get('10.0.0.44')).toBe('UGExample');
    expect(lookup.get('ugexample')).toBe('UGExample');
    expect(lookup.get('ug-example-host')).toBe('UGExample');
    expect(lookup.get('example')).toBe('UGExample');
  });

  it('does not require an untracked platform map for host labels', () => {
    expect(hostUsageAggregator.hostLabel('http://192.0.2.12:11434')).toBe('192.0.2.12');
    expect(hostUsageAggregator.hostLabel('http://192.0.2.10:11434')).toBe('192.0.2.10');
    expect(hostUsageAggregator.hostLabel('http://192.0.2.199:11434')).toBe('192.0.2.199');
    expect(hostUsageAggregator.hostLabel('http://example-device.local:80')).toBe('example-device.local');
  });

  it('falls back to parsed hostnames for unregistered hosts', () => {
    expect(hostUsageAggregator.hostLabel('http://new-host:11434')).toBe('new-host');
    expect(hostUsageAggregator.hostLabel('not a url')).toBe('not a url');
    expect(hostUsageAggregator.hostLabel(null)).toBe('unknown');
  });
});
