'use strict';

const fs = require('node:fs');
const path = require('node:path');
const request = require('supertest');
const app = require('../../app');

const ragRoot = path.resolve(__dirname, '..', '..');
const appSource = fs.readFileSync(path.join(ragRoot, 'app.js'), 'utf8');

function routeBlock(route) {
  const start = appSource.indexOf(`app.get('${route}'`);
  if (start < 0) throw new Error(`Missing route ${route}`);
  const end = appSource.indexOf('\n});', start);
  return appSource.slice(start, end);
}

function openingTag(html, href, classToken = '') {
  const escapedHref = href.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const matches = html.match(new RegExp(`<a\\s+href="${escapedHref}"[^>]*>`, 'g')) || [];
  return classToken ? matches.find((tag) => tag.includes(classToken)) : matches[0];
}

describe('RAG page journey identities', () => {
  test.each([
    ['/documents', 'rag-documents'],
    ['/search', 'rag-search'],
    ['/upload', 'rag-upload'],
    ['/maintenance', 'rag-maintenance'],
  ])('%s renders its distinct shared-navigation identity', (route, activePage) => {
    expect(routeBlock(route)).toContain(`activePage: '${activePage}'`);
  });

  test.each([
    ['/documents', '/documents'],
    ['/search', '/search'],
    ['/upload', '/upload'],
  ])('%s marks the matching shared Knowledge link as current', async (route, href) => {
    const response = await request(app).get(route).expect(200).expect('Content-Type', /html/);
    const tag = openingTag(response.text, href);

    expect(tag).toContain('dropdown-item active');
    expect(tag).toContain('aria-current="page"');
  });

  test('maintenance marks the local instruments destination as current', async () => {
    const response = await request(app).get('/maintenance').expect(200).expect('Content-Type', /html/);
    const tag = openingTag(response.text, '/maintenance', 'is-current');

    expect(tag).toContain('is-current');
    expect(tag).toContain('aria-current="page"');
  });
});
