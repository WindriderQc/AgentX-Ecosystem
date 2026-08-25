'use strict';

const { describeHost } = require('../../src/services/hostIdentityService');

describe('hostIdentityService', () => {
  test('uses display name as primary identity and role/IP as secondary facts', () => {
    const identity = describeHost('http://192.0.2.199:11434', 'primary', [{
      id: 'primary',
      name: 'UGAlien',
      url: 'http://192.0.2.199:11434',
    }]);

    expect(identity).toEqual({
      key: 'primary',
      displayName: 'UGAlien',
      role: 'primary',
      ip: '192.0.2.199',
      url: 'http://192.0.2.199:11434',
    });
  });
});
