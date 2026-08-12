'use strict';

const {
  isNestorMigrationNotesBypassAllowed,
} = require('../../src/middleware/rateLimiter');

function request({ ip, token = '', path = '/api/consumers/nestor/v1/migration/notes' }) {
  return {
    method: 'GET',
    originalUrl: `${path}?snapshotId=test`,
    ip,
    get(name) {
      if (name.toLowerCase() === 'x-agentx-operator-token') return token;
      return '';
    },
  };
}

describe('Nestor migration notes rate-limit bypass', () => {
  const originalToken = process.env.AGENTX_OPERATOR_TOKEN;

  beforeEach(() => {
    process.env.AGENTX_OPERATOR_TOKEN = 'expected-operator-token';
  });

  afterAll(() => {
    if (originalToken === undefined) delete process.env.AGENTX_OPERATOR_TOKEN;
    else process.env.AGENTX_OPERATOR_TOKEN = originalToken;
  });

  it('allows only loopback or a valid operator token on the exact notes route', () => {
    expect(isNestorMigrationNotesBypassAllowed(request({ ip: '127.0.0.1' }))).toBe(true);
    expect(isNestorMigrationNotesBypassAllowed(request({
      ip: '192.0.2.40',
      token: 'expected-operator-token',
    }))).toBe(true);
    expect(isNestorMigrationNotesBypassAllowed(request({ ip: '192.0.2.40' }))).toBe(false);
    expect(isNestorMigrationNotesBypassAllowed(request({
      ip: '192.0.2.40',
      token: 'wrong-token',
    }))).toBe(false);
    expect(isNestorMigrationNotesBypassAllowed(request({
      ip: '127.0.0.1',
      path: '/api/consumers/nestor/v1/migration/profile',
    }))).toBe(false);
  });
});
