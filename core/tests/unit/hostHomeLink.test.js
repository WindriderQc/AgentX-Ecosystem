'use strict';

const {
  getHostHomeLink,
  normalizeHostHomeLabel,
  normalizeHostHomePath,
} = require('../../src/helpers/hostHomeLink');

describe('optional composing-host return link', () => {
  test('is disabled by default', () => {
    expect(getHostHomeLink({})).toBeNull();
  });

  test('accepts a same-origin root-relative path and neutral default label', () => {
    expect(getHostHomeLink({ AGENTX_HOST_HOME_URL: '/' })).toEqual({
      url: '/',
      label: 'Back to host',
    });
  });

  test('keeps deployment-owned text as plain bounded data', () => {
    expect(getHostHomeLink({
      AGENTX_HOST_HOME_URL: '/ecosystem?from=portal#top',
      AGENTX_HOST_HOME_LABEL: '  Mon   écosystème  ',
    })).toEqual({
      url: '/ecosystem?from=portal#top',
      label: 'Mon écosystème',
    });
    expect(normalizeHostHomeLabel('x'.repeat(100))).toHaveLength(80);
  });

  test.each([
    'https://private.example/',
    '//private.example/',
    'javascript:alert(1)',
    '/\\private.example/',
    '/bad\npath',
  ])('rejects a non-local or ambiguous path: %s', (value) => {
    expect(normalizeHostHomePath(value)).toBe('');
  });
});
