const fs = require('fs');
const path = require('path');
const ejs = require('ejs');

const navPath = path.join(__dirname, '../../views/partials/nav.ejs');
const portalPath = path.join(__dirname, '../../public/portal/index.html');
const publicUrls = {
  core: 'https://core.example',
  benchmark: 'http://bench.example:4181',
  rag: 'http://rag.example:4182',
  data: 'http://data.example:4183',
  openclawControl: 'http://claw.example:18789',
};

async function renderNav(service) {
  return ejs.renderFile(navPath, {
    service,
    activePage: 'nerve-center',
    publicUrls,
    reqHost: 'wrong-host.example',
  });
}

function hrefFor(html, label) {
  const anchors = [...html.matchAll(/<a\b[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g)];
  return anchors.find((match) => match[2].replace(/<[^>]+>/g, ' ').includes(label))?.[1];
}

describe('shared navigation public URL contract', () => {
  test('Core stays relative while cross-service links use authority and OpenClaw uses the secure handoff', async () => {
    const html = await renderNav('core');
    expect(hrefFor(html, 'Nerve Center')).toBe('/nerve-center');
    expect(hrefFor(html, 'Engine Room')).toBe('http://bench.example:4181/');
    expect(hrefFor(html, 'RAG Dashboard')).toBe('http://rag.example:4182/');
    expect(hrefFor(html, 'Runtime Chat')).toBe('/api/openclaw/control-launch/chat');
    expect(new URL(hrefFor(html, 'Nerve Center'), 'https://192.0.2.99').href)
      .toBe('https://192.0.2.99/nerve-center');
    expect(html).not.toContain('wrong-host.example');
  });

  test('Benchmark stays relative and its Nerve Center hop uses configured Core', async () => {
    const html = await renderNav('benchmark');
    expect(hrefFor(html, 'Engine Room')).toBe('/');
    expect(hrefFor(html, 'Nerve Center')).toBe('https://core.example/nerve-center');
    expect(hrefFor(html, 'RAG Dashboard')).toBe('http://rag.example:4182/');
    expect(hrefFor(html, 'Runtime Chat')).toBe('http://claw.example:18789/chat');
  });

  test('RAG stays relative and its Nerve Center hop uses configured Core', async () => {
    const html = await renderNav('rag');
    expect(hrefFor(html, 'RAG Dashboard')).toBe('/');
    expect(hrefFor(html, 'Nerve Center')).toBe('https://core.example/nerve-center');
    expect(hrefFor(html, 'Engine Room')).toBe('http://bench.example:4181/');
    expect(hrefFor(html, 'Runtime Chat')).toBe('http://claw.example:18789/chat');
  });

  test('nav source does not synthesize URLs from request hosts or service ports', () => {
    const source = fs.readFileSync(navPath, 'utf8');
    expect(source).not.toContain('reqHost');
    expect(source).not.toMatch(/localhost|127\.0\.0\.1|192\.168\.2\.|:308[0123]/);
  });

  test('portal uses the same publicUrls contract without hardcoded browser hosts', () => {
    const source = fs.readFileSync(portalPath, 'utf8');
    expect(source).toContain("publicUrls = cfg?.publicUrls || {}");
    expect(source).toContain("document.querySelectorAll('[data-public-service]')");
    expect(source).toContain('data-public-service="benchmark" data-public-path="/leaderboard"');
    expect(source).toContain('data-public-service="rag" data-public-path="/documents"');
    expect(source).not.toContain('PORT_TO_SERVICE');
    expect(source).not.toMatch(/href="https?:\/\/(?:localhost|127\.0\.0\.1)/);
  });
});
