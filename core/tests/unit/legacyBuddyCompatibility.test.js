'use strict';

const { isLegacyBuddyApiEnabled } = require('../../src/services/legacyBuddyCompatibility');

describe('legacy Buddy compatibility gate', () => {
  it('stays enabled by default for rolling upgrades', () => {
    expect(isLegacyBuddyApiEnabled({})).toBe(true);
    expect(isLegacyBuddyApiEnabled({ AGENTX_ENABLE_LEGACY_BUDDY_API: '' })).toBe(true);
  });

  it.each(['0', 'false', 'OFF', 'no', 'disabled'])(
    'disables the legacy routes for %s',
    (value) => {
      expect(isLegacyBuddyApiEnabled({ AGENTX_ENABLE_LEGACY_BUDDY_API: value })).toBe(false);
    }
  );

  it('keeps explicit truthy values enabled', () => {
    expect(isLegacyBuddyApiEnabled({ AGENTX_ENABLE_LEGACY_BUDDY_API: 'true' })).toBe(true);
    expect(isLegacyBuddyApiEnabled({ AGENTX_ENABLE_LEGACY_BUDDY_API: '1' })).toBe(true);
  });
});
