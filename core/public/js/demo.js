(function initDemoExperience() {
  const readiness = document.getElementById('demoReadiness');
  const label = document.getElementById('demoReadinessLabel');
  const detail = document.getElementById('demoReadinessDetail');
  const refresh = document.getElementById('demoStatusRefresh');
  const icon = readiness?.querySelector('.agentx-demo__readiness-icon i');

  if (!readiness || !label || !detail || !refresh || !icon) return;

  function present(state, nextLabel, nextDetail, iconName) {
    readiness.dataset.state = state;
    label.textContent = nextLabel;
    detail.textContent = nextDetail;
    icon.className = `fas ${iconName}`;
    refresh.disabled = false;
  }

  async function loadReadiness() {
    readiness.dataset.state = 'loading';
    label.textContent = 'Checking readiness';
    detail.textContent = 'Looking at chat, documents, and evaluation';
    icon.className = 'fas fa-circle-notch';
    refresh.disabled = true;

    try {
      const [response, routingResponse] = await Promise.all([
        fetch('/api/portal/health', {
          credentials: 'same-origin',
          headers: { Accept: 'application/json' }
        }),
        fetch('/api/models/routing', {
          credentials: 'same-origin',
          headers: { Accept: 'application/json' }
        }).catch(() => null)
      ]);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);

      const payload = await response.json();
      const routingPayload = routingResponse?.ok ? await routingResponse.json() : null;
      const routing = routingPayload?.data || routingPayload;
      const services = Array.isArray(payload.services) ? payload.services : [];
      const core = services.find((service) => service.id === 'core');
      const chatReady = core?.status === 'ok' && core?.detail?.ollama === 'connected';
      const chatRoute = routing?.taskModels?.general_chat;
      const chatHost = chatRoute ? routing?.hosts?.[chatRoute.host] : null;
      const routeReady = !chatRoute || (chatHost?.models || [])
        .some((model) => String(model).replace(/:latest$/, '') === String(chatRoute.model).replace(/:latest$/, ''));
      const healthy = Number(payload.summary?.healthy || 0);
      const total = Number(payload.summary?.total || services.length || 0);

      if (!core || core.status === 'down') {
        present('blocked', 'Chat is unavailable', 'Agent X needs attention before a conversation can start', 'fa-circle-xmark');
      } else if (!chatReady) {
        present('attention', 'Model setup needed', 'Agent X is running; connect a chat model to start', 'fa-triangle-exclamation');
      } else if (!routeReady) {
        present('attention', 'Chat route needs attention', 'Open Chat, then Take the controls to choose an installed model', 'fa-triangle-exclamation');
      } else if (payload.summary?.status !== 'ok') {
        present('attention', 'Chat is ready', `${healthy}/${total} workspaces ready · some tools need attention`, 'fa-triangle-exclamation');
      } else {
        present('ready', 'Ready to chat', 'Chat, documents, and model comparison are available', 'fa-circle-check');
      }
    } catch (_error) {
      present('blocked', 'Status not observed', 'The launcher still works; refresh to check Agent X again', 'fa-circle-question');
    }
  }

  refresh.addEventListener('click', loadReadiness);
  loadReadiness();
}());
