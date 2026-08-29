'use strict';

const {
  redactDeploymentLocations,
  sanitizePublicProjection,
} = require('../../../shared/publicProjection');

describe('shared public projection privacy boundary', () => {
  test('redacts schemed and bare endpoints plus Windows and POSIX paths', () => {
    const source = 'connect ECONNREFUSED 10.0.0.99:11434 at C:\\Users\\operator\\AgentX and /var/run/agentx.sock via http://private-host:11434/api; connect ECONNREFUSED [fd00::1234]:11434; open \\\\private-server\\share\\config.json; getaddrinfo ENOTFOUND private-box';
    const redacted = redactDeploymentLocations(source);

    expect(redacted).toContain('[redacted-endpoint]');
    expect(redacted).toContain('[redacted-path]');
    expect(redacted).not.toMatch(/10\.0\.0\.99|private-host|Users|\/var\/run|fd00|private-server|private-box/);
  });

  test('drops location-bearing object keys recursively', () => {
    expect(sanitizePublicProjection({
      status: 'degraded',
      detail: { endpoint: 'bare-host:11434', socketPath: '/var/run/private.sock' },
      observedAt: new Date('2026-08-28T00:00:00.000Z'),
    })).toEqual({
      status: 'degraded',
      detail: {},
      observedAt: '2026-08-28T00:00:00.000Z',
    });
  });
});
