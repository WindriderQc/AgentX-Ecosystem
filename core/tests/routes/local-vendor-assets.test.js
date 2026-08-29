'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const request = require('supertest');
const { app } = require('../../src/app');
const packageJson = require('../../package.json');
const { localStyleVendorAssets } = require('../../../shared/localStyleVendorAssets');

function scriptSources(html) {
  return Array.from(String(html).matchAll(/<script\b[^>]*\bsrc=(["'])(.*?)\1/gi), (match) => match[2]);
}

function stylesheetSources(html) {
  return Array.from(String(html).matchAll(/<link\b(?=[^>]*\brel=(["'])[^"']*\bstylesheet\b[^"']*\1)[^>]*\bhref=(["'])(.*?)\2[^>]*>/gi), (match) => match[3]);
}

function localAssetUrls(css, stylesheetRoute) {
  return Array.from(new Set(Array.from(
    String(css).matchAll(/url\((['"]?)(?!data:)([^)'"\s]+)\1\)/gi),
    (match) => new URL(match[2], `http://agentx.test${stylesheetRoute}`).pathname
  )));
}

function executeAsBrowserScript(source) {
  const context = { console, setTimeout, clearTimeout };
  context.window = context;
  context.self = context;
  context.globalThis = context;
  vm.runInNewContext(source, context);
  return context;
}

describe('Core local browser vendors', () => {
  test.each([
    ['/playground', [
      '/vendor/marked/18.0.11/marked.umd.js',
      '/vendor/dompurify/3.4.14/purify.min.js'
    ]],
    ['/nerve-center', ['/vendor/chart.js/4.5.1/chart.umd.js']],
    ['/analytics', ['/vendor/chart.js/4.4.4/chart.umd.js']],
    ['/performance', ['/vendor/chart.js/4.4.4/chart.umd.js']]
  ])('%s contains only same-origin script sources', async (page, expectedVendors) => {
    const response = await request(app)
      .get(page)
      .expect(200)
      .expect('Content-Type', /html/);

    const sources = scriptSources(response.text);
    expect(sources.filter((source) => /^https?:\/\//i.test(source))).toEqual([]);
    expect(sources).toEqual(expect.arrayContaining(expectedVendors));

    const stylesheets = stylesheetSources(response.text);
    expect(stylesheets.filter((source) => /^https?:\/\//i.test(source))).toEqual([]);
    expect(stylesheets).toEqual(expect.arrayContaining([
      '/css/local-fonts.css',
      '/vendor/fontawesome/6.4.0/css/all.min.css',
    ]));
  });

  test.each([
    ['/vendor/chart.js/4.4.4/chart.umd.js', 'Chart.js v4.4.4', 'Chart', '4.4.4'],
    ['/vendor/chart.js/4.5.1/chart.umd.js', 'Chart.js v4.5.1', 'Chart', '4.5.1'],
    ['/vendor/marked/18.0.11/marked.umd.js', 'marked v18.0.11', 'marked', null],
    ['/vendor/dompurify/3.4.14/purify.min.js', 'DOMPurify 3.4.14', 'DOMPurify', '3.4.14']
  ])('serves pinned asset %s from the explicit allowlist', async (asset, signature, globalName, version) => {
    const response = await request(app)
      .get(asset)
      .expect(200)
      .expect('Content-Type', /javascript/)
      .expect('Cache-Control', 'public, max-age=31536000, immutable');

    expect(response.text).toContain(signature);
    const browser = executeAsBrowserScript(response.text);
    expect(browser[globalName]).toBeDefined();
    if (version) expect(browser[globalName].version).toBe(version);
    if (globalName === 'marked') expect(typeof browser.marked.parse).toBe('function');
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

  test('serves the shared font declarations without a remote import', async () => {
    const response = await request(app)
      .get('/css/local-fonts.css')
      .expect(200)
      .expect('Content-Type', /css/);

    expect(response.text).toContain("font-family: 'Space Grotesk'");
    expect(response.text).toContain("font-family: 'IBM Plex Mono'");
    expect(response.text).not.toMatch(/@import\s+(?:url\()?['"]?https?:\/\//i);
  });

  test('serves every font file referenced by the pinned stylesheets', async () => {
    const declarations = localStyleVendorAssets(path.join(__dirname, '..', '..', 'node_modules'));
    const declaredRoutes = new Set(declarations.map((asset) => asset.route));
    expect(declarations.every((asset) => fs.existsSync(asset.file))).toBe(true);

    for (const stylesheet of [
      '/css/local-fonts.css',
      '/vendor/fontawesome/6.4.0/css/all.min.css',
    ]) {
      const css = await request(app).get(stylesheet).expect(200);
      const assets = localAssetUrls(css.text, stylesheet);
      expect(assets.length).toBeGreaterThan(0);
      for (const asset of assets) {
        expect(declaredRoutes.has(asset)).toBe(true);
      }
    }
  });

  test('does not expose arbitrary dependency files or a CDN script exception', async () => {
    await request(app).get('/vendor/express/package.json').expect(404);
    await request(app).get('/vendor/fonts/space-grotesk/5.3.0/package.json').expect(404);
    await request(app).get('/vendor/fontawesome/6.4.0/package.json').expect(404);

    const appSource = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'app.js'), 'utf8');
    expect(appSource).not.toContain('cdn.jsdelivr.net');
    expect(appSource).not.toMatch(/fonts\.googleapis\.com|fonts\.gstatic\.com|cdnjs\.cloudflare\.com/);
    expect(packageJson.dependencies).toMatchObject({
      '@fontsource-variable/space-grotesk': '5.3.0',
      '@fontsource/ibm-plex-mono': '5.3.0',
      '@fortawesome/fontawesome-free': '6.4.0',
      'chart.js': '4.4.4',
      'chartjs-4-5-1': 'npm:chart.js@4.5.1',
      dompurify: '3.4.14',
      marked: '18.0.11'
    });
  });
});
