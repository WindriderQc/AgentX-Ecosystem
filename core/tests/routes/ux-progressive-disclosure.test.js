const fs = require('fs');
const path = require('path');
const ejs = require('ejs');

const root = path.join(__dirname, '../..');
const demoPath = path.join(root, 'views/pages/demo.ejs');
const chatPath = path.join(root, 'views/pages/chat.ejs');
const modelsPath = path.join(root, 'views/pages/models.ejs');
const analyticsPath = path.join(root, 'views/pages/analytics.ejs');
const navPath = path.join(root, 'views/partials/nav.ejs');
const demoCssPath = path.join(root, 'public/css/demo.css');
const chatCssPath = path.join(root, 'public/css/chat-experience.css');
const chatMainPath = path.join(root, 'public/js/chat/chat-main.js');
const chatConfigPath = path.join(root, 'public/js/chat/chat-config.js');
const chatMessagingPath = path.join(root, 'public/js/chat/chat-messaging.js');
const demoJsPath = path.join(root, 'public/js/demo.js');
const modelsExperiencePath = path.join(root, 'public/js/models-experience.js');
const modelsUnifiedPath = path.join(root, 'public/js/models-unified.js');
const modelsComparisonPath = path.join(root, 'public/js/models-comparison.js');
const modelsExperienceCssPath = path.join(root, 'public/css/models-experience.css');
const analyticsExperiencePath = path.join(root, 'public/js/analytics-experience.js');
const analyticsExperienceCssPath = path.join(root, 'public/css/analytics-experience.css');
const analyticsInferencePath = path.join(root, 'public/js/analytics-inference.js');

async function renderDemo() {
  return ejs.renderFile(demoPath, {
    publicUrls: {
      core: 'https://core.example',
      benchmark: 'https://benchmark.example',
      rag: 'https://rag.example',
    },
  });
}

async function renderChat() {
  return ejs.renderFile(chatPath, {});
}

async function renderModels() {
  return ejs.renderFile(modelsPath, {
    publicUrls: { benchmark: 'https://benchmark.example' },
  });
}

async function renderAnalytics() {
  return ejs.renderFile(analyticsPath, {
    publicUrls: { rag: 'https://rag.example' },
  });
}

describe('simple-to-expert UX contract', () => {
  test('demo home leads with human actions and keeps mechanics disclosed', async () => {
    const html = await renderDemo();
    const simpleDepth = html.slice(0, html.indexOf('<details'));
    const simpleText = simpleDepth.replace(/<[^>]+>/g, ' ');

    expect(simpleDepth).toContain('What do you want to do?');
    expect(simpleDepth).toContain('Start a conversation');
    expect(simpleDepth).toContain('Use your own knowledge');
    expect(simpleDepth).toContain('Compare models');
    expect(simpleText).not.toMatch(/\b(?:Ollama|RAG|host|route)\b/i);
    expect(html).toContain('See how Agent X works');
    expect(html).toContain('Chooses a route');
  });

  test('demo readiness always includes a label, symbol, and refresh action', async () => {
    const html = await renderDemo();

    expect(html).toContain('id="demoReadiness" data-state="loading" role="status"');
    expect(html).toContain('id="demoReadinessLabel"');
    expect(html).toContain('agentx-demo__readiness-icon');
    expect(html).toContain('aria-label="Refresh Agent X readiness"');
  });

  test('chat keeps technical instruments behind one consistent control door', async () => {
    const html = await renderChat();
    const commandStart = html.indexOf('<header class="chat-command-bar"');
    const expertStart = html.indexOf('<div class="chat-expert-strip"');
    const simpleCommand = html.slice(commandStart, expertStart);

    expect(simpleCommand).toContain('Take the controls');
    expect(simpleCommand).toContain('aria-expanded="false"');
    expect(simpleCommand).not.toMatch(/>\s*(?:Host|Route|VRAM|Thinking)\s*</);
    expect(html).toContain('id="chatExpertStrip" aria-hidden="true" inert');
    expect(html).toContain('data-ci-field="host"');
    expect(html).toContain('data-ci-field="route"');
    expect(html).toContain('data-ci-field="vram"');
  });

  test('chat starts with an actionable empty state and states recovery precisely', async () => {
    const html = await renderChat();
    const source = fs.readFileSync(chatMainPath, 'utf8');

    expect(html).toContain('Ask Agent X anything.');
    expect(html).toContain('data-chat-starter="Help me brainstorm: "');
    expect(html).toContain('Balanced uses the configured Standard route.');
    expect(html).toContain('Agent X will name an installed model you can choose.');
    expect(html).not.toMatch(/Pick a model/i);
    expect(source).toContain("state.history.length === 0 ? welcomeMarkup : ''");
  });

  test('expert drawer is context preserving and unavailable while closed', async () => {
    const html = await renderChat();
    const source = fs.readFileSync(chatMainPath, 'utf8');

    expect(html).toContain('id="configDrawer" role="dialog" aria-hidden="true"');
    expect(html).toContain('tabindex="-1" inert');
    expect(source).toContain("elements.configDrawer.inert = !isOpen");
    expect(source).toContain("document.body.classList.toggle('chat-controls-open', isOpen)");
    expect(source).toContain("if (e.key === 'Escape' && elements.configDrawer?.classList.contains('open'))");
    expect(source).toContain('configDrawerOpener.focus({ preventScroll: true })');
  });

  test('manual control requires and then loads an explicit model choice', () => {
    const mainSource = fs.readFileSync(chatMainPath, 'utf8');
    const configSource = fs.readFileSync(chatConfigPath, 'utf8');

    expect(configSource).toContain('const requiresModel = !runningLabel && !primaryPin && !selectedModel');
    expect(configSource).toContain('const hostUnavailable = !routerMode && !hostState.available');
    expect(configSource).toContain('elements.modelSelect.disabled = routerMode || hostUnavailable');
    expect(mainSource).toContain('const blocked = !hostState.available || hostState.requiresModel');
    expect(mainSource).toContain("if (hostState.mode !== 'router')");
    expect(mainSource).toContain('await _fetchModels({ elements, state, defaults, helpers }, false)');
    expect(configSource).toContain('state.sessionLoadedModel?.model');
    expect(mainSource).toContain('sessionLoadedModel: null');
  });

  test('an optional missing model runtime is presented as recoverable setup', () => {
    const mainSource = fs.readFileSync(chatMainPath, 'utf8');
    const configSource = fs.readFileSync(chatConfigPath, 'utf8');
    const messagingSource = fs.readFileSync(chatMessagingPath, 'utf8');
    const demoSource = fs.readFileSync(demoJsPath, 'utf8');

    expect(configSource).toContain('if (!state.ollamaHostsLoaded)');
    expect(configSource).toContain('Connect an Ollama runtime to start a conversation. Agent X itself is still running normally.');
    expect(configSource).toContain('Install at least one model in the connected Ollama runtime');
    expect(mainSource).toContain("? 'Chat route needs attention'");
    expect(mainSource).toContain(": 'Model setup needed'");
    expect(mainSource).toContain("recoverable ? 'warning' : 'error'");
    expect(mainSource).toContain("document.querySelectorAll('[data-chat-starter]')");
    expect(configSource).toContain("fetchWithDeadline('/api/models/routing'");
    expect(configSource).toContain('but that model is not installed. Take the controls');
    expect(demoSource).toContain("'Chat route needs attention'");
    expect(mainSource).toContain('const optionalEvidence = [');
    expect(mainSource).toContain('Promise.allSettled(optionalEvidence)');
    expect(configSource).toContain("fetchWithDeadline('/api/ollama-hosts')");
    expect(messagingSource).toContain('fetchWithDeadline(`/api/models/all?host=');
    expect(messagingSource).toContain('&scope=runtime`');
  });

  test('visual grammar includes responsive and reduced-motion behavior', () => {
    const demoCss = fs.readFileSync(demoCssPath, 'utf8');
    const chatCss = fs.readFileSync(chatCssPath, 'utf8');

    expect(demoCss).toContain('@media (max-width: 640px)');
    expect(chatCss).toContain('@media (max-width: 720px)');
    expect(demoCss).toContain('@media (prefers-reduced-motion: reduce)');
    expect(chatCss).toContain('@media (prefers-reduced-motion: reduce)');
    expect(chatCss).toContain('.agent-selector.single-option');
    expect(chatCss).toContain('body[data-agentx-profile="demo"] .chat-routing-lab > summary { padding-left: 62px; }');
  });

  test('navigation uses the human Chat label while preserving the route', async () => {
    const html = await ejs.renderFile(navPath, {
      service: 'core',
      activePage: 'playground',
      agentxProfile: 'demo',
      publicUrls: { core: '', benchmark: 'https://benchmark.example', rag: 'https://rag.example' },
    });

    expect(html).toContain('href="/playground"');
    expect(html).toMatch(/href="\/playground"[\s\S]*?>[\s\S]*?Chat/);
    expect(html).not.toMatch(/>\s*Playground\s*</);
  });

  test('models leads with automatic chat and keeps the full registry behind one expert door', async () => {
    const html = await renderModels();
    const simpleDepth = html.slice(0, html.indexOf('<details id="models-cockpit"'));

    expect(simpleDepth).toContain('Choose a model—or let Agent X choose.');
    expect(simpleDepth).toContain('Chat automatically');
    expect(simpleDepth).toContain('Browse installed models');
    expect(simpleDepth).toContain('Compare with evidence');
    expect(simpleDepth).not.toMatch(/All Providers|Benchmark Score|Context Window|Temperature/);
    expect(html).toContain('<strong>Take the controls</strong>');
    expect(html).toContain('id="modelsTable"');
    expect(html).toContain('id="execConfigModal"');
  });

  test('models synchronizes disclosure, overlays and human readiness accessibly', () => {
    const source = fs.readFileSync(modelsExperiencePath, 'utf8');
    const catalog = fs.readFileSync(modelsUnifiedPath, 'utf8');
    const comparison = fs.readFileSync(modelsComparisonPath, 'utf8');
    const chatMain = fs.readFileSync(chatMainPath, 'utf8');
    const chatConfig = fs.readFileSync(chatConfigPath, 'utf8');
    const chatMessaging = fs.readFileSync(chatMessagingPath, 'utf8');
    const css = fs.readFileSync(modelsExperienceCssPath, 'utf8');

    expect(source).toContain('cockpitSurface.inert = !cockpit.open');
    expect(source).toContain('syncOverlayAccessibility');
    expect(source).toContain("setStatus('ready'");
    expect(source).toContain("setStatus('attention'");
    expect(source).toContain("setStatus('blocked'");
    expect(catalog).toContain("document.body.dataset.agentxProfile === 'demo'");
    expect(catalog).toContain('aria-label="More actions for ${escapeHtml(model.name)}"');
    expect(catalog).toContain('aria-haspopup="menu" aria-expanded="false"');
    expect(catalog).toContain('actionBtn.setAttribute(\'aria-expanded\', String(expanded))');
    expect(catalog).toContain('role="menu" aria-label="Actions for ${escapeHtml(model.name)}"');
    expect(catalog).toContain('AgentXPlaygroundLink.buildPlaygroundHref(modelName, host)');
    expect(comparison).toContain('AgentXPlaygroundLink.buildPlaygroundHref(modelName, host)');
    expect(chatMain).toContain('requestedRuntime');
    expect(chatConfig).toContain('Requested host');
    expect(chatMessaging).toContain('Requested model');
    expect(css).toContain('@media (max-width: 600px)');
    expect(css).toContain('@media (prefers-reduced-motion: reduce)');
  });

  test('analytics leads with decisions while retaining its complete observability workbench', async () => {
    const html = await renderAnalytics();
    const simpleDepth = html.slice(0, html.indexOf('<details id="analytics-cockpit"'));

    expect(simpleDepth).toContain('Understand what Agent&nbsp;X has been doing.');
    expect(simpleDepth).toContain('Inference activity');
    expect(simpleDepth).toContain('Conversation activity');
    expect(simpleDepth).toContain('Knowledge activity');
    expect(simpleDepth).not.toMatch(/Fallback Rate|Cost\/1K Tokens|Federated Cost|Model Activity/);
    expect(html).toContain('<strong>Take the controls</strong>');
    expect(html).toContain('Activity workbench');
    expect(html).toContain('Operational Error Rate');
    expect(html).toContain('id="infCancellations"');
    expect(html).toContain('id="infModelTableBody"');
    expect(html).toContain('id="federatedSection"');
  });

  test('analytics uses labelled readiness and keeps demo-only telemetry calls quiet', async () => {
    const html = await renderAnalytics();
    const source = fs.readFileSync(analyticsExperiencePath, 'utf8');
    const css = fs.readFileSync(analyticsExperienceCssPath, 'utf8');
    const inference = fs.readFileSync(analyticsInferencePath, 'utf8');

    expect(source).toContain('surface.inert = !cockpit.open');
    expect(source).toContain("setStatus('ready'");
    expect(source).toContain("setStatus('attention'");
    expect(source).toContain("setStatus('unknown'");
    expect(source).toContain('parseCompactNumber');
    expect(source).toContain("of conversations used knowledge");
    expect(html).toContain("document.body.dataset.agentxProfile === 'demo'");
    expect(html).toContain("section.setAttribute('aria-hidden', 'true')");
    expect(inference).toContain("document.body.dataset.agentxProfile === 'demo'");
    expect(css).toContain('@media (max-width: 600px)');
    expect(css).toContain('@media (prefers-reduced-motion: reduce)');
  });
});
