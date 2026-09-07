(function initProductHome() {
  const readiness = document.getElementById('homeReadiness');
  const label = document.getElementById('homeReadinessLabel');
  const detail = document.getElementById('homeReadinessDetail');
  const refresh = document.getElementById('homeStatusRefresh');
  const icon = readiness?.querySelector('.agentx-home__readiness-icon i');
  const serviceDetails = document.getElementById('homeServiceDetails');
  const consistencyDetail = document.getElementById('homeConsistency');
  const updated = document.getElementById('homeUpdated');
  if (!readiness || !label || !detail || !refresh || !icon) return;
  let loading = false;

  function present(state, nextLabel, nextDetail, iconName) {
    readiness.dataset.state = state;
    label.textContent = nextLabel;
    detail.textContent = nextDetail;
    icon.className = 'fas ' + iconName;
  }

  function renderServices(payload) {
    serviceDetails.replaceChildren();
    for (const service of Array.isArray(payload.services) ? payload.services : []) {
      const row = document.createElement('li');
      const latency = Number.isFinite(service.latency_ms) ? ' · ' + service.latency_ms + ' ms' : '';
      const issues = Array.isArray(service.issues) && service.issues.length ? ' · ' + service.issues.join(' · ') : '';
      row.textContent = (service.label || service.id) + ': ' + (service.status || 'unknown') + latency + issues;
      serviceDetails.appendChild(row);
    }
    if (!serviceDetails.childElementCount) serviceDetails.textContent = 'Service status not observed.';
    const consistency = payload.consistency || {};
    const issues = Array.isArray(consistency.issues) ? consistency.issues : [];
    const ecosystem = payload.summary?.ecosystem || {};
    const ecosystemIssues = Array.isArray(ecosystem.issues) ? ecosystem.issues : [];
    consistencyDetail.textContent = [
      consistency.status === 'degraded' ? 'Deployment mismatch' :
        consistency.status === 'ok' ? 'Deployment identity matches' : 'Build identity unverified',
      ...issues,
      ecosystem.status ? 'Ecosystem: ' + ecosystem.status : '',
      ...ecosystemIssues
    ].filter(Boolean).join(' · ');
    const when = new Date(payload.generated_at);
    updated.textContent = Number.isFinite(when.getTime()) ? 'Updated ' + when.toLocaleTimeString() : 'Update time not observed';
  }

  async function loadReadiness() {
    if (loading) return;
    loading = true;
    refresh.disabled = true;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);
    const options = { credentials: 'same-origin', cache: 'no-store', signal: controller.signal };
    try {
      const [response, routingResponse] = await Promise.all([
        fetch('/api/portal/health', options),
        fetch('/api/models/routing', options).catch(() => null)
      ]);
      if (!response.ok) throw new Error('Status unavailable');
      const payload = await response.json();
      const routingPayload = routingResponse?.ok ? await routingResponse.json() : null;
      const routing = routingPayload?.data || routingPayload;
      const services = Array.isArray(payload.services) ? payload.services : [];
      const core = services.find(service => service.id === 'core');
      const chatRoute = routing?.taskModels?.general_chat;
      const chatHost = chatRoute ? routing?.hosts?.[chatRoute.host] : null;
      const routeReady = chatRoute && (chatHost?.models || []).some(model =>
        String(model).replace(/:latest$/, '') === String(chatRoute.model).replace(/:latest$/, ''));
      renderServices(payload);

      if (!core || core.status === 'down') {
        present('blocked', 'Chat is unavailable', 'Open System details to see what needs attention.', 'fa-circle-xmark');
      } else if (core.detail?.ollama !== 'connected') {
        present('attention', 'Model setup needed', 'Agent X is running; connect a chat model to start.', 'fa-triangle-exclamation');
      } else if (!routing || !chatRoute) {
        present('attention', 'Chat route not observed', 'Open Chat to inspect or choose an installed model.', 'fa-circle-question');
      } else if (!routeReady) {
        present('attention', 'Chat route needs attention', 'Open Chat, then Take the controls to choose an installed model.', 'fa-triangle-exclamation');
      } else if (payload.consistency?.status === 'degraded' || payload.consistency?.status === 'unverified') {
        present('attention', 'Deployment needs attention', 'Open System details to inspect the service versions.', 'fa-triangle-exclamation');
      } else if (payload.summary?.status !== 'ok') {
        present('attention', 'Chat route is available', 'Some tools need attention; open System details.', 'fa-triangle-exclamation');
      } else {
        present('ready', 'Ready to chat', 'Chat, documents, and model comparison are available.', 'fa-circle-check');
      }
    } catch (_error) {
      present('blocked', 'Status not observed', 'The tools still open; refresh to check Agent X again.', 'fa-circle-question');
      serviceDetails.textContent = 'Service status not observed.';
      consistencyDetail.textContent = '';
      updated.textContent = 'Not observed';
    } finally {
      clearTimeout(timeout);
      loading = false;
      refresh.disabled = false;
    }
  }

  document.querySelectorAll('[data-home-action="show-shortcuts"]').forEach(button => {
    button.addEventListener('click', () => {
      if (typeof ShortcutsHelpModal !== 'undefined') ShortcutsHelpModal.show();
    });
  });
  refresh.addEventListener('click', loadReadiness);
  loadReadiness();
  setInterval(loadReadiness, 20000);
}());
