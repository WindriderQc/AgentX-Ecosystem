const { parseCompactNumber, observedLabel, knowledgeUsagePhrase } = require('../../public/js/analytics-experience');

describe('analytics experience knowledge-usage phrase', () => {
  test('repeats a low-sample rate with its n instead of presenting it as adoption', () => {
    expect(knowledgeUsagePhrase('100.0%', 'insufficient_sample', 'n=1 of 5 needed'))
      .toBe('100.0% of conversations used knowledge (low sample, n=1 of 5 needed)');
  });

  test('phrases an observed rate plainly', () => {
    expect(knowledgeUsagePhrase('42.0%', 'observed', 'n=50')).toBe('42.0% of conversations used knowledge');
    expect(knowledgeUsagePhrase('42.0%', undefined, undefined)).toBe('42.0% of conversations used knowledge');
  });

  test.each(['missing', 'unavailable', 'disabled', 'not_applicable', 'stale'])('never phrases a %s tile as usage', (state) => {
    expect(knowledgeUsagePhrase('100.0%', state, 'n=0')).toBeNull();
  });

  test('never phrases the placeholder as usage', () => {
    expect(knowledgeUsagePhrase('—', 'missing', 'n=0')).toBeNull();
    expect(knowledgeUsagePhrase('', undefined, undefined)).toBeNull();
  });
});

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
