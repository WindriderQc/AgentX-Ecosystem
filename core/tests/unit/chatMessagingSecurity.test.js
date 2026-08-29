'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

describe('chat messaging browser security boundary', () => {
  const source = fs.readFileSync(
    path.resolve(__dirname, '../../public/js/chat/chat-messaging.js'),
    'utf8'
  );

  test('sanitizes model-controlled thinking markdown before assigning innerHTML', () => {
    expect(source).toMatch(
      /thinkingDiv\.innerHTML\s*=\s*sanitizeHTML\(`<strong>Thinking:<\/strong><br>\$\{marked\.parse\(thinkingContent\)\}`\)/
    );
    expect(source).not.toMatch(
      /thinkingDiv\.innerHTML\s*=\s*`[^`]*\$\{marked\.parse\(thinkingContent\)\}/
    );
  });

  test('fails closed by escaping hostile markup when DOMPurify is unavailable', () => {
    const start = source.indexOf('function sanitizeHTML');
    const end = source.indexOf('// Exported for use by other modules');
    const context = { console: { error: jest.fn() } };
    vm.createContext(context);
    vm.runInContext(`${source.slice(start, end)}\nthis.sanitizeHTML = sanitizeHTML;`, context);

    const rendered = context.sanitizeHTML('<img src=x onerror="globalThis.pwned=true">');
    expect(rendered).not.toContain('<img');
    expect(rendered).toContain('&lt;img');
    expect(context.pwned).toBeUndefined();
  });

  test('allowlists web-source protocols and numeric search-result counts', () => {
    expect(source).toContain('link.href = safeExternalUrl(result.url);');
    expect(source).toMatch(/parsed\.protocol === 'http:' \|\| parsed\.protocol === 'https:'/);
    expect(source).toContain('Number.isInteger(data.resultCount) && data.resultCount >= 0');
  });
});
