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

  const runtimeLaunchers = normalizeTrustedRuntimeNavItems([
    { id: 'openclaw-runtime', label: 'OpenClaw', href: '/api/openclaw/control-launch/overview', icon: 'fa-paw', owner: 'AIOps', description: 'Protected agent desk.' },
    { id: 'dsh-studio', label: 'DSH Studio', href: '/api/dsh/control-launch', icon: 'fa-terminal', owner: 'AIOps' },
  ]);

  function externalRuntimeAnchors(html) {
    const section = html.split('External runtimes')[1] || '';
    return [...section.matchAll(/<a\b[^>]*href="([^"]+)"[^>]*data-nav-owner="([^"]*)"[^>]*>([\s\S]*?)<\/a>/g)]
      .map((match) => ({ href: match[1], owner: match[2], label: match[3].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim() }));
  }

  test('full navigation exposes validated trusted runtime launchers as two distinct, provider-tagged doors', async () => {
    const core = await renderNav('core', 'full', 'nerve-center', runtimeLaunchers);
    expect(core).toContain('External runtimes');
    expect(hrefFor(core, 'OpenClaw')).toBe('/api/openclaw/control-launch/overview');
    expect(hrefFor(core, 'DSH Studio')).toBe('/api/dsh/control-launch');
    expect(core).toMatch(/href="\/api\/openclaw\/control-launch\/overview"[^>]*target="_blank" rel="noopener"[^>]*data-nav-owner="AIOps"[^>]*title="Protected agent desk\."/);
    expect(core).toContain('<span class="nav-owner-tag">AIOps</span>');

    expect(await renderNav('core', 'demo', 'demo', runtimeLaunchers)).not.toContain('DSH Studio');
  });

  test('Benchmark and RAG render exactly the launchers Core renders, through the configured Core authority', async () => {
    const core = externalRuntimeAnchors(await renderNav('core', 'full', 'nerve-center', runtimeLaunchers));
    const benchmark = externalRuntimeAnchors(await renderNav('benchmark', 'full', 'benchmark', runtimeLaunchers));
    const rag = externalRuntimeAnchors(await renderNav('rag', 'full', 'rag', runtimeLaunchers));

    expect(core.map((a) => a.label)).toEqual(['OpenClaw AIOps', 'DSH Studio AIOps']);
    const absolute = (anchors) => anchors.map((a) => ({ ...a, href: new URL(a.href, 'https://core.example').href }));
    expect(absolute(benchmark)).toEqual(absolute(core));
    expect(absolute(rag)).toEqual(absolute(core));
    expect(benchmark[0].href).toBe('https://core.example/api/openclaw/control-launch/overview');
    expect(rag[1].href).toBe('https://core.example/api/dsh/control-launch');

    // Without launchers, no service invents a section.
    for (const service of ['core', 'benchmark', 'rag']) {
      expect(await renderNav(service, 'full', 'nerve-center', [])).not.toContain('External runtimes');
    }
  });

  test('frozen Planning lives under History & reference, with Pipeline as the execution authority', async () => {
    const html = await renderNav('core', 'full', 'pipeline');
    const labs = html.slice(html.indexOf('id="nav-menu-labs-group"'));
    expect(labs).toContain('History &amp; reference');
    expect(labs).toContain('Experimental');
    expect(labs.indexOf('History &amp; reference')).toBeGreaterThan(labs.indexOf('Experimental'));
    expect(labs.indexOf('Planning · frozen')).toBeGreaterThan(labs.indexOf('History &amp; reference'));
    expect(hrefFor(html, 'Planning · frozen')).toBe('/planning');
    expect(html).toMatch(/href="\/planning"[^>]*title="Historical strategy and evidence reference\. Frozen: current delivery lives in Pipeline\."/);
    expect(hrefFor(html, 'Pipeline')).toBe('/pipeline');
    expect(await renderNav('rag', 'full', 'rag')).toContain('History &amp; reference');
  });

  test('the Product navigation groups are identical on every service', async () => {
    const groups = (html) => [...html.matchAll(/id="nav-trigger-([a-z-]+)"/g)].map((m) => m[1]);
    const items = (html) => [...html.matchAll(/class="dropdown-item[^"]*"[^>]*>\s*<i class="fas [^"]+" aria-hidden="true"><\/i>\s*([^<]+)/g)].map((m) => m[1].trim());
    const core = await renderNav('core', 'full', 'nerve-center', runtimeLaunchers);
    const benchmark = await renderNav('benchmark', 'full', 'benchmark', runtimeLaunchers);
    const rag = await renderNav('rag', 'full', 'rag', runtimeLaunchers);
    expect(groups(benchmark)).toEqual(groups(core));
    expect(groups(rag)).toEqual(groups(core));
    expect(items(benchmark)).toEqual(items(core));
    expect(items(rag)).toEqual(items(core));
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

  test('portal reveals only the optional normalized host-home contract', () => {
    const source = fs.readFileSync(portalPath, 'utf8');
    expect(source).toContain('id="host-home-link"');
    expect(source).toContain('hostHome = cfg?.hostHome || null');
    expect(source).toContain("hostHomeLink.textContent = String(hostHome?.label || 'Back to host')");
    expect(source).toContain('hostHomeLink.hidden = false');
    expect(source).not.toContain('192.168.2.99');
    expect(source).not.toContain('Mon écosystème');
  });

  test('portal lists deployment launchers from the validated navigation projection, never hardcoded', () => {
    const source = fs.readFileSync(portalPath, 'utf8');
    expect(source).toContain('id="external-runtimes-tile"');
    expect(source).toContain("renderExternalRuntimes(cfg?.navigation?.trustedRuntimeNavItems, configLoaded)");
    expect(source).toContain('No private runtime is installed in this deployment.');
    expect(source).toContain("Launchers could not be read from Core; refresh to retry.");
    expect(source).toMatch(/\/\^\\\/api\\\/\(\?!\\\/\)\/\.test\(item\.href\)/);
    expect(source).not.toMatch(/openclaw|dsh/i);
  });
});
