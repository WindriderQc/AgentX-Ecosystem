(function () {
  'use strict';
  const shared = window.NerveCenterShared;

  function buildTaskCard(hostId, hostname, tasks) {
    const activeTask = tasks.find(t => t.status === 'dispatched');
    const recent = tasks.filter(t => t.status !== 'dispatched').slice(0, 5);

    const activeLine = activeTask
      ? `<div style="display:flex;align-items:center;gap:6px;padding:6px 8px;background:rgba(251,191,36,0.08);border:1px solid rgba(251,191,36,0.2);border-radius:6px;margin-bottom:8px;">
          <i class="fas fa-spinner fa-spin" style="color:#fbbf24;font-size:11px;"></i>
          <span style="font-size:0.82rem;color:#fbbf24;font-weight:600;">${shared.escapeHtml(activeTask.type)}</span>
          <span style="font-size:0.72rem;color:var(--muted);margin-left:auto;">${shared.timeAgo(activeTask.dispatchedAt || activeTask.createdAt)}</span>
        </div>`
      : '';

    const historyRows = recent.map(t => {
      const icon = t.status === 'completed'
        ? '<i class="fas fa-check" style="color:#4ade80;font-size:10px;"></i>'
        : t.status === 'failed'
          ? '<i class="fas fa-xmark" style="color:#f87171;font-size:10px;"></i>'
          : '<i class="fas fa-clock" style="color:var(--muted);font-size:10px;"></i>';
      const resultPreview = t.result
        ? `<span style="font-size:0.7rem;color:var(--muted);max-width:200px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;display:inline-block;" title="${shared.escapeHtml(JSON.stringify(t.result).slice(0, 300))}">${shared.escapeHtml(JSON.stringify(t.result).slice(0, 60))}</span>`
        : '';
      return `<tr>
        <td style="padding:3px 6px;">${icon}</td>
        <td style="padding:3px 6px;font-size:0.8rem;">${shared.escapeHtml(t.type)}</td>
        <td style="padding:3px 6px;font-size:0.72rem;color:var(--muted);">${shared.timeAgo(t.completedAt || t.createdAt)}</td>
        <td style="padding:3px 6px;">${resultPreview}</td>
      </tr>`;
    }).join('');

    return `
      <div class="nc-host-card" data-host-task-card="${hostId}">
        <div style="display:flex;align-items:center;gap:8px;margin-bottom:8px;">
          <strong style="font-size:0.9rem;">${shared.escapeHtml(hostname)}</strong>
          <div style="display:flex;gap:4px;margin-left:auto;">
            <button class="nc-btn nc-task-action" data-host-id="${hostId}" data-task-type="diag.ping" style="font-size:9px;padding:2px 8px;" title="Ping agent">
              <i class="fas fa-satellite-dish"></i> Ping
            </button>
            <button class="nc-btn nc-task-action" data-host-id="${hostId}" data-task-type="ollama.restart" style="font-size:9px;padding:2px 8px;" title="Restart Ollama">
              <i class="fas fa-rotate"></i> Restart
            </button>
            <button class="nc-btn nc-task-action" data-host-id="${hostId}" data-task-type="ollama.unloadAll" style="font-size:9px;padding:2px 8px;" title="Unload all models">
              <i class="fas fa-broom"></i> Unload
            </button>
            <button class="nc-btn nc-task-action" data-host-id="${hostId}" data-task-type="nvidia.smi" style="font-size:9px;padding:2px 8px;" title="Full nvidia-smi dump">
              <i class="fas fa-microchip"></i> nvidia
            </button>
          </div>
        </div>
        ${activeLine}
        ${recent.length > 0 ? `<table style="width:100%;border-collapse:collapse;">${historyRows}</table>` : '<div style="color:var(--muted);font-size:0.8rem;">No recent tasks</div>'}
      </div>`;
  }

  function attachTaskHandlers() {
    document.querySelectorAll('.nc-task-action').forEach(button => {
      button.addEventListener('click', async () => {
        const hostId = button.dataset.hostId;
        const type = button.dataset.taskType;
        button.disabled = true;
        try {
          const data = await shared.fetchJson(`/api/hosts/${hostId}/tasks`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ type })
          });
          if (data.status === 'success') {
            Toast.success(`Task ${type} dispatched`);
            setTimeout(() => window.NerveCenterTasks?.loadTasks?.(), 2000);
          } else {
            Toast.error(data.message || 'Dispatch failed');
          }
        } catch (err) {
          Toast.error(`Failed: ${err.message}`);
        } finally {
          button.disabled = false;
        }
      });
    });
  }

  async function loadTasks() {
    const body = document.getElementById('sectionTasksBody');
    if (!body) return;

    body.innerHTML = '<div class="nc-section-placeholder"><i class="fas fa-spinner fa-spin"></i> Loading tasks...</div>';

    try {
      const hostsJson = await shared.fetchJson('/api/hosts');
      const hosts = hostsJson.data || [];
      const onlineHosts = hosts.filter(h => h.status !== 'offline');

      if (onlineHosts.length === 0) {
        body.innerHTML = '<div class="nc-section-placeholder" style="color:var(--muted);">No online hosts with agents</div>';
        return;
      }

      const taskResults = await Promise.all(
        onlineHosts.map(h =>
          shared.fetchJson(`/api/hosts/${h.hostId}/tasks?limit=10`)
            .then(r => ({ hostId: h.hostId, hostname: h.hostname, tasks: r.data || [] }))
            .catch(() => ({ hostId: h.hostId, hostname: h.hostname, tasks: [] }))
        )
      );

      const cards = taskResults.map(r => buildTaskCard(r.hostId, r.hostname, r.tasks)).join('');
      body.innerHTML = `<div class="nc-host-cards">${cards}</div>`;
      attachTaskHandlers();
    } catch (err) {
      body.innerHTML = `<div class="nc-section-placeholder" style="color:#f87171;"><i class="fas fa-exclamation-triangle"></i> ${shared.escapeHtml(err.message)}</div>`;
    }
  }

  window.NerveCenterTasks = { loadTasks };
})();
