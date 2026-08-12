const fs = require('fs');
const os = require('os');
const path = require('path');
const { diffTodos } = require('../../../src/services/overseer/todoDiffer');

function writeTodo(dir, filename, body) {
  fs.writeFileSync(path.join(dir, filename), body);
}

describe('diffTodos', () => {
  let tmpDir;
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'overseer-todos-'));
  });
  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('returns empty when no TODO files exist', () => {
    const { changed, nextHashes } = diffTodos(tmpDir, {});
    expect(changed).toEqual([]);
    expect(nextHashes).toEqual({});
  });

  test('flags all TODOs when state is empty', () => {
    writeTodo(tmpDir, '0001-foo.md', 'content 1');
    writeTodo(tmpDir, '0002-bar.md', 'content 2');
    const { changed, nextHashes } = diffTodos(tmpDir, {});
    expect(changed.map(c => c.id).sort()).toEqual(['0001', '0002']);
    expect(Object.keys(nextHashes).sort()).toEqual(['0001', '0002']);
  });

  test('returns only changed TODOs when hashes match', () => {
    writeTodo(tmpDir, '0001-foo.md', 'content 1');
    writeTodo(tmpDir, '0002-bar.md', 'content 2');
    const { nextHashes } = diffTodos(tmpDir, {});

    writeTodo(tmpDir, '0002-bar.md', 'content 2 CHANGED');
    const { changed: changed2 } = diffTodos(tmpDir, nextHashes);
    expect(changed2.map(c => c.id)).toEqual(['0002']);
  });

  test('ignores files that do not match XXXX-*.md pattern', () => {
    writeTodo(tmpDir, 'README.md', 'readme');
    writeTodo(tmpDir, 'not-a-todo.md', 'nope');
    writeTodo(tmpDir, '0001-foo.md', 'yes');
    const { changed } = diffTodos(tmpDir, {});
    expect(changed.map(c => c.id)).toEqual(['0001']);
  });

  test('changed items include path and content', () => {
    writeTodo(tmpDir, '0001-foo.md', 'objective: thing');
    const { changed } = diffTodos(tmpDir, {});
    expect(changed[0]).toMatchObject({
      id: '0001',
      path: path.join(tmpDir, '0001-foo.md'),
      content: 'objective: thing'
    });
    expect(changed[0].hash).toMatch(/^sha256:/);
  });
});
