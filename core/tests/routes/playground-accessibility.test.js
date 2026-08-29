const fs = require('fs');
const path = require('path');
const ejs = require('ejs');

const root = path.resolve(__dirname, '../..');
const viewPath = path.join(root, 'views/pages/chat.ejs');
const agentsPath = path.join(root, 'public/js/chat/chat-agents.js');
const configPath = path.join(root, 'public/js/chat/chat-config.js');
const mainPath = path.join(root, 'public/js/chat/chat-main.js');
const messagingPath = path.join(root, 'public/js/chat/chat-messaging.js');

async function renderChat() {
  return ejs.renderFile(viewPath, { agentxProfile: 'full' });
}

describe('Playground accessibility contract', () => {
  test('associates the composer and expert controls with accessible names and help', async () => {
    const html = await renderChat();

    expect(html).toContain('for="messageInput">Message Agent X</label>');
    expect(html).toContain('id="messageInput" rows="1"');
    expect(html).toContain('aria-label="Choose a conversation starter"');
    expect(html).toContain('id="sendBtn" disabled title="Checking chat readiness"');
    expect(html).toContain('id="chatRouteRecovery" aria-labelledby="chatRouteRecoveryTitle" hidden');
    expect(html).toContain('id="chatRouteRecoveryStatus" role="status" aria-live="polite" aria-atomic="true"');
    expect(html).toContain('id="chatRouteRecoveryAction" type="button" aria-describedby="chatRouteRecoveryStatus"');

    for (const id of [
      'routingModeSelect', 'hostInput', 'modelSelect', 'promptSelect', 'systemPrompt',
      'temperature', 'topP', 'topK', 'numCtx', 'repeatPenalty', 'presencePenalty',
      'frequencyPenalty', 'numPredict', 'seed', 'stopSequences', 'keepAlive',
    ]) {
      expect(html).toContain(`for="${id}"`);
      expect(html).toContain(`id="${id}"`);
    }

    for (const id of ['streamToggle', 'ragToggle', 'thinkingToggle', 'webSearchToggle', 'statsToggle']) {
      expect(html).toMatch(new RegExp(`id="${id}"[^>]+aria-labelledby="${id}Label"[^>]+aria-describedby="${id}Hint"`));
    }
  });

  test('uses native disclosure controls and keeps collapsed descendants inert', async () => {
    const html = await renderChat();
    const agents = fs.readFileSync(agentsPath, 'utf8');
    const config = fs.readFileSync(configPath, 'utf8');
    const main = fs.readFileSync(mainPath, 'utf8');

    expect(html).toContain('<button class="agent-selector-bar" id="agentSelectorBar" type="button" aria-expanded="false" aria-controls="agentSelectorPanel">');
    expect(html).toContain('id="agentSelectorPanel" inert');
    expect(html).toContain('<button class="agentx-card launcher-default-card selected" id="startChatCard" type="button"');
    expect(html).toContain('<button class="rag-panel-header" id="ragPanelHeader" type="button" aria-expanded="false" aria-controls="ragOptionsContent">');
    expect(html).toContain('id="ragOptionsContent" style="display: none;" hidden inert');
    expect(html).toContain('<button class="section-header" id="tuningHeader" type="button" aria-expanded="false" aria-controls="tuningContent">');
    expect(html).toContain('id="tuningContent" hidden inert');

    expect(agents).toContain("setAttribute('aria-expanded', String(expanded))");
    expect(agents).toContain("panel.setAttribute('inert', '')");
    expect(agents).toContain('<a class="agentx-card tool-card" href=');
    expect(config).toContain("elements.ragPanelHeader?.setAttribute('aria-expanded', String(nextOpen))");
    expect(main).toContain("tuningHeader.setAttribute('aria-expanded', String(nextOpen))");
  });

  test('announces completed responses once instead of streaming every token', async () => {
    const html = await renderChat();
    const messaging = fs.readFileSync(messagingPath, 'utf8');

    expect(html).toContain('id="chatWindow" role="region" aria-label="Conversation transcript"');
    expect(html).toContain('id="chatAnnouncements" role="status" aria-live="polite" aria-atomic="true"');
    expect(messaging).toContain("{ announcement: 'Assistant response complete.' }");
    expect(messaging).toContain("announcement: 'Response failed. Review the status message.'");
    expect(messaging).not.toMatch(/eventName === 'token'[\s\S]{0,500}chatAnnouncements/);
  });

  test('keeps route recovery explicit and returns focus to the composer', async () => {
    const main = fs.readFileSync(mainPath, 'utf8');

    expect(main).toContain("elements.routingModeSelect.value = 'manual'");
    expect(main).toContain("elements.modelSelect.dispatchEvent(new Event('change', { bubbles: true }))");
    expect(main).toContain("elements.routingModeSelect.dispatchEvent(new Event('change', { bubbles: true }))");
    expect(main).toContain('saved as the local chat default. The configured ${modeLabel} route was not changed. The message box is ready.');
    expect(main).toContain('elements.messageInput.focus({ preventScroll: true })');
  });
});
