(function () {
  'use strict';

  const state = {
    latest: null,
    runs: [],
    severityFilter: 'all',
    busy: false
  };

  const $ = (id) => document.getElementById(id);

  function escapeHtml(value) {
    return String(value == null ? '' : value).replace(/[&<>"']/g, (char) => ({
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;'
    }[char]));
  }

  function formatDate(value) {
    if (!value) return '--';
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return String(value);
    return date.toLocaleString([], {
      year: 'numeric',
      month: 'short',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit'
    });
  }

  function badge(value) {
    const text = String(value || 'unknown');
    const cls = text.toLowerCase().replace(/[^a-z0-9_-]/g, '');
    return `<span class="ds-badge ds-badge-${escapeHtml(cls)}">${escapeHtml(text)}</span>`;
  }

  function plural(count, singular, pluralForm) {
    return `${count} ${count === 1 ? singular : (pluralForm || `${singular}s`)}`;
  }

  async function apiJson(url, options) {
    const response = await fetch(url, {
      headers: { 'Content-Type': 'application/json' },
      ...options
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(body.message || body.error || `HTTP ${response.status}`);
    }
    return body;
  }

  function normalizeLatest(payload) {
    const data = payload && payload.data ? payload.data : payload;
    if (!data) return null;

    if (data.findings && data.findings.scan_metadata) {
      return {
        generated: data.generated || data.findings.scan_metadata.timestamp_utc,
        status: data.status || data.findings.scan_metadata.status,
        totalFindings: data.total_findings ?? data.findings.scan_metadata.total_findings ?? 0,
        severityCounts: data.findings_by_severity || data.findings.scan_metadata.findings_by_severity || {},
        typeCounts: data.findings.scan_metadata.findings_by_type || {},
        findings: Array.isArray(data.findings.findings) ? data.findings.findings : [],
        summary: data.summary || '',
        paths: { output_dir: data.dir, ...(data.paths || {}) },
        docMapCheck: data.doc_map_check || null,
        docMapStatus: data.doc_map_check ? data.doc_map_check.status : 'unknown'
      };
    }

    return {
      generated: data.generated,
      status: data.audit_status,
      totalFindings: data.total_findings || 0,
      severityCounts: data.findings_by_severity || {},
      typeCounts: data.findings_by_type || {},
      findings: Array.isArray(data.findings) ? data.findings : [],
      summary: '',
      paths: data.paths || {},
      docMapCheck: null,
      docMapStatus: data.doc_map_status || 'unknown',
      docMapErrors: data.doc_map_errors || []
    };
  }

  function severityLine(counts) {
    const ordered = ['critical', 'high', 'medium', 'low'];
    const parts = ordered
      .filter((key) => Number(counts && counts[key]) > 0)
      .map((key) => `${key}: ${counts[key]}`);
    return parts.length ? parts.join(' · ') : 'No active findings';
  }

  function mapEntriesText(check) {
    if (!check) return '--';
    const entries = Array.isArray(check.entries) ? check.entries.length : 0;
    const errors = Array.isArray(check.errors) ? check.errors.length : 0;
    return `${plural(entries, 'entry', 'entries')} · ${plural(errors, 'error')}`;
  }

  function setBusy(isBusy) {
    state.busy = isBusy;
    const runBtn = $('dsRunBtn');
    const refreshBtn = $('dsRefreshBtn');
    if (runBtn) {
      runBtn.disabled = isBusy;
      runBtn.innerHTML = isBusy
        ? '<i class="fas fa-spinner fa-spin"></i><span>Running</span>'
        : '<i class="fas fa-play"></i><span>Run audit</span>';
    }
    if (refreshBtn) refreshBtn.disabled = isBusy;
  }

  function showToast(message, type) {
    const toast = $('dsToast');
    if (!toast) return;
    toast.textContent = message;
    toast.style.borderColor = type === 'error'
      ? 'rgba(248, 113, 113, 0.45)'
      : type === 'success'
        ? 'rgba(74, 222, 128, 0.45)'
        : 'rgba(124, 240, 255, 0.38)';
    toast.classList.add('visible');
    clearTimeout(showToast.timer);
    showToast.timer = setTimeout(() => toast.classList.remove('visible'), 3600);
  }

  function renderStatus() {
    const latest = state.latest;
    if (!latest) {
      $('dsStatus').textContent = '--';
      $('dsGenerated').textContent = 'No audit loaded';
      $('dsFindingsTotal').textContent = '--';
      $('dsSeverityLine').textContent = '--';
      $('dsMapStatus').textContent = '--';
      $('dsMapEntries').textContent = '--';
      return;
    }

    $('dsStatus').innerHTML = badge(latest.status);
    $('dsGenerated').textContent = formatDate(latest.generated);
    $('dsFindingsTotal').textContent = String(latest.totalFindings);
    $('dsSeverityLine').textContent = severityLine(latest.severityCounts);
    $('dsMapStatus').innerHTML = badge(latest.docMapStatus);
    $('dsMapEntries').textContent = mapEntriesText(latest.docMapCheck);
  }

  function renderArtifacts() {
    const list = $('dsArtifactList');
    const latest = state.latest;
    if (!list) return;
    if (!latest || !latest.paths) {
      list.innerHTML = '<div class="ds-empty">No artifacts loaded.</div>';
      return;
    }

    const paths = [
      ['Output', latest.paths.output_dir],
      ['Findings', latest.paths.findings],
      ['Summary', latest.paths.summary],
      ['Map check', latest.paths.doc_map_check]
    ].filter((item) => item[1]);

    $('dsOutputDir').textContent = latest.paths.output_dir || '--';
    list.innerHTML = paths.length
      ? paths.map(([label, path]) => `
          <div class="ds-artifact">
            <span>${escapeHtml(label)}</span>
            <code>${escapeHtml(path)}</code>
          </div>
        `).join('')
      : '<div class="ds-empty">No artifact paths returned.</div>';
  }

  function renderFindings() {
    const list = $('dsFindingsList');
    const latest = state.latest;
    if (!list) return;
    if (!latest) {
      list.innerHTML = '<div class="ds-empty">No audit loaded.</div>';
      return;
    }

    const findings = (latest.findings || []).filter((finding) => (
      state.severityFilter === 'all' || String(finding.severity || '').toLowerCase() === state.severityFilter
    ));

    const total = latest.findings.length;
    $('dsFindingsMeta').textContent = `${plural(total, 'finding')} · ${severityLine(latest.severityCounts)}`;

    if (!findings.length) {
      list.innerHTML = '<div class="ds-empty">No findings in this view.</div>';
      return;
    }

    list.innerHTML = findings.map((finding) => {
      const evidence = Array.isArray(finding.evidence) ? finding.evidence : [];
      const evidenceHtml = evidence.length
        ? `<div class="ds-evidence">${evidence.map((item) => {
            const suffix = item.lines ? `:${item.lines}` : '';
            return `<code>${escapeHtml((item.path || 'unknown') + suffix)}</code>`;
          }).join('')}</div>`
        : '';

      return `
        <article class="ds-finding">
          <div class="ds-finding-head">
            <div>
              <p class="ds-finding-title">${escapeHtml(finding.title || finding.id || 'Finding')}</p>
              <div class="ds-run-meta">${escapeHtml(finding.type || 'unknown')} · ${escapeHtml(finding.topic || 'unmapped')}</div>
            </div>
            ${badge(finding.severity)}
          </div>
          <div class="ds-finding-body">
            ${finding.observation ? `<p>${escapeHtml(finding.observation)}</p>` : ''}
            ${finding.suggested_action ? `<p><strong>Action:</strong> ${escapeHtml(finding.suggested_action)}</p>` : ''}
            ${evidenceHtml}
          </div>
        </article>
      `;
    }).join('');
  }

  function renderSummary() {
    const latest = state.latest;
    const summary = $('dsSummary');
    if (!summary) return;

    $('dsSummaryPath').textContent = latest && latest.paths && latest.paths.summary
      ? latest.paths.summary
      : '--';
    summary.textContent = latest && latest.summary
      ? latest.summary
      : latest
        ? 'Summary text is available after loading /api/docs-steward/latest.'
        : 'No audit loaded.';
  }

  function renderRuns() {
    const list = $('dsRunsList');
    if (!list) return;

    $('dsRunsMeta').textContent = plural(state.runs.length, 'run');

    if (!state.runs.length) {
      list.innerHTML = '<div class="ds-empty">No runs found.</div>';
      return;
    }

    list.innerHTML = state.runs.map((run) => `
      <div class="ds-run">
        <div class="ds-run-main">
          <p class="ds-run-name">${escapeHtml(run.name || 'run')}</p>
          <div class="ds-run-meta">${escapeHtml(formatDate(run.generated))} · ${escapeHtml(plural(run.total_findings || 0, 'finding'))}</div>
        </div>
        ${badge(run.status)}
      </div>
    `).join('');
  }

  function renderError(message) {
    $('dsFindingsList').innerHTML = `<div class="ds-error">${escapeHtml(message)}</div>`;
    $('dsSummary').textContent = message;
    $('dsArtifactList').innerHTML = `<div class="ds-error">${escapeHtml(message)}</div>`;
  }

  function renderAll() {
    renderStatus();
    renderArtifacts();
    renderFindings();
    renderSummary();
    renderRuns();
  }

  async function loadLatest() {
    const payload = await apiJson('/api/docs-steward/latest');
    state.latest = normalizeLatest(payload);
  }

  async function loadRuns() {
    const payload = await apiJson('/api/docs-steward/runs?limit=8');
    state.runs = payload && payload.data && Array.isArray(payload.data.runs)
      ? payload.data.runs
      : [];
  }

  async function refresh() {
    try {
      await Promise.all([loadLatest(), loadRuns()]);
      renderAll();
    } catch (err) {
      renderError(err.message);
      showToast(`Docs Steward unavailable: ${err.message}`, 'error');
    }
  }

  async function runAudit() {
    setBusy(true);
    try {
      const payload = await apiJson('/api/docs-steward/audit', {
        method: 'POST',
        body: '{}'
      });
      state.latest = normalizeLatest(payload);
      await loadRuns();
      renderAll();
      showToast('Docs Steward audit completed.', 'success');
      await loadLatest();
      renderAll();
    } catch (err) {
      showToast(`Audit failed: ${err.message}`, 'error');
    } finally {
      setBusy(false);
    }
  }

  function bindEvents() {
    const runBtn = $('dsRunBtn');
    const refreshBtn = $('dsRefreshBtn');
    if (runBtn) runBtn.addEventListener('click', runAudit);
    if (refreshBtn) refreshBtn.addEventListener('click', refresh);

    document.querySelectorAll('[data-severity-filter]').forEach((button) => {
      button.addEventListener('click', () => {
        state.severityFilter = button.dataset.severityFilter || 'all';
        document.querySelectorAll('[data-severity-filter]').forEach((item) => {
          item.classList.toggle('active', item === button);
        });
        renderFindings();
      });
    });
  }

  document.addEventListener('DOMContentLoaded', () => {
    bindEvents();
    refresh();
  });
})();
