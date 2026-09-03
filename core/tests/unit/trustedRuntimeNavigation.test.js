'use strict';

const {
  MAX_RUNTIME_NAV_ITEMS,
  normalizeTrustedRuntimeNavItems,
} = require('../../src/extensions/trustedRuntimeNavigation');

describe('trusted runtime navigation contract', () => {
  test('keeps a bounded unique list of same-origin API launchers', () => {
    const input = Array.from({ length: MAX_RUNTIME_NAV_ITEMS + 3 }, (_, index) => ({
      id: `runtime-${index}`,
      label: `Runtime ${index}`,
      href: `/api/runtime-${index}/launch?view=home`,
      icon: 'fa-terminal',
    }));
    input.splice(1, 0, { ...input[0], label: 'Duplicate' });

    const result = normalizeTrustedRuntimeNavItems(input);
    expect(result).toHaveLength(MAX_RUNTIME_NAV_ITEMS);
    expect(result[0]).toEqual(input[0]);
    expect(result.filter((item) => item.id === 'runtime-0')).toHaveLength(1);
    expect(Object.isFrozen(result)).toBe(true);
  });

  test.each([
    ['external authority', 'https://runtime.example/'],
    ['protocol-relative authority', '//runtime.example/api/launch'],
    ['script URL', 'javascript:alert(1)'],
    ['non-API Product page', '/agent-ops'],
    ['backslash ambiguity', '/api/dsh\\launch'],
    ['embedded whitespace', '/api/dsh launch'],
  ])('rejects %s', (_label, href) => {
    expect(normalizeTrustedRuntimeNavItems([
      { id: 'dsh-studio', label: 'DSH Studio', href, icon: 'fa-terminal' },
    ])).toEqual([]);
  });

  test('rejects invalid presentation fields without throwing', () => {
    expect(normalizeTrustedRuntimeNavItems([
      { id: 'Bad ID', label: 'DSH Studio', href: '/api/dsh/launch', icon: 'fa-terminal' },
      { id: 'dsh-studio', label: '', href: '/api/dsh/launch', icon: 'fa-terminal' },
      { id: 'dsh-studio', label: 'DSH\nStudio', href: '/api/dsh/launch', icon: 'fa-terminal' },
      { id: 'dsh-studio', label: 'DSH Studio', href: '/api/dsh/launch', icon: 'terminal' },
      null,
    ])).toEqual([]);
  });
});
