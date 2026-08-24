const fs = require('fs');
const path = require('path');
const ejs = require('ejs');

const root = path.resolve(__dirname, '../..');
const viewPath = path.join(root, 'views/pages/agent-ops.ejs');
const appPath = path.join(root, 'src/app.js');
const mainScriptPath = path.join(root, 'public/js/agent-ops.js');
const advancedScriptPath = path.join(root, 'public/js/agent-ops-advanced.js');

describe('read-only Agent Ops shell', () => {
  test('renders all operating views without private adapter locals', async () => {
    const html = await ejs.renderFile(viewPath, {
      publicUrls: { rag: 'http://rag.example' },
    });

    for (const tab of ['overview', 'inbox', 'responsibilities', 'activity', 'agents', 'automations', 'work']) {
      expect(html).toContain(`data-agent-ops-tab="${tab}"`);
    }
    expect(html).toContain('read-only');
    expect(html).toContain('data-cockpit-guide-open="agentOpsGuide"');
    expect(html).toContain('id="agentOpsGuide"');
    expect(html).toContain('data-cockpit-tip-title="Coverage"');
    expect(html).not.toContain('agent-ops-launchpad');
    expect(html).not.toContain('agent-ops-handoff-panel');
    expect(html).not.toContain('id="agentOpsCapabilities"');
    expect(html).not.toMatch(/Confirm action|data-work-claim|agentOpsConfirm/);
  });

  test('registers the canonical page and compatibility redirect', () => {
    const source = fs.readFileSync(appPath, 'utf8');
    expect(source).toContain("app.get('/agent-ops'");
    expect(source).toContain("app.get('/agent-ops.html'");
    expect(source).toContain("pageView: '../pages/agent-ops'");
  });

  test('contains no mutation path or action controls', () => {
    const source = [mainScriptPath, advancedScriptPath, viewPath]
      .map((file) => fs.readFileSync(file, 'utf8'))
      .join('\n');
    expect(source).not.toMatch(/\/api\/agent-ops\/actions|work-claim|data-work-claim|data-agent-ops-action/);
    expect(source).not.toMatch(/method:\s*['"]POST['"]/);
    expect(source).not.toMatch(/Inspect & act/);
    expect(source).toContain('Recent history');
    expect(source).toContain('Delivery topic is closed');
    expect(source).toContain('grant it the platform permission for managing topics');
    expect(source).toContain('/TOPIC[_\\s-]*CLOSED/i');
    expect(source).not.toMatch(/renderRuntimeHandoff|renderCapabilities/);
  });
});
