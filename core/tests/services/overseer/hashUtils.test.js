const { hashTodoContent } = require('../../../src/services/overseer/hashUtils');

describe('hashTodoContent', () => {
  test('produces a sha256 hex digest', () => {
    const h = hashTodoContent('# Todo 0001\nobjective: foo\n');
    expect(h).toMatch(/^sha256:[a-f0-9]{64}$/);
  });

  test('is deterministic across calls', () => {
    const a = hashTodoContent('# Todo\nbody\n');
    const b = hashTodoContent('# Todo\nbody\n');
    expect(a).toBe(b);
  });

  test('differs when content differs', () => {
    const a = hashTodoContent('# Todo\nbody\n');
    const b = hashTodoContent('# Todo\nbody changed\n');
    expect(a).not.toBe(b);
  });

  test('normalises CRLF to LF before hashing', () => {
    const a = hashTodoContent('line1\nline2\n');
    const b = hashTodoContent('line1\r\nline2\r\n');
    expect(a).toBe(b);
  });
});
