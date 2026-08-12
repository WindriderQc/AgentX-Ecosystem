(function () {
  'use strict';

  var root = document.querySelector('.nc-container');
  var toggle = document.getElementById('ncDetailModeToggle');
  if (!root || !toggle) return;

  var storageKey = 'agentx.nerve-center.show-details';

  function setExpanded(expanded, persist) {
    root.classList.toggle('nc-show-details', expanded);
    toggle.setAttribute('aria-expanded', expanded ? 'true' : 'false');
    toggle.innerHTML = expanded
      ? '<i class="fas fa-compress-alt"></i> Show overview only'
      : '<i class="fas fa-sliders"></i> Show operator details';
    if (persist) {
      try { window.localStorage.setItem(storageKey, expanded ? '1' : '0'); } catch (_) { /* optional preference */ }
    }
  }

  function storedPreference() {
    try { return window.localStorage.getItem(storageKey) === '1'; } catch (_) { return false; }
  }

  function hashTargetsDetail() {
    if (!window.location.hash) return false;
    try {
      var target = document.querySelector(window.location.hash);
      return Boolean(target && target.classList.contains('nc-detail-only'));
    } catch (_) {
      return false;
    }
  }

  toggle.addEventListener('click', function () {
    setExpanded(!root.classList.contains('nc-show-details'), true);
  });

  // Summary widgets already navigate to sections. Reveal a detail-only target
  // before the existing scroll handler runs so the destination is visible.
  document.addEventListener('click', function (event) {
    var widget = event.target.closest && event.target.closest('[data-scroll]');
    if (!widget) return;
    var target = document.getElementById('section' + String(widget.dataset.scroll || '')
      .replace(/(^|-)([a-z])/g, function (_match, _separator, letter) { return letter.toUpperCase(); }));
    if (target && target.classList.contains('nc-detail-only')) setExpanded(true, true);
  }, true);

  setExpanded(storedPreference() || hashTargetsDetail(), false);
}());
