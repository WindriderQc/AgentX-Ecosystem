(function (root, factory) {
  var api = factory();

  if (typeof module === 'object' && module.exports) {
    module.exports = api;
    return;
  }

  root.AgentXPrompts = api;
  if (root.document) {
    var start = function () {
      api.createPromptPage({
        document: root.document,
        fetch: root.fetch && root.fetch.bind(root),
        window: root
      }).init();
    };

    if (root.document.readyState === 'loading') {
      root.document.addEventListener('DOMContentLoaded', start, { once: true });
    } else {
      start();
    }
  }
})(typeof window !== 'undefined' ? window : null, function () {
  'use strict';

  var DEFAULT_TIMEOUT_MS = 12000;

  function finiteNumber(value, fallback) {
    var number = Number(value);
    return Number.isFinite(number) ? number : fallback;
  }

  function nonNegativeNumber(value) {
    return Math.max(0, finiteNumber(value, 0));
  }

  function escapeHtml(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }

  function promptStats(prompt) {
    var stats = prompt && prompt.stats && typeof prompt.stats === 'object' ? prompt.stats : {};
    var positive = nonNegativeNumber(stats.positiveCount);
    var negative = nonNegativeNumber(stats.negativeCount);
    var feedback = positive + negative;
    return {
      impressions: nonNegativeNumber(stats.impressions),
      positive: positive,
      negative: negative,
      feedback: feedback,
      positiveRate: feedback > 0 ? (positive / feedback) * 100 : null
    };
  }

  function normalizePromptPayload(payload) {
    if (!payload || typeof payload !== 'object') {
      throw new Error('Prompt service returned an unreadable response.');
    }
    if (payload.status === 'error' || payload.ok === false) {
      throw new Error(payload.message || payload.error || 'Prompt service reported an error.');
    }
    if (!payload.data || typeof payload.data !== 'object' || Array.isArray(payload.data)) {
      throw new Error('Prompt service returned an invalid library.');
    }

    return Object.keys(payload.data).reduce(function (groups, groupName) {
      var versions = payload.data[groupName];
      if (!Array.isArray(versions) || versions.length === 0) return groups;

      var normalizedVersions = versions
        .filter(function (prompt) { return prompt && typeof prompt === 'object'; })
        .map(function (prompt) {
          return Object.assign({}, prompt, {
            name: String(prompt.name || groupName),
            version: Math.max(1, finiteNumber(prompt.version, 1)),
            isActive: prompt.isActive === true,
            trafficWeight: Math.min(100, Math.max(0, finiteNumber(prompt.trafficWeight, 100)))
          });
        })
        .sort(function (left, right) { return right.version - left.version; });

      if (normalizedVersions.length > 0) {
        groups.push({ name: String(groupName), versions: normalizedVersions });
      }
      return groups;
    }, []);
  }

  function aggregateGroup(group) {
    var summary = {
      activeVersions: 0,
      impressions: 0,
      positive: 0,
      negative: 0,
      positiveRate: null,
      latestVersion: 0
    };

    group.versions.forEach(function (prompt) {
      var stats = promptStats(prompt);
      if (prompt.isActive) summary.activeVersions += 1;
      summary.impressions += stats.impressions;
      summary.positive += stats.positive;
      summary.negative += stats.negative;
      summary.latestVersion = Math.max(summary.latestVersion, finiteNumber(prompt.version, 0));
    });

    var feedback = summary.positive + summary.negative;
    summary.positiveRate = feedback > 0 ? (summary.positive / feedback) * 100 : null;
    return summary;
  }

  function summarizePromptGroups(groups) {
    var summary = {
      promptAssets: groups.length,
      activeTests: 0,
      impressions: 0,
      positive: 0,
      negative: 0,
      positiveRate: null
    };

    groups.forEach(function (group) {
      var groupSummary = aggregateGroup(group);
      if (groupSummary.activeVersions > 1) summary.activeTests += 1;
      summary.impressions += groupSummary.impressions;
      summary.positive += groupSummary.positive;
      summary.negative += groupSummary.negative;
    });

    var feedback = summary.positive + summary.negative;
    summary.positiveRate = feedback > 0 ? (summary.positive / feedback) * 100 : null;
    return summary;
  }

  function filterAndSortPromptGroups(groups, filters) {
    filters = filters || {};
    var query = String(filters.query || '').trim().toLowerCase();
    var status = String(filters.status || 'all');
    var sortBy = String(filters.sortBy || 'name');

    var filtered = groups.filter(function (group) {
      var groupSummary = aggregateGroup(group);
      if (status === 'active' && groupSummary.activeVersions === 0) return false;
      if (status === 'inactive' && groupSummary.activeVersions > 0) return false;
      if (!query) return true;

      return group.versions.some(function (prompt) {
        return [group.name, prompt.name, prompt.description, prompt.systemPrompt]
          .some(function (value) { return String(value || '').toLowerCase().includes(query); });
      });
    });

    return filtered.slice().sort(function (left, right) {
      var leftSummary = aggregateGroup(left);
      var rightSummary = aggregateGroup(right);
      if (sortBy === 'version') {
        return rightSummary.latestVersion - leftSummary.latestVersion
          || left.name.localeCompare(right.name);
      }
      if (sortBy === 'impressions') {
        return rightSummary.impressions - leftSummary.impressions
          || left.name.localeCompare(right.name);
      }
      if (sortBy === 'positiveRate') {
        var leftRate = leftSummary.positiveRate == null ? -1 : leftSummary.positiveRate;
        var rightRate = rightSummary.positiveRate == null ? -1 : rightSummary.positiveRate;
        return rightRate - leftRate || left.name.localeCompare(right.name);
      }
      return left.name.localeCompare(right.name);
    });
  }

  function formatCount(value) {
    return Math.round(nonNegativeNumber(value)).toLocaleString('en-US');
  }

  function formatRate(value) {
    return Number.isFinite(value) ? Math.round(value) + '%' : '—';
  }

  function buildPromptRunHref(name, version) {
    var params = new URLSearchParams();
    params.set('persona', String(name || 'default_chat'));
    params.set('promptVersion', String(Math.max(1, finiteNumber(version, 1))));
    return '/playground?' + params.toString();
  }

  function promptCanRun(prompt) {
    return Boolean(prompt && (!prompt.disposition || prompt.disposition.selectable !== false));
  }

  function friendlyLoadError(error) {
    var message = String(error && error.message || '');
    if (/timed out/i.test(message)) {
      return 'The prompt service did not respond in time. Check Core and MongoDB, then retry.';
    }
    return 'Agent X could not read prompt evidence. Check Core and MongoDB, then retry.';
  }

  function renderVersion(groupName, prompt) {
    var stats = promptStats(prompt);
    var status = prompt.isActive ? 'active' : 'inactive';
    var statusLabel = prompt.isActive ? 'Active' : 'Inactive';
    var version = finiteNumber(prompt.version, 1);

    return [
      '<li class="version-item ' + status + '">',
      '  <div class="version-info">',
      '    <span class="version-number">v' + escapeHtml(version) + '</span>',
      '    <span class="status-badge ' + status + '">' + statusLabel + '</span>',
      '    <span class="traffic-weight">' + escapeHtml(prompt.trafficWeight) + '% traffic</span>',
      '  </div>',
      '  <div class="version-stats" aria-label="Version ' + escapeHtml(version) + ' evidence">',
      '    <span class="stat"><i class="fas fa-eye" aria-hidden="true"></i>' + formatCount(stats.impressions) + '</span>',
      '    <span class="stat ' + (stats.positiveRate == null ? 'neutral' : 'positive') + '"><i class="fas fa-thumbs-up" aria-hidden="true"></i>' + formatRate(stats.positiveRate) + '</span>',
      '  </div>',
      '  <div class="version-actions">',
      promptCanRun(prompt)
        ? '    <a class="icon-btn prompt-version-run" href="' + escapeHtml(buildPromptRunHref(groupName, version)) + '" aria-label="Try ' + escapeHtml(groupName) + ' version ' + escapeHtml(version) + ' in Chat" title="Try this exact version in Chat"><i class="fas fa-play" aria-hidden="true"></i><span class="sr-only">Try exact version</span></a>'
        : '',
      '    <button class="icon-btn" type="button" data-action="new-version" data-prompt-name="' + escapeHtml(groupName) + '" data-prompt-version="' + escapeHtml(version) + '" aria-label="Create a new version of ' + escapeHtml(groupName) + ' from version ' + escapeHtml(version) + '" title="Use this version as a starting point">',
      '      <i class="fas fa-code-branch" aria-hidden="true"></i><span class="sr-only">Use as base</span>',
      '    </button>',
      '  </div>',
      '</li>'
    ].join('');
  }

  function renderPromptCards(groups) {
    if (!groups.length) {
      return [
        '<div class="prompt-filter-empty" role="status">',
        '  <h2>No matching prompt assets</h2>',
        '  <p>Try a broader search or status filter. The library itself is still available.</p>',
        '</div>'
      ].join('');
    }

    var cards = groups.map(function (group) {
      var summary = aggregateGroup(group);
      var activeRepresentative = group.versions.find(function (prompt) {
        return prompt.isActive && promptCanRun(prompt);
      });
      var representative = activeRepresentative || group.versions[0];
      var description = String(representative.description || 'No description recorded.');
      var activeLabel = summary.activeVersions > 0 ? summary.activeVersions + ' active' : 'Inactive';
      var activeClass = summary.activeVersions > 0 ? 'active' : 'total';

      return [
        '<article class="prompt-card">',
        '  <div class="prompt-card-header">',
        '    <h2 class="prompt-name">' + escapeHtml(group.name) + '</h2>',
        '    <div class="prompt-badge-group">',
        '      <span class="badge ' + activeClass + '">' + escapeHtml(activeLabel) + '</span>',
        '      <span class="badge total">' + group.versions.length + ' version' + (group.versions.length === 1 ? '' : 's') + '</span>',
        '    </div>',
        '  </div>',
        '  <p class="prompt-description">' + escapeHtml(description) + '</p>',
        '  <ul class="versions-list" aria-label="Versions of ' + escapeHtml(group.name) + '">',
        group.versions.map(function (prompt) { return renderVersion(group.name, prompt); }).join(''),
        '  </ul>',
        '  <div class="prompt-card-actions">',
        activeRepresentative
          ? '    <a class="btn-secondary prompt-run-link" href="' + escapeHtml(buildPromptRunHref(group.name, activeRepresentative.version)) + '"><i class="fas fa-play" aria-hidden="true"></i> Try active v' + escapeHtml(activeRepresentative.version) + ' in Chat</a>'
          : '',
        '    <button class="btn-secondary" type="button" data-action="new-version" data-prompt-name="' + escapeHtml(group.name) + '" data-prompt-version="' + escapeHtml(group.versions[0].version) + '">',
        '      <i class="fas fa-plus" aria-hidden="true"></i> Create from latest',
        '    </button>',
        '  </div>',
        '</article>'
      ].join('');
    });

    return '<div class="prompt-cards-grid">' + cards.join('') + '</div>';
  }

  function requestJson(fetchImpl, url, options, timeoutMs, runtime) {
    if (typeof fetchImpl !== 'function') {
      return Promise.reject(new Error('Browser fetch support is unavailable.'));
    }

    runtime = runtime || {};
    var schedule = runtime.setTimeout || setTimeout;
    var cancel = runtime.clearTimeout || clearTimeout;
    var AbortControllerImpl = runtime.AbortController
      || (typeof AbortController !== 'undefined' ? AbortController : null);
    var controller = AbortControllerImpl ? new AbortControllerImpl() : null;
    var requestOptions = Object.assign({ credentials: 'include' }, options || {});
    if (controller) requestOptions.signal = controller.signal;
    var duration = Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : DEFAULT_TIMEOUT_MS;
    var timer;

    var timeout = new Promise(function (_, reject) {
      timer = schedule(function () {
        if (controller) controller.abort();
        reject(new Error('Prompt service timed out. Try again.'));
      }, duration);
    });

    var request = Promise.resolve()
      .then(function () { return fetchImpl(url, requestOptions); })
      .then(function (response) {
        if (!response || typeof response.json !== 'function') {
          throw new Error('Prompt service returned an unreadable response.');
        }
        return Promise.resolve(response.json()).then(function (payload) {
          if (!response.ok) {
            throw new Error(
              (payload && (payload.message || payload.error))
              || ('Prompt request failed with status ' + response.status + '.')
            );
          }
          return payload;
        });
      });

    return Promise.race([request, timeout]).finally(function () {
      if (timer !== undefined) cancel(timer);
    });
  }

  function createPromptPage(options) {
    options = options || {};
    var documentRef = options.document;
    var windowRef = options.window || (typeof window !== 'undefined' ? window : null);
    var fetchImpl = options.fetch || (windowRef && windowRef.fetch && windowRef.fetch.bind(windowRef));
    var timeoutMs = options.timeoutMs || DEFAULT_TIMEOUT_MS;
    var groups = [];
    var loadRevision = 0;
    var previousFocus = null;
    var modalBackgroundState = [];
    var initialized = false;
    var elements = {};

    function byId(id) {
      return documentRef && documentRef.getElementById(id);
    }

    function collectElements() {
      [
        'promptEvidenceStatus', 'exportPromptsBtn', 'createPromptBtn', 'totalPrompts',
        'activeTests', 'avgPositiveRate', 'totalImpressions', 'searchInput',
        'statusFilter', 'sortBy', 'promptListContainer', 'emptyState',
        'emptyCreateBtn', 'loadingState', 'errorState', 'errorStateMessage',
        'retryPromptsBtn', 'promptEditorModal', 'promptEditorForm', 'promptEditorTitle',
        'promptEditorContext', 'promptEditorCloseBtn', 'promptEditorCancelBtn',
        'promptEditorSaveBtn', 'promptEditorError', 'promptNameInput',
        'promptDescriptionInput', 'systemPromptInput', 'promptActiveInput',
        'promptTrafficWeightInput', 'editorCharacterCount', 'editorLineCount'
      ].forEach(function (id) { elements[id] = byId(id); });
    }

    function setHidden(element, hidden) {
      if (element) element.hidden = hidden;
    }

    function setLoadState(phase, message) {
      setHidden(elements.loadingState, phase !== 'loading');
      setHidden(elements.emptyState, phase !== 'empty');
      setHidden(elements.errorState, phase !== 'error');
      setHidden(elements.promptListContainer, phase !== 'ready');

      if (elements.errorStateMessage && message) elements.errorStateMessage.textContent = message;
      if (elements.searchInput) elements.searchInput.disabled = phase === 'loading' || phase === 'error';
      if (elements.statusFilter) elements.statusFilter.disabled = phase === 'loading' || phase === 'error';
      if (elements.sortBy) elements.sortBy.disabled = phase === 'loading' || phase === 'error';
      var canMutate = phase === 'ready' || phase === 'empty';
      if (elements.createPromptBtn) elements.createPromptBtn.disabled = !canMutate;
      if (elements.emptyCreateBtn) elements.emptyCreateBtn.disabled = !canMutate;
      if (elements.exportPromptsBtn) elements.exportPromptsBtn.disabled = phase !== 'ready' || groups.length === 0;
    }

    function updateSummary() {
      var summary = summarizePromptGroups(groups);
      if (elements.totalPrompts) elements.totalPrompts.textContent = formatCount(summary.promptAssets);
      if (elements.activeTests) elements.activeTests.textContent = formatCount(summary.activeTests);
      if (elements.avgPositiveRate) elements.avgPositiveRate.textContent = formatRate(summary.positiveRate);
      if (elements.totalImpressions) elements.totalImpressions.textContent = formatCount(summary.impressions);
    }

    function resetSummary() {
      ['totalPrompts', 'activeTests', 'avgPositiveRate', 'totalImpressions'].forEach(function (key) {
        if (elements[key]) elements[key].textContent = '—';
      });
    }

    function currentFilters() {
      return {
        query: elements.searchInput ? elements.searchInput.value : '',
        status: elements.statusFilter ? elements.statusFilter.value : 'all',
        sortBy: elements.sortBy ? elements.sortBy.value : 'name'
      };
    }

    function renderList() {
      if (!elements.promptListContainer) return;
      var visibleGroups = filterAndSortPromptGroups(groups, currentFilters());
      elements.promptListContainer.innerHTML = renderPromptCards(visibleGroups);
    }

    function evidenceText(prefix) {
      var now = new Date();
      var observed = typeof now.toLocaleTimeString === 'function'
        ? now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
        : now.toISOString();
      return prefix + ' Source: /api/prompts · observed ' + observed + '.';
    }

    function loadPrompts() {
      var revision = ++loadRevision;
      setLoadState('loading');
      resetSummary();
      if (elements.promptEvidenceStatus) {
        elements.promptEvidenceStatus.textContent = 'Loading current evidence from /api/prompts…';
      }

      return requestJson(fetchImpl, '/api/prompts', { headers: { Accept: 'application/json' } }, timeoutMs)
        .then(function (payload) {
          if (revision !== loadRevision) return groups;
          groups = normalizePromptPayload(payload);
          updateSummary();
          if (elements.promptEvidenceStatus) {
            elements.promptEvidenceStatus.textContent = evidenceText(
              groups.length === 0 ? 'Library is reachable but empty.' : 'Prompt evidence loaded.'
            );
          }

          if (groups.length === 0) {
            setLoadState('empty');
          } else {
            renderList();
            setLoadState('ready');
          }
          return groups;
        })
        .catch(function (error) {
          if (revision !== loadRevision) return groups;
          groups = [];
          resetSummary();
          if (elements.promptEvidenceStatus) {
            elements.promptEvidenceStatus.textContent = 'Prompt evidence unavailable. Source: /api/prompts.';
          }
          setLoadState('error', friendlyLoadError(error));
          return [];
        });
    }

    function findVersion(name, version) {
      var group = groups.find(function (candidate) { return candidate.name === name; });
      if (!group) return null;
      return group.versions.find(function (prompt) {
        return finiteNumber(prompt.version, 1) === finiteNumber(version, -1);
      }) || null;
    }

    function nextVersionFor(name) {
      var group = groups.find(function (candidate) { return candidate.name === name; });
      if (!group) return 1;
      return aggregateGroup(group).latestVersion + 1;
    }

    function updateEditorStats() {
      if (!elements.systemPromptInput) return;
      var text = elements.systemPromptInput.value || '';
      var lines = text ? text.split(/\r?\n/).length : 1;
      if (elements.editorCharacterCount) {
        elements.editorCharacterCount.textContent = text.length + ' character' + (text.length === 1 ? '' : 's');
      }
      if (elements.editorLineCount) {
        elements.editorLineCount.textContent = lines + ' line' + (lines === 1 ? '' : 's');
      }
    }

    function setEditorError(message) {
      if (!elements.promptEditorError) return;
      elements.promptEditorError.textContent = message || '';
      elements.promptEditorError.hidden = !message;
    }

    function isolateModalBackground() {
      modalBackgroundState = [];
      if (!documentRef.body || !documentRef.body.children || !elements.promptEditorModal) return;
      Array.prototype.slice.call(documentRef.body.children).forEach(function (child) {
        if (child === elements.promptEditorModal || child.tagName === 'SCRIPT' || child.tagName === 'STYLE') return;
        modalBackgroundState.push({
          element: child,
          inert: Boolean(child.inert),
          hadAriaHidden: typeof child.hasAttribute === 'function' && child.hasAttribute('aria-hidden'),
          ariaHidden: typeof child.getAttribute === 'function' ? child.getAttribute('aria-hidden') : null
        });
        child.inert = true;
        if (typeof child.setAttribute === 'function') child.setAttribute('aria-hidden', 'true');
      });
    }

    function restoreModalBackground() {
      modalBackgroundState.forEach(function (entry) {
        entry.element.inert = entry.inert;
        if (typeof entry.element.removeAttribute !== 'function') return;
        if (entry.hadAriaHidden) entry.element.setAttribute('aria-hidden', entry.ariaHidden);
        else entry.element.removeAttribute('aria-hidden');
      });
      modalBackgroundState = [];
    }

    function focusableEditorControls() {
      if (!elements.promptEditorModal || typeof elements.promptEditorModal.querySelectorAll !== 'function') return [];
      return Array.prototype.slice.call(elements.promptEditorModal.querySelectorAll(
        'a[href], button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])'
      )).filter(function (control) {
        return !control.hidden && control.getAttribute && control.getAttribute('aria-hidden') !== 'true';
      });
    }

    function openEditor(basePrompt) {
      if (!elements.promptEditorModal || !elements.promptEditorForm) return;
      previousFocus = documentRef.activeElement;
      elements.promptEditorForm.reset();
      setEditorError('');

      if (basePrompt) {
        var name = String(basePrompt.name || '');
        var nextVersion = nextVersionFor(name);
        elements.promptEditorTitle.textContent = 'Create ' + name + ' v' + nextVersion;
        elements.promptEditorContext.textContent = 'Based on v' + basePrompt.version + '. The saved copy starts inactive so runtime selection does not change silently.';
        elements.promptNameInput.value = name;
        elements.promptNameInput.readOnly = true;
        elements.promptDescriptionInput.value = String(basePrompt.description || '');
        elements.systemPromptInput.value = String(basePrompt.systemPrompt || '');
        elements.promptTrafficWeightInput.value = String(basePrompt.trafficWeight == null ? 100 : basePrompt.trafficWeight);
        elements.promptActiveInput.checked = false;
      } else {
        elements.promptEditorTitle.textContent = 'Create prompt';
        elements.promptEditorContext.textContent = 'Create version 1. It starts inactive unless you choose otherwise.';
        elements.promptNameInput.readOnly = false;
        elements.promptNameInput.value = '';
        elements.promptDescriptionInput.value = '';
        elements.systemPromptInput.value = '';
        elements.promptTrafficWeightInput.value = '100';
        elements.promptActiveInput.checked = false;
      }

      updateEditorStats();
      elements.promptEditorModal.hidden = false;
      isolateModalBackground();
      if (documentRef.body && documentRef.body.classList) documentRef.body.classList.add('modal-open');
      var focusTarget = basePrompt ? elements.systemPromptInput : elements.promptNameInput;
      if (focusTarget && typeof focusTarget.focus === 'function') focusTarget.focus();
      else if (typeof elements.promptEditorModal.focus === 'function') elements.promptEditorModal.focus();
    }

    function closeEditor() {
      if (!elements.promptEditorModal) return;
      elements.promptEditorModal.hidden = true;
      setEditorError('');
      if (documentRef.body && documentRef.body.classList) documentRef.body.classList.remove('modal-open');
      restoreModalBackground();
      if (previousFocus && typeof previousFocus.focus === 'function') previousFocus.focus();
      previousFocus = null;
    }

    function notify(message, type) {
      if (windowRef && windowRef.AgentXUtils && typeof windowRef.AgentXUtils.showToast === 'function') {
        windowRef.AgentXUtils.showToast(message, type);
      }
    }

    function savePrompt(event) {
      if (event && typeof event.preventDefault === 'function') event.preventDefault();
      var name = String(elements.promptNameInput.value || '').trim();
      var systemPrompt = String(elements.systemPromptInput.value || '');
      var trafficWeight = Number(elements.promptTrafficWeightInput.value);

      if (!name) {
        setEditorError('Prompt name is required.');
        elements.promptNameInput.focus();
        return Promise.resolve(false);
      }
      if (!systemPrompt.trim()) {
        setEditorError('System prompt text is required.');
        elements.systemPromptInput.focus();
        return Promise.resolve(false);
      }
      if (!Number.isFinite(trafficWeight) || trafficWeight < 0 || trafficWeight > 100) {
        setEditorError('Traffic weight must be a number from 0 to 100.');
        elements.promptTrafficWeightInput.focus();
        return Promise.resolve(false);
      }

      var saveButton = elements.promptEditorSaveBtn;
      var saveLabel = saveButton && saveButton.querySelector('span');
      if (saveButton) saveButton.disabled = true;
      if (saveLabel) saveLabel.textContent = 'Saving…';
      setEditorError('');

      return requestJson(fetchImpl, '/api/prompts', {
        method: 'POST',
        headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: name,
          systemPrompt: systemPrompt,
          description: String(elements.promptDescriptionInput.value || '').trim(),
          isActive: elements.promptActiveInput.checked === true,
          trafficWeight: trafficWeight
        })
      }, timeoutMs)
        .then(function (payload) {
          if (!payload || payload.status === 'error' || payload.ok === false) {
            throw new Error((payload && (payload.message || payload.error)) || 'Prompt could not be saved.');
          }
          closeEditor();
          notify('Saved ' + name + ' as a new version. Use Try in Chat to exercise an exact version.', 'success');
          return loadPrompts().then(function () { return true; });
        })
        .catch(function (error) {
          setEditorError(error && error.message ? error.message : 'Prompt could not be saved.');
          return false;
        })
        .finally(function () {
          if (saveButton) saveButton.disabled = false;
          if (saveLabel) saveLabel.textContent = 'Save new version';
        });
    }

    function exportPrompts() {
      if (!groups.length || !windowRef || !windowRef.Blob || !windowRef.URL) return;
      var grouped = {};
      groups.forEach(function (group) { grouped[group.name] = group.versions; });
      var blob = new windowRef.Blob([JSON.stringify({ status: 'success', data: grouped }, null, 2)], {
        type: 'application/json'
      });
      var url = windowRef.URL.createObjectURL(blob);
      var anchor = documentRef.createElement('a');
      anchor.href = url;
      anchor.download = 'agentx-prompts-' + new Date().toISOString().slice(0, 10) + '.json';
      documentRef.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      windowRef.URL.revokeObjectURL(url);
      notify('Prompt evidence exported.', 'success');
    }

    function bindEvents() {
      if (elements.searchInput) elements.searchInput.addEventListener('input', renderList);
      if (elements.statusFilter) elements.statusFilter.addEventListener('change', renderList);
      if (elements.sortBy) elements.sortBy.addEventListener('change', renderList);
      if (elements.retryPromptsBtn) elements.retryPromptsBtn.addEventListener('click', loadPrompts);
      if (elements.createPromptBtn) elements.createPromptBtn.addEventListener('click', function () { openEditor(null); });
      if (elements.emptyCreateBtn) elements.emptyCreateBtn.addEventListener('click', function () { openEditor(null); });
      if (elements.exportPromptsBtn) elements.exportPromptsBtn.addEventListener('click', exportPrompts);
      if (elements.promptEditorCloseBtn) elements.promptEditorCloseBtn.addEventListener('click', closeEditor);
      if (elements.promptEditorCancelBtn) elements.promptEditorCancelBtn.addEventListener('click', closeEditor);
      if (elements.promptEditorForm) elements.promptEditorForm.addEventListener('submit', savePrompt);
      if (elements.systemPromptInput) elements.systemPromptInput.addEventListener('input', updateEditorStats);
      if (elements.promptEditorModal) {
        elements.promptEditorModal.addEventListener('click', function (event) {
          if (event.target === elements.promptEditorModal) closeEditor();
        });
      }
      if (elements.promptListContainer) {
        elements.promptListContainer.addEventListener('click', function (event) {
          var action = event.target && event.target.closest
            ? event.target.closest('[data-action="new-version"]')
            : null;
          if (!action) return;
          var prompt = findVersion(action.dataset.promptName, action.dataset.promptVersion);
          if (prompt) openEditor(prompt);
        });
      }
      documentRef.addEventListener('keydown', function (event) {
        if (!elements.promptEditorModal || elements.promptEditorModal.hidden) return;
        if (event.key === 'Escape') {
          if (typeof event.preventDefault === 'function') event.preventDefault();
          closeEditor();
          return;
        }
        if (event.key === 'Tab') {
          var controls = focusableEditorControls();
          if (controls.length === 0) {
            if (typeof event.preventDefault === 'function') event.preventDefault();
            if (typeof elements.promptEditorModal.focus === 'function') elements.promptEditorModal.focus();
            return;
          }
          var first = controls[0];
          var last = controls[controls.length - 1];
          if (event.shiftKey && (documentRef.activeElement === first || !controls.includes(documentRef.activeElement))) {
            if (typeof event.preventDefault === 'function') event.preventDefault();
            if (typeof last.focus === 'function') last.focus();
          } else if (!event.shiftKey && (documentRef.activeElement === last || !controls.includes(documentRef.activeElement))) {
            if (typeof event.preventDefault === 'function') event.preventDefault();
            if (typeof first.focus === 'function') first.focus();
          }
        }
      });
    }

    function init() {
      if (initialized || !documentRef) return Promise.resolve([]);
      initialized = true;
      collectElements();
      if (!elements.promptListContainer || !elements.loadingState || !elements.errorState) {
        return Promise.resolve([]);
      }
      bindEvents();
      return loadPrompts();
    }

    return {
      init: init,
      load: loadPrompts,
      openEditor: openEditor,
      closeEditor: closeEditor,
      getGroups: function () { return groups.slice(); }
    };
  }

  return {
    DEFAULT_TIMEOUT_MS: DEFAULT_TIMEOUT_MS,
    escapeHtml: escapeHtml,
    promptStats: promptStats,
    normalizePromptPayload: normalizePromptPayload,
    aggregateGroup: aggregateGroup,
    summarizePromptGroups: summarizePromptGroups,
    filterAndSortPromptGroups: filterAndSortPromptGroups,
    buildPromptRunHref: buildPromptRunHref,
    renderPromptCards: renderPromptCards,
    friendlyLoadError: friendlyLoadError,
    requestJson: requestJson,
    createPromptPage: createPromptPage
  };
});
