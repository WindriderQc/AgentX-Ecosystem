'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..', '..');

function read(relativePath) {
  return fs.readFileSync(path.join(ROOT, relativePath), 'utf8');
}

describe('OpenClaw browser-facing links', () => {
  it('does not hardcode workstation loopback URLs in browser surfaces', () => {
    const surfaces = [
      'core/views/partials/nav.ejs',
      'core/public/js/nerve-center-openclaw.js',
      'core/public/js/chat/chat-agents.js',
      'core/public/portal/index.html',
    ];

    surfaces.forEach((relativePath) => {
      const source = read(relativePath);
      expect(source).not.toMatch(/(?:127\.0\.0\.1|localhost):187(?:89|90)/);
    });
  });

  it('rewrites portal native links through the same-origin token handoff', () => {
    const portal = read('core/public/portal/index.html');
    expect(portal).toContain('data-openclaw-path="/chat"');
    expect(portal).toContain('data-openclaw-path="/agents"');
    expect(portal).toContain('data-openclaw-path="/tasks"');
    expect(portal).toContain('features?.openclaw?.controlUi?.launchBaseUrl');
    expect(portal).toContain('/api/openclaw/control-launch/');
  });

  it('publishes the resolved launch URL and avoids stale TLS-only guidance', () => {
    expect(read('core/src/app.js')).toContain(
      'app.locals.publicUrls.openclawControl = app.locals.openclawControl.launchBaseUrl'
    );
    expect(read('core/public/js/agent-ops.js')).not.toContain(
      'requires HTTPS or localhost for device identity'
    );
  });
});
