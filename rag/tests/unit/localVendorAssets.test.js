'use strict';

const fs = require('node:fs');
const path = require('node:path');
const request = require('supertest');
const app = require('../../app');
const packageJson = require('../../package.json');

function scriptSources(html) {
  return Array.from(String(html).matchAll(/<script\b[^>]*\bsrc=(["'])(.*?)\1/gi), (match) => match[2]);
}

function stylesheetSources(html) {
  return Array.from(String(html).matchAll(/<link\b(?=[^>]*\brel=(["'])[^"']*\bstylesheet\b[^"']*\1)[^>]*\bhref=(["'])(.*?)\2[^>]*>/gi), (match) => match[3]);
}

describe('RAG local browser vendors', () => {
  test('canonical pages use only same-origin runtime scripts and stylesheets', async () => {
    for (const page of ['/', '/documents', '/search', '/upload', '/maintenance']) {
      const response = await request(app)
        .get(page)
        .expect(200)
        .expect('Content-Type', /html/);

      expect(scriptSources(response.text).filter((source) => /^https?:\/\//i.test(source))).toEqual([]);
      const stylesheets = stylesheetSources(response.text);
      expect(stylesheets.filter((source) => /^https?:\/\//i.test(source))).toEqual([]);
      expect(stylesheets).toEqual(expect.arrayContaining([
        '/css/local-fonts.css',
        '/vendor/fontawesome/6.4.0/css/all.min.css',
      ]));
    }
  });

  test.each([
    ['/vendor/fontawesome/6.4.0/css/all.min.css', /css/, 'Font Awesome Free 6.4.0'],
    ['/vendor/fontawesome/6.4.0/webfonts/fa-regular-400.woff2', /font\/woff2/, null],
    ['/vendor/fonts/space-grotesk/5.3.0/files/space-grotesk-latin-wght-normal.woff2', /font\/woff2/, null],
    ['/vendor/fonts/ibm-plex-mono/5.3.0/files/ibm-plex-mono-latin-600-normal.woff2', /font\/woff2/, null],
  ])('serves pinned local style asset %s', async (asset, contentType, signature) => {
    const response = await request(app)
      .get(asset)
      .expect(200)
      .expect('Content-Type', contentType)
      .expect('Cache-Control', 'public, max-age=31536000, immutable');

    if (signature) expect(response.text).toContain(signature);
    else expect(Buffer.isBuffer(response.body) && response.body.length > 1000).toBe(true);
  });

  test('has no remote CSS import and does not expose dependency metadata', async () => {
    const styleSource = fs.readFileSync(path.join(__dirname, '..', '..', 'public', 'css', 'style.css'), 'utf8');
    expect(styleSource).not.toMatch(/@import\s+(?:url\()?['"]?https?:\/\//i);

    await request(app).get('/vendor/express/package.json').expect(404);
    await request(app).get('/vendor/fonts/ibm-plex-mono/5.3.0/package.json').expect(404);
    await request(app).get('/vendor/fontawesome/6.4.0/package.json').expect(404);
    expect(packageJson.dependencies).toMatchObject({
      '@fontsource-variable/space-grotesk': '5.3.0',
      '@fontsource/ibm-plex-mono': '5.3.0',
      '@fortawesome/fontawesome-free': '6.4.0',
    });
  });
});
