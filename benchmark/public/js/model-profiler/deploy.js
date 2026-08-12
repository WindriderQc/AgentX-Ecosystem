// public/js/model-profiler/deploy.js
/**
 * Deploy sub-view — Roster, Modelfile editor, and Model info panel.
 * Export: renderDeploy(container, state, api)
 */

function esc(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function relTime(ts) {
  if (!ts) return 'never';
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return 'recently';
  const diff = Math.max(0, Math.round((Date.now() - d.getTime()) / 1000));
  if (diff < 60) return `${diff}s ago`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}

function statusBadge(status) {
  const s = (status || 'pending').toLowerCase();
  if (s === 'deployed' || s === 'active')
    return '<span class="mp-badge-deployed">Deployed</span>';
  if (s === 'failed' || s === 'error')
    return '<span class="mp-badge-failed">Failed</span>';
  return '<span class="mp-badge-pending">Pending</span>';
}

// ─── Roster panel ────────────────────────────────────────────────────────────

function renderRoster(roster) {
  if (!roster.length) {
    return `<div class="mp-deploy-roster">
      <h3>Adapted Models</h3>
      <div style="font-size:0.7rem; color:var(--r-text-dim,#555); padding:1rem 0; text-align:center;">
        No adapted models yet. Profile and adapt a model first.
      </div>
    </div>`;
  }

  const rows = roster.map((item, i) => {
    const name = item.adaptedName || item.modelName || '?';
    const host = item.hostId || '?';
    const status = item.deployment?.status || 'pending';
    return `<tr class="mp-roster-row" data-index="${i}" data-model="${esc(item.modelName)}" data-host="${esc(item.hostId)}">
      <td style="word-break:break-all;">${esc(name)}</td>
      <td>${esc(host)}</td>
      <td>${statusBadge(status)}</td>
    </tr>`;
  }).join('');

  return `<div class="mp-deploy-roster">
    <h3>Adapted Models</h3>
    <table class="mp-roster-table">
      <thead><tr><th>Model</th><th>Host</th><th>Status</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
  </div>`;
}

// ─── Modelfile editor panel ──────────────────────────────────────────────────

function renderEditor(selected) {
  if (!selected) {
    return `<div class="mp-deploy-editor">
      <h3>Modelfile Editor</h3>
      <div style="flex:1; display:flex; align-items:center; justify-content:center; color:var(--r-text-dim,#555); font-size:0.72rem;">
        Select a model from the roster to edit its Modelfile
      </div>
    </div>`;
  }

  const mf = selected.modelfile?.content || selected.modelfile || '# No modelfile generated yet';
  const cfg = selected.config || {};
  const prof = selected.profile || {};
  const ctx = cfg.num_ctx || prof.optimalNumCtx || '?';
  const vram = prof.vramUsedMiB ? (prof.vramUsedMiB / 1024).toFixed(1) + ' GB' : '?';
  const tps = prof.tokensPerSec ? Number(prof.tokensPerSec).toFixed(1) + ' tok/s' : '?';

  return `<div class="mp-deploy-editor">
    <h3>Modelfile &mdash; ${esc(selected.adaptedName || selected.modelName)}</h3>
    <textarea class="mp-modelfile-textarea" id="mp-modelfile-edit">${esc(mf)}</textarea>
    <div class="mp-editor-actions">
      <button class="mp-action mp-action--teal" id="mp-deploy-btn">Deploy to Host</button>
      <button class="mp-action" id="mp-reset-btn">Reset to Generated</button>
      <a class="mp-action" id="mp-export-link" target="_blank" style="text-decoration:none;">Export Modelfile</a>
    </div>
    <div class="mp-editor-impact">
      <span class="mp-editor-impact-item">Context: <strong>${ctx}</strong></span>
      <span class="mp-editor-impact-item">VRAM est: <strong>${vram}</strong></span>
      <span class="mp-editor-impact-item">Throughput est: <strong>${tps}</strong></span>
    </div>
  </div>`;
}

// ─── Info panel ──────────────────────────────────────────────────────────────

function renderLineage(lineageData) {
  // lineageData comes from GET /models/:name/lineage → [{ hostId, lineage: { parentModel, rootModel, quantization } }]
  // Or could be a single lineage object from the adaptation
  if (!lineageData) return '<div style="font-size:0.68rem; color:var(--r-text-dim,#555);">No lineage data</div>';

  // Extract lineage from first entry or from direct object
  const lin = Array.isArray(lineageData) ? lineageData[0]?.lineage : lineageData;
  if (!lin?.parentModel) return '<div style="font-size:0.68rem; color:var(--r-text-dim,#555);">No lineage data</div>';

  const nodes = [];
  if (lin.rootModel && lin.rootModel !== lin.parentModel) {
    nodes.push({ name: lin.rootModel, cls: 'mp-lineage-node--root', label: 'root' });
  }
  nodes.push({ name: lin.parentModel, cls: '', label: lin.quantization ? `${lin.quantization}` : 'parent' });

  return `<div class="mp-lineage-tree">
    ${nodes.map((n, i) => `<div class="mp-lineage-node ${n.cls}">
      ${'&nbsp;&nbsp;'.repeat(i)}${i > 0 ? '&#x2514; ' : ''}${esc(n.name)}
      <span style="font-size:0.55rem; color:#555;">(${n.label})</span>
    </div>`).join('')}
  </div>`;
}

function renderProfileSummary(profile) {
  if (!profile) return '<div style="font-size:0.68rem; color:var(--r-text-dim,#555);">No profile data</div>';
  const items = [
    profile.tokensPerSec != null ? `${Number(profile.tokensPerSec).toFixed(1)} tok/s` : null,
    profile.ttftMs != null ? `${Math.round(profile.ttftMs)} ms TTFT` : null,
    profile.optimalNumCtx != null ? `ctx ${profile.optimalNumCtx}` : null,
    profile.vramUsedMiB != null ? `${(profile.vramUsedMiB / 1024).toFixed(1)} GB VRAM` : null,
    profile.spill?.spillDetected ? `Spills at ${profile.spill.spillNumCtx || '?'} (safe: ${profile.spill.lastSafeNumCtx || '?'})` : (profile.spill && !profile.spill.spillDetected ? 'No spill' : null),
  ].filter(Boolean);

  const ci = profile.contextInsight;
  let insightHtml = '';
  if (ci?.upgradeAvailable) {
    const fmtCtx = n => n >= 1024 ? `${Math.round(n / 1024)}k` : String(n);
    insightHtml = `<div style="margin-top:0.35rem;"><span style="font-size:0.58rem; color:#0f0; background:rgba(0,255,0,0.08); border:1px solid rgba(0,255,0,0.2); border-radius:4px; padding:0.1rem 0.4rem;">
      &#x25B2; ${ci.upgradeFactor}x ctx upgrade (${fmtCtx(ci.previousNumCtx)} &#x2192; ${fmtCtx(ci.discoveredNumCtx)})
    </span></div>`;
  } else if (ci && ci.upgradeFactor < 0.75) {
    const fmtCtx = n => n >= 1024 ? `${Math.round(n / 1024)}k` : String(n);
    insightHtml = `<div style="margin-top:0.35rem;"><span style="font-size:0.58rem; color:#ff6b6b; background:rgba(255,107,107,0.08); border:1px solid rgba(255,107,107,0.2); border-radius:4px; padding:0.1rem 0.4rem;">
      &#x25BC; ctx too high (${fmtCtx(ci.previousNumCtx)} &#x2192; ${fmtCtx(ci.discoveredNumCtx)})
    </span></div>`;
  }

  return `<div style="display:flex; flex-wrap:wrap; gap:0.35rem;">
    ${items.map(item => `<span style="font-size:0.62rem; color:#4ecdc4;
      background:rgba(78,205,196,0.08); border:1px solid rgba(78,205,196,0.18);
      border-radius:4px; padding:0.15rem 0.45rem;">${item}</span>`).join('')}
  </div>${insightHtml}`;
}

function renderDeployHistory(history) {
  if (!history || !history.length) {
    return '<div style="font-size:0.68rem; color:var(--r-text-dim,#555);">No deployment history</div>';
  }
  const entries = history.slice(0, 5);
  return `<div class="mp-deploy-history">
    ${entries.map(e => `<div class="mp-deploy-history-entry">
      <span>${statusBadge(e.status)}${e.modelfileHash ? ` <span style="font-size:0.55rem;color:#555;">${e.modelfileHash.slice(0,12)}</span>` : ''}</span>
      <span style="font-size:0.6rem; color:var(--r-text-dim,#555);">${relTime(e.deployedAt)}</span>
    </div>`).join('')}
  </div>`;
}

function renderInfoPanel(selected, lineage, history) {
  if (!selected) {
    return `<div class="mp-deploy-info">
      <h3>Model Info</h3>
      <div style="font-size:0.72rem; color:var(--r-text-dim,#555); padding:1rem 0; text-align:center;">
        Select a model to view details
      </div>
    </div>`;
  }

  const profile = selected.profile || selected.adaptation || {};

  return `<div class="mp-deploy-info">
    <h3>Model Info</h3>

    <div class="mp-info-section">
      <div class="mp-info-section-title">Lineage</div>
      ${renderLineage(lineage)}
    </div>

    <div class="mp-info-section">
      <div class="mp-info-section-title">Profile Summary</div>
      ${renderProfileSummary(profile)}
    </div>

    <div class="mp-info-section">
      <div class="mp-info-section-title">Deployment History</div>
      ${renderDeployHistory(history)}
    </div>

    <div class="mp-info-actions">
      <button class="mp-action mp-action--teal" id="mp-info-deploy-btn">Deploy to Host</button>
      <button class="mp-action" id="mp-info-save-btn">Save Config Only</button>
      <a class="mp-action" id="mp-info-export-link" target="_blank" style="text-decoration:none;">Export Modelfile</a>
      <button class="mp-action mp-action--orange" id="mp-info-remove-btn">Remove from Host</button>
    </div>
  </div>`;
}

// ─── Main render ─────────────────────────────────────────────────────────────

export async function renderDeploy(container, state, api) {
  container.innerHTML = '<div style="padding:24px; color:#8892b0; font-size:0.8rem;">Loading deploy roster...</div>';

  let roster = [];
  try {
    const res = await api.getAdaptedRoster({});
    roster = Array.isArray(res) ? res : (res?.roster || res?.data || []);
  } catch (_) {}

  state._deployRoster = roster;
  state._deploySelected = state._deploySelected || null;

  const selected = state._deploySelected;
  let lineage = [];
  let history = [];
  let selectedData = null;

  if (selected) {
    const item = roster.find(r =>
      r.modelName === selected.modelName && r.hostId === selected.hostId
    );
    selectedData = item || null;

    // Fetch lineage and history in parallel
    const [lineageRes, historyRes] = await Promise.all([
      api.getModelLineage(selected.modelName).catch(() => null),
      api.getDeploymentHistory(selected.modelName, selected.hostId).catch(() => null),
    ]);

    lineage = Array.isArray(lineageRes) ? lineageRes : (lineageRes?.lineage ? [lineageRes] : []);
    history = historyRes?.history || (Array.isArray(historyRes) ? historyRes : []);

    // If we have selectedData, try to get the adaptation details
    if (selectedData && !selectedData.modelfile) {
      try {
        const adapt = await api.getAdaptation(selected.modelName, selected.hostId);
        if (adapt) {
          selectedData = { ...selectedData, ...adapt };
        }
      } catch (_) {}
    }
  }

  container.innerHTML = `<div class="mp-deploy-layout">
    ${renderRoster(roster)}
    ${renderEditor(selectedData)}
    ${renderInfoPanel(selectedData, lineage, history)}
  </div>`;

  wireDeployActions(container, state, api, roster, selectedData);
}

// ─── Event wiring ────────────────────────────────────────────────────────────

function wireDeployActions(container, state, api, roster, selectedData) {
  // Roster row click — select model
  container.querySelectorAll('.mp-roster-row').forEach(row => {
    row.addEventListener('click', () => {
      const modelName = row.dataset.model;
      const hostId = row.dataset.host;
      state._deploySelected = { modelName, hostId };
      renderDeploy(container, state, api);
    });
  });

  // Highlight active row
  if (state._deploySelected) {
    const activeRow = container.querySelector(
      `.mp-roster-row[data-model="${CSS.escape(state._deploySelected.modelName)}"][data-host="${CSS.escape(state._deploySelected.hostId)}"]`
    );
    if (activeRow) activeRow.classList.add('mp-roster-row--active');
  }

  // Set export links
  if (selectedData && state._deploySelected) {
    const url = api.exportModelfileUrl(state._deploySelected.modelName, state._deploySelected.hostId);
    const links = container.querySelectorAll('#mp-export-link, #mp-info-export-link');
    links.forEach(a => { a.href = url; });
  }

  // Deploy button(s)
  const deployBtns = container.querySelectorAll('#mp-deploy-btn, #mp-info-deploy-btn');
  deployBtns.forEach(btn => {
    btn.addEventListener('click', async () => {
      if (!state._deploySelected) return;
      const { modelName, hostId } = state._deploySelected;

      // Validate first
      const textarea = container.querySelector('#mp-modelfile-edit');
      const content = textarea?.value;
      btn.disabled = true;
      btn.textContent = 'Validating...';

      try {
        if (content) {
          await api.validateModelfile(modelName, hostId, content);
        }
        btn.textContent = 'Deploying...';
        await api.deployAdaptation(modelName, hostId);
        btn.textContent = 'Deployed!';
        setTimeout(() => renderDeploy(container, state, api), 1500);
      } catch (err) {
        btn.textContent = 'Deploy Failed';
        btn.disabled = false;
        const feedback = container.querySelector('.mp-editor-impact');
        if (feedback) {
          feedback.innerHTML = `<span style="color:#f85149; font-size:0.68rem;">${esc(err.message)}</span>`;
        }
        setTimeout(() => { btn.textContent = 'Deploy to Host'; }, 3000);
      }
    });
  });

  // Reset button
  const resetBtn = container.querySelector('#mp-reset-btn');
  if (resetBtn) {
    resetBtn.addEventListener('click', () => {
      renderDeploy(container, state, api);
    });
  }

  // Save config only
  const saveBtn = container.querySelector('#mp-info-save-btn');
  if (saveBtn) {
    saveBtn.addEventListener('click', async () => {
      if (!state._deploySelected) return;
      const { modelName, hostId } = state._deploySelected;
      const textarea = container.querySelector('#mp-modelfile-edit');
      const content = textarea?.value;
      saveBtn.disabled = true;
      saveBtn.textContent = 'Saving...';
      try {
        if (content) {
          await api.validateModelfile(modelName, hostId, content);
        }
        saveBtn.textContent = 'Saved!';
        setTimeout(() => { saveBtn.textContent = 'Save Config Only'; saveBtn.disabled = false; }, 2000);
      } catch (err) {
        saveBtn.textContent = 'Save Failed';
        setTimeout(() => { saveBtn.textContent = 'Save Config Only'; saveBtn.disabled = false; }, 3000);
      }
    });
  }

  // Remove button
  const removeBtn = container.querySelector('#mp-info-remove-btn');
  if (removeBtn) {
    removeBtn.addEventListener('click', async () => {
      if (!state._deploySelected) return;
      const { modelName, hostId } = state._deploySelected;
      if (!confirm(`Remove deployment of ${modelName} from ${hostId}?`)) return;
      removeBtn.disabled = true;
      removeBtn.textContent = 'Removing...';
      try {
        await api.removeDeployment(modelName, hostId);
        state._deploySelected = null;
        renderDeploy(container, state, api);
      } catch (err) {
        removeBtn.textContent = 'Remove Failed';
        setTimeout(() => { removeBtn.textContent = 'Remove from Host'; removeBtn.disabled = false; }, 3000);
      }
    });
  }
}
