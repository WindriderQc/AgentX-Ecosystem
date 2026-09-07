'use strict';

const fs = require('fs');
const path = require('path');
const request = require('supertest');
const { app } = require('../../src/app');

const ROOT = path.resolve(__dirname, '..', '..', '..');

function read(relativePath) {
  return fs.readFileSync(path.join(ROOT, relativePath), 'utf8');
}

describe('AgentX Council surface', () => {
  it('mounts the preserved Roundtable API behind the canonical Council page', () => {
    const app = read('core/src/app.js');

    expect(app).toMatch(/app\.use\(['"]\/api\/roundtable['"], roundtableRoutes\)/);
    expect(app).toMatch(/app\.get\(['"]\/council/);
    expect(app).toMatch(/app\.get\(['"]\/roundtable/);
    expect(app).toContain("title: 'AgentX \\u2022 Council'");
  });

  it('links Council from AgentX surfaces and declares the advisory boundary', () => {
    const linkedSources = [
      read('shared/productNavigation.js'),
      read('core/public/js/chat/chat-main.js'),
    ];

    linkedSources.forEach((source) => expect(source).toMatch(/\/council/));
    expect(read('core/views/pages/home.ejs')).not.toMatch(/href="http:\/\/localhost:3080\/council"/);
    expect(read('core/views/pages/chat.ejs')).toContain('id="roundtableBtn"');
    // The Playground button is an explicit handoff, never a convening action:
    // it must not promise a Council answer it cannot produce in place.
    expect(read('core/views/pages/chat.ejs')).toContain('aria-label="Open in Council"');
    expect(read('core/views/pages/chat.ejs')).not.toContain('aria-label="Ask Council"');
    const chatMain = read('core/public/js/chat/chat-main.js');
    expect(chatMain).not.toContain("window.open('/council");
    expect(chatMain).toContain("'/council?question=' + encodeURIComponent(text) + '&source=playground'");
    expect(chatMain).toContain("link.rel = 'noopener'");
    expect(chatMain).toContain('Question handed to Council in a new tab');
    expect(read('core/public/js/roundtable.js')).toContain("get('source') === 'playground' ? 'playground-handoff' : 'web-ui'");
    expect(read('core/views/pages/roundtable.ejs')).toContain('Council is advisory');
  });

  it('makes model readiness explicit and does not imply a model download', () => {
    const page = read('core/views/pages/roundtable.ejs');
    const client = read('core/public/js/roundtable.js');

    expect(page).toContain('id="formModelReadiness"');
    expect(page).toContain('id="councilModelOptions"');
    expect(page).toMatch(/id="formStartBtn"[^>]*disabled/);
    expect(client).toContain('data.readiness');
    expect(client).toContain('Council never downloads a model implicitly');
    expect(client).toContain("href=\"/models\"");
  });

  it('renders Council and preserves old question links through redirects', async () => {
    const page = await request(app).get('/council');
    expect(page.status).toBe(200);
    expect(page.text).toMatch(/bounded multi-model deliberation/i);
    expect(page.text).toContain('/js/roundtable.js');

    const legacy = await request(app).get('/roundtable?question=Compare%20these');
    expect(legacy.status).toBe(301);
    expect(legacy.headers.location).toBe('/council?question=Compare%20these');
  });
});
