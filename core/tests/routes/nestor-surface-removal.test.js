'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..', '..');

function read(relativePath) {
  return fs.readFileSync(path.join(ROOT, relativePath), 'utf8');
}

describe('Gate B Nestor surface extraction', () => {
  it('removes the Buddy page, redirects, navigation, panel tile, and layout injection', () => {
    const app = read('core/src/app.js');
    const layout = read('core/views/layouts/main.ejs');
    const nav = read('core/views/partials/nav.ejs');
    const panel = read('core/views/pages/panel.ejs');

    expect(app).not.toMatch(/app\.get\(['"]\/buddy/);
    expect(app).not.toContain('showBuddy');
    expect(layout).not.toMatch(/buddy-slot|__BUDDY_LAYOUT|agentx_buddy_/);
    expect(nav).not.toMatch(/href:\s*coreBase\s*\+\s*['"]\/buddy/);
    expect(panel).not.toContain('href="/buddy"');
  });

  it('removes widget assets and cross-service widget proxies while preserving compatibility APIs', () => {
    const removed = [
      'core/views/pages/buddy.ejs',
      'core/views/partials/buddy-slot.ejs',
      'core/public/js/buddy-page.js',
      'core/public/js/components/buddy.js',
      'core/public/css/buddy.css',
      'benchmark/routes/buddy-proxy.js',
      'benchmark/routes/buddy-assets-proxy.js',
      'rag/routes/buddy-proxy.js',
      'rag/routes/buddy-assets-proxy.js',
    ];
    removed.forEach((relativePath) => {
      expect(fs.existsSync(path.join(ROOT, relativePath))).toBe(false);
    });

    const app = read('core/src/app.js');
    expect(app).toContain('isLegacyBuddyApiEnabled()');
    expect(app).toContain("app.use('/api/buddy', buddyRoutes)");
    expect(app).toContain("'/api/consumers/nestor/v1'");
    expect(app).toContain("app.use('/api/platform-events'");
    expect(fs.existsSync(path.join(ROOT, 'core/models/Buddy.js'))).toBe(true);
    expect(fs.existsSync(path.join(ROOT, 'core/src/services/buddyNotesFile.js'))).toBe(true);
  });

  it('moves active platform producers off the legacy Buddy event alias', () => {
    const producers = [
      read('benchmark/src/clients/buddyEventClient.js'),
      read('rag/src/clients/buddyEventClient.js'),
      read('core/src/services/liveDataWatcher.js'),
    ];
    producers.forEach((source) => {
      expect(source).toContain('/api/platform-events');
      expect(source).not.toContain('/api/buddy/emit');
    });
  });

  it('passes the Nestor release-gate controls into the production Core container', () => {
    const compose = read('docker-compose.yml');
    const dockerfile = read('docker/core.Dockerfile');
    const dockerignore = read('.dockerignore');
    expect(compose).toContain('AGENTX_OPERATOR_TOKEN=${AGENTX_OPERATOR_TOKEN:-}');
    expect(compose).toContain(
      'AGENTX_ENABLE_LEGACY_BUDDY_API=${AGENTX_ENABLE_LEGACY_BUDDY_API:-true}'
    );
    expect(dockerfile).toContain('COPY roles/Nestor.md /app/roles/Nestor.md');
    expect(dockerfile).toContain('ENV AGENTX_NESTOR_ROLE=/app/roles/Nestor.md');
    expect(dockerignore).toContain('!roles/Nestor.md');
  });

  it('enforces the Nestor payload limit before the global compatibility parser', () => {
    const app = read('core/src/app.js');
    expect(app.indexOf("app.use('/api/consumers/nestor/v1', requireNestorJsonEntity, chatJsonParser)"))
      .toBeLessThan(app.indexOf("app.use(express.json({ limit: '50mb' }))"));
  });
});
