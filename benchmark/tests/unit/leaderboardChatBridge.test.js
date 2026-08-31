'use strict';

const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '../..');
const source = fs.readFileSync(path.join(root, 'public/js/leaderboard-v2/combined-board.js'), 'utf8');
const view = fs.readFileSync(path.join(root, 'views/pages/leaderboard.ejs'), 'utf8');

describe('Leaderboard to Chat bridge', () => {
  test('uses the configured Core public front door with exact model and host', () => {
    expect(view).toContain('data-core-public-url="<%= publicUrls.core %>"');
    expect(source).toContain("new URL('/playground', configuredCore)");
    expect(source).toContain("url.searchParams.set('model', entry.model)");
    expect(source).toContain("url.searchParams.set('host', entry.host)");
  });

  test('does not offer a deleted or unavailable model', () => {
    expect(source).toContain('entry?.host_available === false');
    expect(source).toContain('Use in Chat');
  });
});
