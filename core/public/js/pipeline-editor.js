(function () {
  'use strict';
  const $ = id => document.getElementById(id);
  const fields = { title: 'pipelineEditTitle', spec: 'pipelineEditSpec', service: 'pipelineEditService', priority: 'pipelineEditPriority', dependsOn: 'pipelineEditDependencies', dueAt: 'pipelineEditDue', notBefore: 'pipelineEditNotBefore', planningItemIds: 'pipelineEditRoadmap', epic: 'pipelineEditEpic' };
  let dialog, form, current = null, baseline = {}, token = null, sourceKey = '', saving = false;
  let drafting = null, proposal = null, latest = null, generation = 0;

  async function api(url, options = {}) {
    const response = await fetch(url, { ...options, headers: { 'Content-Type': 'application/json', ...options.headers } });
    const body = await response.json();
    if (!response.ok || body.ok === false) throw Object.assign(new Error(body.message || 'Request failed'), { status: response.status, code: body.code });
    return body.data;
  }
  function status(message, error = false) {
    $('pipelineEditorStatus').textContent = message;
    $('pipelineEditorStatus').dataset.error = String(error);
  }
  function localDate(value) {
    if (!value) return '';
    const date = new Date(value);
    return new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
  }
  function values() {
    return {
      title: $(fields.title).value.trim(), spec: $(fields.spec).value,
      service: $(fields.service).value.trim(), priority: Number($(fields.priority).value), epic: $(fields.epic).value,
      dependsOn: [...new Set($(fields.dependsOn).value.split(/[\s,]+/).filter(Boolean))],
      dueAt: $(fields.dueAt).value ? new Date($(fields.dueAt).value).toISOString() : null,
      notBefore: $(fields.notBefore).value ? new Date($(fields.notBefore).value).toISOString() : null,
      planningItemIds: [...$(fields.planningItemIds).selectedOptions].map(option => option.value).sort()
    };
  }
  function different(a, b) { return JSON.stringify(a) !== JSON.stringify(b); }
  function dirty() { return different(values(), baseline); }
  function setRoadmap(items = [], selected = []) {
    const select = $(fields.planningItemIds);
    select.replaceChildren();
    const available = new Map(items.map(item => [String(item.id || item._id), `${item.type} · ${item.title}`]));
    for (const id of selected) if (!available.has(String(id))) available.set(String(id), `Linked item · ${id}`);
    for (const [id, title] of available) select.add(new Option(title, id, false, selected.map(String).includes(id)));
  }
  function fill(task = {}) {
    for (const key of ['title', 'spec', 'service', 'epic']) $(fields[key]).value = task[key] || '';
    $(fields.priority).value = task.priority || 3;
    $(fields.dependsOn).value = (task.dependsOn || []).join(', ');
    $(fields.dueAt).value = localDate(task.dueAt);
    $(fields.notBefore).value = localDate(task.notBefore);
    setRoadmap([], task.planningItemIds || []);
    baseline = values();
  }
  function stopDraft(message = '') {
    generation += 1;
    drafting?.abort(); drafting = null; proposal = null;
    $('pipelineDraftGenerate').disabled = saving;
    $('pipelineDraftCancel').hidden = true;
    $('pipelineDraftProposal').hidden = true;
    if (message) $('pipelineDraftStatus').textContent = message;
  }
  function close() {
    stopDraft();
    dialog.close();
  }
  function requestClose() {
    if (saving) return;
    if (dirty()) {
      $('pipelineEditorDiscard').hidden = false;
      $('pipelineEditorDiscard').scrollIntoView({ block: 'nearest' });
      $('pipelineDiscardCancel').focus();
    } else close();
  }
  async function loadRoadmap() {
    const openGeneration = sourceKey;
    try {
      const data = await api('/api/planning/items');
      if (sourceKey !== openGeneration) return;
      // Do not change selections made while the option list was loading.
      const nowSelected = [...$(fields.planningItemIds).selectedOptions].map(option => option.value);
      setRoadmap(data.items || [], nowSelected);
      $('pipelineRoadmapStatus').textContent = data.items?.length ? 'Optional. Select related items; Ctrl/Cmd selects several on desktop.' : 'No roadmap items yet. You can add them in Planning.';
    } catch {
      if (sourceKey !== openGeneration) return;
      $('pipelineRoadmapStatus').textContent = 'Roadmap is unavailable. Existing links are kept; other task fields can still be saved.';
    }
  }
  async function open(pipelineId, tasks = []) {
    stopDraft(); current = null; latest = null; token = null; saving = false;
    sourceKey = Array.from(crypto.getRandomValues(new Uint32Array(4)), n => n.toString(16)).join('-');
    const opening = sourceKey;
    form.reset(); fill();
    for (const id of ['pipelineEditorDetails', 'pipelineEditorAssist']) $(id).open = false;
    for (const id of ['pipelineEditorConflict', 'pipelineEditorDiscard', 'pipelineDraftProposal']) $(id).hidden = true;
    $('pipelineDraftStatus').textContent = 'Optional. The model proposes changes; you decide what goes into the task.';
    $('pipelineEditorHeading').textContent = pipelineId ? `Edit task #${pipelineId}` : 'New task';
    $('pipelineEditorContext').textContent = pipelineId ? 'Loading the task…' : 'Capture what needs to happen. Add detail when it helps.';
    $('pipelineEditorSave').textContent = pipelineId ? 'Save changes' : 'Add to queue';
    $('pipelineEditorSave').disabled = Boolean(pipelineId);
    dialog.querySelector('.pipeline-editor-body').inert = Boolean(pipelineId);
    $('pipelineServiceChoices').replaceChildren(...[...new Set(['core', 'benchmark', 'rag', 'data', 'ecosystem', ...tasks.map(task => task.service).filter(Boolean)])].sort().map(service => new Option(service, service)));
    status(''); dialog.showModal(); $(fields.title).focus();
    if (!pipelineId) return;
    try {
      const data = await api(`/api/pipeline/tasks/${encodeURIComponent(pipelineId)}`);
      if (sourceKey !== opening || !dialog.open) return;
      current = data.task; token = data.editToken; fill(current);
      $('pipelineEditorContext').textContent = `${current.status.replace(/_/g, ' ')}${current.assignee ? ` · ${current.assignee}` : ''}. Saving edits keeps the current status, owner and history.`;
      $('pipelineEditorSave').disabled = false;
      dialog.querySelector('.pipeline-editor-body').inert = false;
      $(fields.title).focus();
    } catch (error) { if (sourceKey === opening) status(`Could not load this task: ${error.message}. Close and reopen to retry.`, true); }
  }
  async function compareLatest() {
    const data = await api(`/api/pipeline/tasks/${encodeURIComponent(current.pipelineId)}`);
    latest = data;
    const task = data.task;
    $('pipelineLatestTask').textContent = `${task.title}\n\n${task.spec || ''}\n\nService: ${task.service || 'Unspecified'} · P${task.priority || 3}\nDependencies: ${(task.dependsOn || []).join(', ') || 'None'}\nDue: ${task.dueAt || 'None'}\nAvailable after: ${task.notBefore || 'Now'}\nRoadmap: ${(task.planningItemIds || []).join(', ') || 'None'}\nGroup: ${task.epic || 'None'}`;
    $('pipelineEditorConflict').hidden = false;
    $('pipelineEditorSave').disabled = true;
    $('pipelineEditorConflict').scrollIntoView({ block: 'nearest' });
  }
  async function save(event) {
    event.preventDefault();
    if (saving || !form.reportValidity()) return;
    stopDraft(); saving = true; $('pipelineEditorSave').disabled = true; $('pipelineDraftGenerate').disabled = true;
    status('Saving…');
    try {
      const input = values();
      let id;
      if (current) {
        const changes = Object.fromEntries(Object.entries(input).filter(([key, value]) => different(value, baseline[key])));
        const data = await api(`/api/pipeline/tasks/${encodeURIComponent(current.pipelineId)}`, { method: 'PATCH', body: JSON.stringify({ changes, editToken: token, by: 'operator' }) });
        id = data.task.pipelineId;
      } else {
        const data = await api('/api/pipeline/tasks', { method: 'POST', body: JSON.stringify({ ...input, source: 'pipeline-ui', sourceKey }) });
        id = data.task.pipelineId;
        if (data.task.alreadyExisting) {
          current = { pipelineId: id };
          $('pipelineEditorHeading').textContent = `Edit task #${id}`;
          $('pipelineEditorSave').textContent = 'Save changes';
          await compareLatest();
          status('An earlier save created this task. Compare the saved task with your draft before making further changes.', true);
          return;
        }
      }
      close();
      document.dispatchEvent(new CustomEvent('pipeline-task-saved', { detail: { pipelineId: id } }));
    } catch (error) {
      status(error.message, true);
      if (error.code === 'TASK_EDIT_CONFLICT') await compareLatest().catch(() => status('Could not load the latest task. Your draft is kept; try saving again.', true));
    } finally {
      saving = false;
      $('pipelineEditorSave').disabled = Boolean(latest);
      $('pipelineDraftGenerate').disabled = false;
    }
  }
  async function suggest() {
    const instruction = $('pipelineDraftInstruction').value.trim();
    if (!instruction) { $('pipelineDraftInstruction').focus(); $('pipelineDraftStatus').textContent = 'Describe your idea or requested change first.'; return; }
    stopDraft(); const sequence = generation;
    drafting = new AbortController();
    $('pipelineDraftGenerate').disabled = true; $('pipelineDraftCancel').hidden = false;
    $('pipelineDraftStatus').textContent = 'Preparing a proposal… You can stop or keep editing.';
    const value = values();
    try {
      const data = await api('/api/pipeline/draft', { method: 'POST', signal: drafting.signal, body: JSON.stringify({ instruction, current: { title: value.title, spec: value.spec, service: value.service, priority: value.priority } }) });
      if (generation !== sequence || !dialog.open) return;
      proposal = data.draft;
      $('pipelineDraftTitle').textContent = proposal.title;
      $('pipelineDraftSpec').textContent = proposal.spec;
      $('pipelineDraftMeta').textContent = `${proposal.service || 'Unspecified service'} · P${proposal.priority}`;
      $('pipelineDraftProposal').hidden = false;
      $('pipelineDraftStatus').textContent = 'Review the proposal. Nothing has been saved.';
    } catch (error) {
      if (generation === sequence) $('pipelineDraftStatus').textContent = error.name === 'AbortError' ? 'Stopped. Your draft is unchanged.' : error.message;
    } finally {
      if (generation === sequence) { drafting = null; $('pipelineDraftGenerate').disabled = false; $('pipelineDraftCancel').hidden = true; }
    }
  }
  document.addEventListener('DOMContentLoaded', () => {
    dialog = $('pipelineTaskEditor'); form = $('pipelineEditorForm');
    if (!dialog) return;
    form.addEventListener('submit', save);
    dialog.addEventListener('cancel', event => { event.preventDefault(); requestClose(); });
    dialog.querySelectorAll('[data-editor-close]').forEach(button => button.addEventListener('click', requestClose));
    $('pipelineDiscardConfirm').addEventListener('click', close);
    $('pipelineDiscardCancel').addEventListener('click', () => { $('pipelineEditorDiscard').hidden = true; $(fields.spec).focus(); });
    $('pipelineEditorDetails').addEventListener('toggle', () => { if ($('pipelineEditorDetails').open) void loadRoadmap(); });
    $('pipelineDraftGenerate').addEventListener('click', suggest);
    $('pipelineDraftCancel').addEventListener('click', () => stopDraft('Stopped. Your draft is unchanged.'));
    $('pipelineDraftDismiss').addEventListener('click', () => stopDraft('Proposal dismissed. Your draft is unchanged.'));
    $('pipelineDraftApply').addEventListener('click', () => {
      if (!proposal) return;
      for (const key of ['title', 'spec', 'service', 'priority']) $(fields[key]).value = proposal[key];
      stopDraft('Proposal applied to the form. Save when ready.');
      $(fields.spec).focus();
    });
    for (const event of ['input', 'change']) form.addEventListener(event, () => {
      if (drafting || proposal) stopDraft('Your edits are kept. Request a new proposal when ready.');
    });
    $('pipelineUseLatest').addEventListener('click', () => {
      if (!latest) return;
      current = latest.task; token = latest.editToken; fill(current); latest = null;
      $('pipelineEditorConflict').hidden = true; $('pipelineEditorSave').disabled = false; status('Loaded the saved task.');
      if ($('pipelineEditorDetails').open) void loadRoadmap();
    });
    $('pipelineKeepEdits').addEventListener('click', () => {
      if (!latest) return;
      const draft = values(); current = latest.task; token = latest.editToken; fill(current);
      // Keep the latest snapshot as the comparison base, then restore the user's draft.
      const savedBase = baseline; fill(draft); baseline = savedBase; latest = null;
      $('pipelineEditorConflict').hidden = true; $('pipelineEditorSave').disabled = false; status('Your draft is ready to save over the compared task.');
      if ($('pipelineEditorDetails').open) void loadRoadmap();
    });
    form.addEventListener('keydown', event => {
      if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') { event.preventDefault(); if (!$('pipelineEditorSave').disabled) form.requestSubmit(); }
    });
  });
  window.PipelineTaskEditor = { open };
})();
