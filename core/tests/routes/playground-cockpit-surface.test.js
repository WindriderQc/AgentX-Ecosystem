const fs = require('fs');
const path = require('path');
const ejs = require('ejs');

const root = path.resolve(__dirname, '../..');
const viewPath = path.join(root, 'views/pages/chat.ejs');
const appPath = path.join(root, 'src/app.js');
const scriptPath = path.join(root, 'public/js/playground-cockpit.js');
const stylePath = path.join(root, 'public/css/playground-cockpit.css');
const chatStylePath = path.join(root, 'public/css/chat-inline.css');
const experienceStylePath = path.join(root, 'public/css/chat-experience.css');
const helpScriptPath = path.join(root, 'public/js/cockpit-help.js');
const helpStylePath = path.join(root, 'public/css/cockpit-help.css');

async function render(profile = 'full') {
  return ejs.renderFile(viewPath, { agentxProfile: profile });
}

describe('Playground conversational cockpit', () => {
  test('renders one visible route workflow, mode controls, fleet evidence, and contextual guide', async () => {
    const html = await render('full');

    expect(html).toContain('Talk with your models');
    expect(html).toContain('How this answer will run');
    expect(html).toContain('id="pgHostDeck"');
    expect(html).toContain('id="pgServiceSummary"');
    expect(html).toContain('id="pgRouteDecision"');
    expect(html).toContain('data-cockpit-guide-open="playgroundGuide"');
    expect(html).toContain('id="playgroundGuide"');
    for (const mode of ['quick', 'standard', 'deep', 'manual']) {
      expect(html).toContain(`data-playground-mode="${mode}"`);
    }
    for (const pathName of ['/nerve-center', '/agent-ops', '/pipeline', '/models']) {
      expect(html).toContain(`href="${pathName}"`);
    }
    expect(html).not.toContain('pg-quick-doors');
    expect(html).not.toContain('id="pgServiceDeck"');
  });

  test('keeps environment-dependent work doors out of the demo profile', async () => {
    const html = await render('demo');
    expect(html).toContain('Talk with your models');
    expect(html).toContain('Model details');
    expect(html).not.toContain('href="/nerve-center"');
    expect(html).not.toContain('href="/agent-ops"');
    expect(html).not.toContain('href="/pipeline"');
  });

  test('reuses the existing chat selectors and bounded read-only product APIs', () => {
    const source = fs.readFileSync(scriptPath, 'utf8');

    for (const id of ['routingModeSelect', 'hostInput', 'modelSelect', 'messageInput', 'toggleConfigBtn']) {
      expect(source).toContain(`getElementById('${id}')`);
    }
    for (const route of ['/api/portal/health', '/api/nerve-center/ecosystem', '/api/ollama-hosts']) {
      expect(source).toContain(route);
    }
    expect(source).toContain("document.body.dataset.agentxProfile === 'demo'");
    expect(source).toContain("demoProfile ? getJson('/api/portal/health') : Promise.resolve(null)");
    expect(source).toContain('demoProfile ? Promise.resolve(null)');
    expect(source).toContain('ecosystem?.serviceHealth || portal?.summary');
    expect(source).toContain('Array.isArray(ecosystem?.services)');
    expect(source).toContain('ecosystem?.identityConsistency || portal?.consistency');
    expect(source).toContain('deployment mismatch');
    expect(source).not.toContain('/api/config');
    expect(source).toContain("new Event('change', { bubbles: true })");
    expect(source).not.toMatch(/method:\s*['"](?:POST|PUT|PATCH|DELETE)/i);
    expect(source).not.toMatch(/localhost|127\.0\.0\.1|192\.168\./);
    expect(source).not.toContain('innerHTML');
  });

  test('loads namespaced cockpit assets from the canonical Playground route', () => {
    const app = fs.readFileSync(appPath, 'utf8');
    const css = fs.readFileSync(stylePath, 'utf8');

    expect(app).toContain("'<link rel=\"stylesheet\" href=\"/css/playground-cockpit.css\">'");
    expect(app).toContain("'<script src=\"/js/playground-cockpit.js\"></script>'");
    expect(app).toContain("'<link rel=\"stylesheet\" href=\"/css/cockpit-help.css\">'");
    expect(app).toContain("'<script src=\"/js/cockpit-help.js\"></script>'");
    expect(css).toContain('.playground-cockpit');
    expect(css).toContain('.pg-route-flow');
    expect(css).toContain('.pg-host-deck');
    expect(css).toContain('@media (max-width: 720px)');
    expect(fs.readFileSync(helpScriptPath, 'utf8')).toContain('data-cockpit-guide-open');
    expect(fs.readFileSync(helpStylePath, 'utf8')).toContain('.cockpit-guide');
  });

  test('keeps the composer reachable when the full cockpit meets a compact viewport', () => {
    const source = fs.readFileSync(scriptPath, 'utf8');
    const chatCss = fs.readFileSync(chatStylePath, 'utf8');
    const experienceCss = fs.readFileSync(experienceStylePath, 'utf8');

    expect(source).toContain("'(max-width: 720px), (max-height: 640px)'");
    expect(source).toContain("routingLab.removeAttribute('open')");
    expect(chatCss).toContain('height: 100dvh');
    expect(chatCss).toContain('body:has(.chat-page-content) #nav-container');
    expect(chatCss).toContain('flex: 1 1 auto');
    expect(chatCss).toContain('min-width: 0; min-height: 0');
    expect(chatCss).not.toContain('height: calc(100dvh - var(--nav-height');
    expect(experienceCss).toContain('@media (max-width: 720px), (max-height: 640px)');
    expect(experienceCss).toContain('max-height: min(40dvh, 300px)');
    expect(experienceCss).toContain('.chat-routing-lab:not([open])');
  });
});
