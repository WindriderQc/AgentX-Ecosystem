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
    expect(app).toMatch(/app\.get\(['"]\/roundtable\.html/);
    expect(app).toContain("title: 'AgentX \\u2022 Council'");
  });

  it('links Council from AgentX surfaces and declares the advisory boundary', () => {
    const linkedSources = [
      read('core/views/partials/nav.ejs'),
      read('core/public/js/chat/chat-main.js'),
    ];

    linkedSources.forEach((source) => expect(source).toMatch(/\/council/));
    expect(read('core/public/portal/index.html')).not.toMatch(/href="http:\/\/localhost:3080\/council"/);
    expect(read('core/views/pages/chat.ejs')).toContain('id="roundtableBtn"');
    expect(read('core/views/pages/chat.ejs')).toContain('Ask Council');
    expect(read('core/views/pages/roundtable.ejs')).toContain('Council is advisory');
  });

  it('renders Council and preserves old question links through redirects', async () => {
    const page = await request(app).get('/council');
    expect(page.status).toBe(200);
    expect(page.text).toMatch(/bounded multi-model deliberation/i);
    expect(page.text).toContain('/js/roundtable.js');

    const legacy = await request(app).get('/roundtable?question=Compare%20these');
    expect(legacy.status).toBe(301);
    expect(legacy.headers.location).toBe('/council?question=Compare%20these');

    const legacyHtml = await request(app).get('/roundtable.html?question=Compare%20again');
    expect(legacyHtml.status).toBe(301);
    expect(legacyHtml.headers.location).toBe('/council?question=Compare%20again');
  });
});
