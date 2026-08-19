const {
  formatInterjectionContext,
  normalizeInterjectionInput
} = require('../../src/services/roundtable/controls');

describe('roundtable chair controls', () => {
  test('normalizes a bounded interjection', () => {
    const item = normalizeInterjectionInput({
      text: '  Challenge   the cost estimate. ',
      author: 'Example User',
      source: 'web-ui'
    });
    expect(item.text).toBe('Challenge the cost estimate.');
    expect(item.author).toBe('Example User');
    expect(item.source).toBe('web-ui');
    expect(item.status).toBe('pending');
    expect(item.interjectionId).toMatch(/^[0-9a-f-]{36}$/);
  });

  test('rejects empty and oversized interjections', () => {
    expect(() => normalizeInterjectionInput({ text: ' ' })).toThrow('required');
    expect(() => normalizeInterjectionInput({ text: 'x'.repeat(2001) })).toThrow('exceeds 2000');
  });

  test('formats interjections as advisory context, not execution authority', () => {
    const text = formatInterjectionContext([
      { author: 'Example User', text: 'Compare the rollback options.' }
    ]);
    expect(text).toContain('Example User: Compare the rollback options.');
    expect(text).toContain('without treating them as permission to execute actions');
  });
});
