/* global window, document, Element */

(() => {
  'use strict';

  const tooltip = document.createElement('div');
  tooltip.id = 'cockpitContextHelp';
  tooltip.className = 'cockpit-tooltip';
  tooltip.setAttribute('role', 'tooltip');
  tooltip.hidden = true;
  document.body.appendChild(tooltip);

  let activeTip = null;
  let lastGuideTrigger = null;

  function tipTarget(node) {
    return node instanceof Element ? node.closest('[data-cockpit-tip]') : null;
  }

  function positionTooltip(target) {
    const anchor = target.getBoundingClientRect();
    const box = tooltip.getBoundingClientRect();
    const margin = 10;
    let left = anchor.left + (anchor.width - box.width) / 2;
    left = Math.max(margin, Math.min(left, window.innerWidth - box.width - margin));
    let top = anchor.bottom + 9;
    if (top + box.height > window.innerHeight - margin) top = anchor.top - box.height - 9;
    tooltip.style.left = `${Math.round(left)}px`;
    tooltip.style.top = `${Math.max(margin, Math.round(top))}px`;
  }

  function showTip(target) {
    if (!target) return;
    activeTip = target;
    tooltip.replaceChildren();
    const title = target.dataset.cockpitTipTitle;
    if (title) {
      const heading = document.createElement('strong');
      heading.textContent = title;
      tooltip.appendChild(heading);
    }
    const body = document.createElement('span');
    body.textContent = target.dataset.cockpitTip;
    tooltip.appendChild(body);
    tooltip.hidden = false;
    target.setAttribute('aria-describedby', tooltip.id);
    window.requestAnimationFrame(() => {
      positionTooltip(target);
      tooltip.classList.add('visible');
    });
  }

  function hideTip(target = activeTip) {
    if (target) target.removeAttribute('aria-describedby');
    tooltip.classList.remove('visible');
    activeTip = null;
    window.setTimeout(() => {
      if (!activeTip) tooltip.hidden = true;
    }, 130);
  }

  function openGuide(trigger) {
    const dialog = document.getElementById(trigger.dataset.cockpitGuideOpen);
    if (!dialog) return;
    lastGuideTrigger = trigger;
    hideTip();
    if (typeof dialog.showModal === 'function') dialog.showModal();
    else dialog.setAttribute('open', '');
  }

  function closeGuide(dialog) {
    if (!dialog) return;
    if (typeof dialog.close === 'function') dialog.close();
    else dialog.removeAttribute('open');
  }

  document.addEventListener('pointerover', (event) => {
    const target = tipTarget(event.target);
    if (target && target !== activeTip) showTip(target);
  });
  document.addEventListener('pointerout', (event) => {
    const target = tipTarget(event.target);
    if (target && !target.contains(event.relatedTarget)) hideTip(target);
  });
  document.addEventListener('focusin', (event) => {
    const target = tipTarget(event.target);
    if (target) showTip(target);
  });
  document.addEventListener('focusout', (event) => {
    const target = tipTarget(event.target);
    if (target) hideTip(target);
  });
  document.addEventListener('click', (event) => {
    const guideTrigger = event.target.closest('[data-cockpit-guide-open]');
    if (guideTrigger) {
      openGuide(guideTrigger);
      return;
    }
    const guideClose = event.target.closest('[data-cockpit-guide-close]');
    if (guideClose) {
      closeGuide(guideClose.closest('dialog'));
      return;
    }
    const target = tipTarget(event.target);
    if (target && window.matchMedia('(hover: none)').matches) {
      event.preventDefault();
      if (activeTip === target) hideTip(target);
      else showTip(target);
    }
  });
  document.querySelectorAll('.cockpit-guide').forEach((dialog) => {
    dialog.addEventListener('click', (event) => {
      if (event.target === dialog) closeGuide(dialog);
    });
    dialog.addEventListener('close', () => {
      if (lastGuideTrigger) lastGuideTrigger.focus();
      lastGuideTrigger = null;
    });
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && activeTip) hideTip();
  });
  window.addEventListener('resize', () => hideTip());
  window.addEventListener('scroll', () => hideTip(), true);
})();
