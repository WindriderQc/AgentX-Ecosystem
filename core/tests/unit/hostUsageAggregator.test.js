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

  it('renders every configured host and keeps no-data distinct from measured zero', () => {
    const now = new Date('2026-08-23T12:30:00.000Z');
    const records = [{
      host: 'http://primary:11434',
      hostKey: 'primary',
      hour: new Date('2026-08-23T11:00:00.000Z'),
      utilizationPct: 0,
    }];
    const configured = [
      { id: 'primary', name: 'GPU One', url: 'http://primary:11434' },
      { id: 'secondary', name: 'GPU Two', url: 'http://secondary:11434' },
    ];

    const heatmap = hostUsageAggregator.buildUtilizationHeatmap(records, 1, now, configured);

    expect(heatmap.hosts).toEqual(expect.arrayContaining([
      expect.objectContaining({ key: 'primary', displayName: 'GPU One', role: 'primary', ip: 'primary' }),
      expect.objectContaining({ key: 'secondary', displayName: 'GPU Two', role: 'secondary', ip: 'secondary' }),
    ]));
    const today = heatmap.days.indexOf('2026-08-23');
    expect(heatmap.grid.primary[today][11]).toBe(0);
    expect(heatmap.grid.secondary[today][11]).toBeNull();
  });
});
