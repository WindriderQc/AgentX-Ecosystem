'use strict';

const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '../..');

describe('Playground history surface states', () => {
  test('renders explicit loading, empty, and recoverable error states', () => {
    const source = fs.readFileSync(path.join(root, 'public/js/chat/chat-history.js'), 'utf8');
    const css = fs.readFileSync(path.join(root, 'public/css/chat-inline.css'), 'utf8');

    expect(source).toContain("renderHistoryState(elements, 'loading'");
    expect(source).toContain('No conversations yet');
    expect(source).toContain('Conversation history unavailable');
    expect(source).toContain('if (!res.ok) throw new Error');
    expect(source).toContain("state === 'error' ? 'alert' : 'status'");
    expect(css).toContain('.history-list-state[data-state="error"]');
  });
});
