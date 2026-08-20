const fs = require('fs');
const path = require('path');
const ejs = require('ejs');

const root = path.resolve(__dirname, '../..');
const viewPath = path.join(root, 'views/pages/chat.ejs');
const appPath = path.join(root, 'src/app.js');
const scriptPath = path.join(root, 'public/js/playground-cockpit.js');
const stylePath = path.join(root, 'public/css/playground-cockpit.css');

async function render(profile = 'full') {
  return ejs.renderFile(viewPath, { agentxProfile: profile });
}

describe('Playground conversational cockpit', () => {
  test('renders a visible route workflow, mode controls, fleet, services, and product doors', async () => {
    const html = await render('full');

    expect(html).toContain('Talk with your models');
    expect(html).toContain('How this answer will run');
    expect(html).toContain('id="pgHostDeck"');
    expect(html).toContain('id="pgServiceDeck"');
    expect(html).toContain('id="pgRouteDecision"');
    for (const mode of ['quick', 'standard', 'deep', 'manual']) {
      expect(html).toContain(`data-playground-mode="${mode}"`);
    }
    for (const pathName of ['/nerve-center', '/agent-ops', '/pipeline', '/models']) {
      expect(html).toContain(`href="${pathName}"`);
    }
    expect(html).toContain('data-public-service="benchmark"');
    expect(html).toContain('data-public-service="rag"');
  });

  test('keeps environment-dependent work doors out of the demo profile', async () => {
    const html = await render('demo');
    expect(html).toContain('Talk with your models');
    expect(html).not.toContain('href="/agent-ops"');
    expect(html).not.toContain('href="/pipeline"');
  });

  test('reuses the existing chat selectors and bounded read-only product APIs', () => {
    const source = fs.readFileSync(scriptPath, 'utf8');

    for (const id of ['routingModeSelect', 'hostInput', 'modelSelect', 'messageInput', 'toggleConfigBtn']) {
      expect(source).toContain(`getElementById('${id}')`);
    }
    for (const route of ['/api/portal/health', '/api/nerve-center/ecosystem', '/api/ollama-hosts', '/api/config']) {
      expect(source).toContain(route);
    }
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
    expect(css).toContain('.playground-cockpit');
    expect(css).toContain('.pg-route-flow');
    expect(css).toContain('.pg-host-deck');
    expect(css).toContain('@media (max-width: 720px)');
  });
});
