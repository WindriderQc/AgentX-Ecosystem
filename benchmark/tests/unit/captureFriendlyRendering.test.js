'use strict';

const fs = require('fs');
const path = require('path');

function read(...segments) {
  return fs.readFileSync(path.join(__dirname, '..', '..', ...segments), 'utf8');
}

function rule(source, selector) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = source.match(new RegExp(`${escaped}\\s*\\{([^}]+)\\}`));
  if (!match) throw new Error(`Missing CSS rule for ${selector}`);
  return match[1];
}

describe('capture-friendly shared rendering', () => {
  test('keeps sticky navigation without a viewport backdrop blur', () => {
    const chrome = read('..', 'core', 'public', 'css', 'platform-chrome.css');
    const navContainer = rule(chrome, '#nav-container');
    const topNav = rule(chrome, '.top-nav');

    expect(navContainer).toMatch(/position:\s*sticky/);
    expect(topNav).not.toMatch(/backdrop-filter\s*:/);
    expect(topNav).toMatch(/background:\s*linear-gradient/);
  });

  test('uses one page-sized background layer on benchmark surfaces', () => {
    const components = read('public', 'css', 'redesign-components.css');
    const body = rule(components, 'body');

    expect(body).not.toMatch(/radial-gradient/);
    expect(body.match(/gradient\(/g) || []).toHaveLength(1);
  });
});
