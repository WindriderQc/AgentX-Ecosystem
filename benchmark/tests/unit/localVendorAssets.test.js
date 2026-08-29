'use strict';

const request = require('supertest');
const vm = require('vm');
const app = require('../../server');
const packageJson = require('../../package.json');

function scriptSources(html) {
  return Array.from(String(html).matchAll(/<script\b[^>]*\bsrc=(["'])(.*?)\1/gi), (match) => match[2]);
}

function stylesheetSources(html) {
  return Array.from(String(html).matchAll(/<link\b(?=[^>]*\brel=(["'])[^"']*\bstylesheet\b[^"']*\1)[^>]*\bhref=(["'])(.*?)\2[^>]*>/gi), (match) => match[3]);
}

describe('Benchmark local browser vendors', () => {
  test('renders the shared Core head-assets partial with same-origin runtime assets', async () => {
    const response = await request(app)
      .get('/results-explorer')
      .expect(200)
      .expect('Content-Type', /html/);

    const sources = scriptSources(response.text);
    expect(sources.filter((source) => /^https?:\/\//i.test(source))).toEqual([]);
    expect(sources).toContain('/vendor/chart.js/4.4.1/chart.umd.js');

    const stylesheets = stylesheetSources(response.text);
    expect(stylesheets.filter((source) => /^https?:\/\//i.test(source))).toEqual([]);
    expect(stylesheets).toEqual(expect.arrayContaining([
      '/css/local-fonts.css',
      '/vendor/fontawesome/6.4.0/css/all.min.css',
    ]));
  });

  test('serves the pinned Chart.js asset from the explicit allowlist only', async () => {
    const response = await request(app)
      .get('/vendor/chart.js/4.4.1/chart.umd.js')
      .expect(200)
      .expect('Content-Type', /javascript/)
      .expect('Cache-Control', 'public, max-age=31536000, immutable');

    expect(response.text).toContain('Chart.js v4.4.1');
    const browser = { console, setTimeout, clearTimeout };
    browser.window = browser;
    browser.self = browser;
    browser.globalThis = browser;
    vm.runInNewContext(response.text, browser);
    expect(browser.Chart.version).toBe('4.4.1');
    expect(packageJson.dependencies['chart.js']).toBe('4.4.1');
    await request(app).get('/vendor/express/package.json').expect(404);
  });

  test.each([
    ['/vendor/fontawesome/6.4.0/css/all.min.css', /css/, 'Font Awesome Free 6.4.0'],
    ['/vendor/fontawesome/6.4.0/webfonts/fa-solid-900.woff2', /font\/woff2/, null],
    ['/vendor/fonts/space-grotesk/5.3.0/files/space-grotesk-latin-wght-normal.woff2', /font\/woff2/, null],
    ['/vendor/fonts/ibm-plex-mono/5.3.0/files/ibm-plex-mono-latin-400-normal.woff2', /font\/woff2/, null],
  ])('serves pinned local style asset %s', async (asset, contentType, signature) => {
    const response = await request(app)
      .get(asset)
      .expect(200)
      .expect('Content-Type', contentType)
      .expect('Cache-Control', 'public, max-age=31536000, immutable');

    if (signature) expect(response.text).toContain(signature);
    else expect(Buffer.isBuffer(response.body) && response.body.length > 1000).toBe(true);
  });

  test('keeps node_modules private while declaring every style dependency explicitly', async () => {
    await request(app).get('/vendor/fonts/space-grotesk/5.3.0/package.json').expect(404);
    await request(app).get('/vendor/fontawesome/6.4.0/package.json').expect(404);
    expect(packageJson.dependencies).toMatchObject({
      '@fontsource-variable/space-grotesk': '5.3.0',
      '@fontsource/ibm-plex-mono': '5.3.0',
      '@fortawesome/fontawesome-free': '6.4.0',
    });
  });
});
