const { parseCompactNumber, observedLabel } = require('../../public/js/analytics-experience');

describe('analytics experience number parsing', () => {
  test.each([
    ['7.2k', 7200],
    ['1.5M', 1500000],
    ['2b', 2000000000],
    ['12,345', 12345],
    ['18 failed', 18],
    ['-1.2k', -1200],
  ])('expands %s into its observed count', (value, expected) => {
    expect(parseCompactNumber(value)).toBe(expected);
  });

  test.each(['', '—', 'not observed', null, undefined])('keeps %s unknown', (value) => {
    expect(parseCompactNumber(value)).toBeNull();
  });

  test.each(['', '—', '--', 'N/A', 'unknown', 'loading…', null])('does not label %s as observed evidence', (value) => {
    expect(observedLabel(value)).toBeNull();
  });

  test.each(['0.0%', '17.4%', 'last 7 days'])('preserves observed label %s', (value) => {
    expect(observedLabel(value)).toBe(value);
  });
});
