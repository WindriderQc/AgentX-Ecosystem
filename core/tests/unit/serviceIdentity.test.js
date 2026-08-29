'use strict';

const {
  UNKNOWN_REVISION,
  normalizeRevision,
  createServiceIdentity,
} = require('../../../shared/serviceIdentity');

describe('service identity', () => {
  test('returns one canonical release and profile envelope', () => {
    expect(createServiceIdentity({
      service: 'agentx-core',
      version: '1.2.3',
      env: { AGENTX_PROFILE: 'full', AGENTX_BUILD_REVISION: 'abc123def' },
      now: () => new Date('2026-08-28T12:00:00.000Z'),
    })).toEqual({
      service: 'agentx-core',
      version: '1.2.3',
      profile: 'full',
      revision: 'abc123def',
      ts: '2026-08-28T12:00:00.000Z',
    });
  });

  test('uses product-safe defaults and never reflects unsafe revision text', () => {
    expect(normalizeRevision('bad revision\nheader')).toBe(UNKNOWN_REVISION);
    expect(createServiceIdentity({
      service: 'agentx-rag',
      version: '0.1.1',
      env: { AGENTX_BUILD_REVISION: '<script>alert(1)</script>' },
      now: () => '2026-08-28T12:00:00.000Z',
    })).toEqual(expect.objectContaining({
      profile: 'demo',
      revision: UNKNOWN_REVISION,
    }));
  });
});
