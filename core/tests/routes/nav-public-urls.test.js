const fs = require('fs');
const path = require('path');
const ejs = require('ejs');
const { normalizeTrustedRuntimeNavItems } = require('../../src/extensions/trustedRuntimeNavigation');

const navPath = path.join(__dirname, '../../views/partials/nav.ejs');
const portalPath = path.join(__dirname, '../../public/portal/index.html');
const publicUrls = {
  core: 'https://core.example',
  benchmark: 'http://bench.example:4181',
  rag: 'http://rag.example:4182',
  data: 'http://data.example:4183',
};

async function renderNav(service, agentxProfile = 'full', activePage = 'nerve-center', trustedRuntimeNavItems = []) {
  return ejs.renderFile(navPath, {
    service,
    activePage,
    agentxProfile,
    publicUrls,
    reqHost: 'wrong-host.example',
    trustedRuntimeNavItems,
  });
}

function hrefFor(html, label) {
  const anchors = [...html.matchAll(/<a\b[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g)];
  return anchors.find((match) => match[2].replace(/<[^>]+>/g, ' ').includes(label))?.[1];
}

describe('shared navigation public URL contract', () => {
  test('Core stays relative while cross-service links use configured authority', async () => {
    const html = await renderNav('core');
    expect(hrefFor(html, 'Chat')).toBe('/playground');
    expect(hrefFor(html, 'Nerve Center')).toBe('/nerve-center');
    expect(hrefFor(html, 'Agent Ops')).toBe('/agent-ops');
    expect(hrefFor(html, 'Engine Room')).toBe('http://bench.example:4181/');
    expect(hrefFor(html, 'RAG Dashboard')).toBe('http://rag.example:4182/');
    expect(new URL(hrefFor(html, 'Nerve Center'), 'https://192.0.2.99').href)
      .toBe('https://192.0.2.99/nerve-center');
    expect(html).not.toContain('wrong-host.example');
  });

  test('Benchmark stays relative and its Nerve Center hop uses configured Core', async () => {
    const html = await renderNav('benchmark');
    expect(hrefFor(html, 'Chat')).toBe('https://core.example/playground');
    expect(hrefFor(html, 'Engine Room')).toBe('/');
    expect(hrefFor(html, 'Nerve Center')).toBe('https://core.example/nerve-center');
    expect(hrefFor(html, 'RAG Dashboard')).toBe('http://rag.example:4182/');
  });

  test('RAG stays relative and its Nerve Center hop uses configured Core', async () => {
    const html = await renderNav('rag');
    expect(hrefFor(html, 'RAG Dashboard')).toBe('/');
    expect(hrefFor(html, 'Nerve Center')).toBe('https://core.example/nerve-center');
    expect(hrefFor(html, 'Engine Room')).toBe('http://bench.example:4181/');
  });

  test('demo navigation never links its brand to the blocked full-profile portal', async () => {
    expect(hrefFor(await renderNav('core', 'demo'), 'AgentX')).toBe('/demo');
    expect(hrefFor(await renderNav('benchmark', 'demo'), 'AgentX')).toBe('https://core.example/demo');
    expect(hrefFor(await renderNav('core', 'full'), 'AgentX')).toBe('/portal/');
  });

  test('Chat is a first-class direct destination in full and demo navigation', async () => {
    for (const profile of ['full', 'demo']) {
      const html = await renderNav('core', profile, 'playground');
      const directChat = html.match(/<a href="\/playground" class="nav-link primary active"[^>]*>[\s\S]*?<\/a>/g) || [];
      expect(directChat).toHaveLength(1);
      expect(directChat[0]).toContain('Chat');
      expect(directChat[0]).toContain('aria-current="page"');
    }
  });

  test('full Core navigation exposes validated trusted runtime launchers only where supplied', async () => {
    const items = [
      { id: 'openclaw-runtime', label: 'OpenClaw', href: '/api/openclaw/control-launch/overview', icon: 'fa-paw' },
      { id: 'dsh-studio', label: 'DSH Studio', href: '/api/dsh/control-launch', icon: 'fa-terminal' },
    ];
    const core = await renderNav('core', 'full', 'nerve-center', items);
    expect(core).toContain('External runtimes');
    expect(hrefFor(core, 'OpenClaw')).toBe('/api/openclaw/control-launch/overview');
    expect(hrefFor(core, 'DSH Studio')).toBe('/api/dsh/control-launch');

    expect(await renderNav('core', 'demo', 'demo', items)).not.toContain('DSH Studio');
    expect(await renderNav('benchmark', 'full', 'benchmark', items)).not.toContain('DSH Studio');
  });

  test('trusted runtime labels stay escaped in rendered navigation', async () => {
    const items = normalizeTrustedRuntimeNavItems([{
      id: 'private-runtime',
      label: '<img src=x onerror=alert(1)>',
      href: '/api/private-runtime/control-launch',
      icon: 'fa-terminal',
    }]);
    const html = await renderNav('core', 'full', 'nerve-center', items);
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
    expect(html).not.toContain('<img src=x onerror=alert(1)>');
  });

  test('navigation exposes every release-critical demo surface and exact RAG page state', async () => {
    const demo = await renderNav('core', 'demo', 'prompts');
    for (const label of ['Prompts', 'Profiler', 'Courthouse', 'Efficiency Map']) {
      expect(hrefFor(demo, label)).toBeTruthy();
    }

    const ragMaintenance = await renderNav('rag', 'full', 'rag-maintenance');
    expect(hrefFor(ragMaintenance, 'Maintenance')).toBe('/maintenance');
    expect(ragMaintenance).toMatch(/href="\/maintenance"[\s\S]*?aria-current="page"/);
  });

  test('navigation exposes a complete disclosure and keyboard contract', async () => {
    const html = await renderNav('core', 'full', 'pipeline');
    expect(html).toContain('<nav class="top-nav" aria-label="Primary">');
    expect(html).toContain('id="nav-trigger-work-group"');
    expect(html).toContain('aria-controls="nav-menu-work-group"');
    expect(html).toContain('id="nav-menu-work-group" aria-labelledby="nav-trigger-work-group"');
    expect(hrefFor(html, 'Pipeline')).toBe('/pipeline');
    expect(html.match(/href="\/pipeline"[\s\S]*?aria-current="page"/)).not.toBeNull();
    expect(html).toContain("e.key === 'ArrowDown'");
    expect(html).toContain("e.key === 'Escape'");
    expect(html).toContain("e.key === 'Home'");
    expect(html).toContain("e.key === 'End'");
    expect(html).toContain("container.classList.toggle('has-open-menu'");
  });

  test('shared layout provides a skip-to-content target without replacing page-owned ids', () => {
    const layout = fs.readFileSync(path.join(__dirname, '../../views/layouts/main.ejs'), 'utf8');
    expect(layout).toContain('class="skip-link"');
    expect(layout).toContain('href="#main-content"');
    expect(layout).toContain("document.querySelector('main, [role=\"main\"]')");
    expect(layout).toContain("main.parentNode.insertBefore(target, main)");
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
    expect(source).toContain('data-public-service="core" data-public-path="/playground">Open Chat</a>');
    expect(source).toContain('data-public-service="benchmark" data-public-path="/leaderboard"');
    expect(source).toContain('data-public-service="rag" data-public-path="/documents"');
    expect(source).toContain('data-public-service="core" data-public-path="/agent-ops"');
    expect(source).not.toContain('PORT_TO_SERVICE');
    expect(source).not.toMatch(/href="https?:\/\/(?:localhost|127\.0\.0\.1)/);
  });
});
