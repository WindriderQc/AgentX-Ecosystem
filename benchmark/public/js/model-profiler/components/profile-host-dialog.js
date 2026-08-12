// public/js/model-profiler/components/profile-host-dialog.js
/**
 * Profile-host options dialog.
 * One modal that gathers depth + skip-recent-days for the "Profile All on Host" flow.
 * Replaces two back-to-back native prompt() calls so users can click instead of type.
 */

import { createModal } from '../../components/modal.js';

const DEPTH_OPTIONS = [
  { value: 'quick',    label: 'Quick',    eta: '≈5 min/model'  },
  { value: 'standard', label: 'Standard', eta: '≈20 min/model' },
  { value: 'full',     label: 'Full',     eta: '≈45 min/model' }
];

/**
 * Open the dialog and resolve with { depth, skipRecentDays } or null on cancel.
 * @param {object} opts
 * @param {string} opts.hostName  Display name shown in the title
 * @param {boolean} opts.showSkipRecent  Whether to render the skip-recent-days input
 * @param {number} opts.modelCount  Number of models that will be profiled (for display)
 * @param {'quick'|'standard'|'full'} opts.defaultDepth  Initially selected depth
 * @returns {Promise<{depth: 'quick'|'standard'|'full', skipRecentDays: number} | null>}
 */
export function openProfileHostDialog({ hostName = 'host', showSkipRecent = true, modelCount = 0, defaultDepth = 'standard' } = {}) {
  return new Promise((resolve) => {
    const { overlay, content, close } = createModal();
    content.classList.add('mp-host-dlg');
    const initialDepth = DEPTH_OPTIONS.some(opt => opt.value === defaultDepth) ? defaultDepth : 'standard';

    const subline = modelCount > 0
      ? `${modelCount} model${modelCount === 1 ? '' : 's'} selected`
      : 'All profilable models on this host';

    content.insertAdjacentHTML('beforeend', `
      <div class="mp-host-dlg-header">
        <h3>Profile models on <span class="mp-host-dlg-host">${escapeHtml(hostName)}</span></h3>
        <div class="mp-host-dlg-sub">${escapeHtml(subline)}</div>
      </div>

      <div class="mp-host-dlg-section">
        <div class="mp-host-dlg-label">Profile depth</div>
        <div class="mp-host-dlg-depth" role="radiogroup" aria-label="Profile depth">
          ${DEPTH_OPTIONS.map((opt) => `
            <button type="button"
                    class="mp-host-dlg-depth-btn${opt.value === initialDepth ? ' is-active' : ''}"
                    role="radio"
                    aria-checked="${opt.value === initialDepth ? 'true' : 'false'}"
                    data-depth="${opt.value}">
              <span class="mp-host-dlg-depth-label">${opt.label}</span>
              <span class="mp-host-dlg-depth-eta">${opt.eta}</span>
            </button>
          `).join('')}
        </div>
      </div>

      ${showSkipRecent ? `
        <div class="mp-host-dlg-section">
          <label class="mp-host-dlg-label" for="mp-host-dlg-skip">Skip models profiled within</label>
          <div class="mp-host-dlg-skip-row">
            <input id="mp-host-dlg-skip" type="number" min="0" step="1" value="7" class="mp-host-dlg-input">
            <span class="mp-host-dlg-skip-suffix">days <em>(0 = profile all)</em></span>
          </div>
        </div>
      ` : ''}

      <div class="mp-host-dlg-footer">
        <button type="button" class="mp-host-dlg-cancel">Cancel</button>
        <button type="button" class="mp-host-dlg-start">Start profiling</button>
      </div>
    `);

    injectStyles();

    let depth = initialDepth;
    const depthBtns = content.querySelectorAll('.mp-host-dlg-depth-btn');
    depthBtns.forEach((btn) => {
      btn.addEventListener('click', () => {
        depthBtns.forEach((b) => {
          b.classList.remove('is-active');
          b.setAttribute('aria-checked', 'false');
        });
        btn.classList.add('is-active');
        btn.setAttribute('aria-checked', 'true');
        depth = btn.dataset.depth;
      });
    });

    const skipInput = content.querySelector('#mp-host-dlg-skip');
    let resolved = false;
    const finish = (value) => {
      if (resolved) return;
      resolved = true;
      close();
      resolve(value);
    };

    content.querySelector('.mp-host-dlg-cancel').addEventListener('click', () => finish(null));
    content.querySelector('.mp-host-dlg-start').addEventListener('click', () => {
      let skipRecentDays = 0;
      if (showSkipRecent && skipInput) {
        const parsed = parseInt(skipInput.value, 10);
        if (!Number.isFinite(parsed) || parsed < 0) {
          skipInput.focus();
          skipInput.classList.add('mp-host-dlg-input-error');
          return;
        }
        skipRecentDays = parsed;
      }
      finish({ depth, skipRecentDays });
    });

    // Resolve null when overlay closed via backdrop / ESC / × button
    const observer = new MutationObserver(() => {
      if (overlay.style.display === 'none' && !resolved) {
        resolved = true;
        observer.disconnect();
        resolve(null);
      }
    });
    observer.observe(overlay, { attributes: true, attributeFilter: ['style'] });

    // Enter on skip input = start
    if (skipInput) {
      skipInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') content.querySelector('.mp-host-dlg-start').click();
      });
    }
  });
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}

let _stylesInjected = false;
function injectStyles() {
  if (_stylesInjected) return;
  _stylesInjected = true;
  const style = document.createElement('style');
  style.id = 'mp-host-dlg-styles';
  style.textContent = `
    .mp-host-dlg { max-width: 520px; }
    .mp-host-dlg-header { margin-bottom: 1.25rem; padding-right: 2rem; }
    .mp-host-dlg-header h3 { margin: 0 0 4px; font-size: 1.05rem; font-weight: 600; }
    .mp-host-dlg-host { color: var(--accent, #7cf0ff); }
    .mp-host-dlg-sub { font-size: 12px; color: var(--r-text-dim, #94a3b8); }

    .mp-host-dlg-section { margin-bottom: 1.1rem; }
    .mp-host-dlg-label {
      display: block; font-size: 11px; font-weight: 600;
      text-transform: uppercase; letter-spacing: 0.5px;
      color: var(--r-text-dim, #94a3b8); margin-bottom: 8px;
    }

    .mp-host-dlg-depth { display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px; }
    .mp-host-dlg-depth-btn {
      display: flex; flex-direction: column; align-items: center; justify-content: center;
      gap: 4px; padding: 12px 8px;
      background: rgba(255, 255, 255, 0.03);
      border: 1px solid rgba(255, 255, 255, 0.1);
      border-radius: 8px; cursor: pointer;
      color: var(--r-text, #e0e0e0); transition: all 0.15s;
    }
    .mp-host-dlg-depth-btn:hover { background: rgba(255, 255, 255, 0.06); border-color: rgba(255, 255, 255, 0.2); }
    .mp-host-dlg-depth-btn.is-active {
      background: rgba(124, 240, 255, 0.12);
      border-color: var(--accent, #7cf0ff);
      color: var(--accent, #7cf0ff);
    }
    .mp-host-dlg-depth-label { font-size: 14px; font-weight: 600; }
    .mp-host-dlg-depth-eta { font-size: 11px; color: var(--r-text-dim, #94a3b8); }
    .mp-host-dlg-depth-btn.is-active .mp-host-dlg-depth-eta { color: var(--accent, #7cf0ff); opacity: 0.8; }

    .mp-host-dlg-skip-row { display: flex; align-items: center; gap: 10px; }
    .mp-host-dlg-input {
      width: 80px; padding: 6px 10px; font-size: 14px;
      background: rgba(255, 255, 255, 0.04);
      border: 1px solid rgba(255, 255, 255, 0.15);
      border-radius: 6px; color: var(--r-text, #e0e0e0);
    }
    .mp-host-dlg-input:focus { outline: none; border-color: var(--accent, #7cf0ff); }
    .mp-host-dlg-input-error { border-color: var(--r-error, #ef5350); }
    .mp-host-dlg-skip-suffix { font-size: 13px; color: var(--r-text-dim, #94a3b8); }
    .mp-host-dlg-skip-suffix em { font-style: normal; opacity: 0.75; }

    .mp-host-dlg-footer { display: flex; justify-content: flex-end; gap: 8px; margin-top: 1.25rem; }
    .mp-host-dlg-cancel, .mp-host-dlg-start {
      padding: 8px 16px; font-size: 13px; font-weight: 500;
      border-radius: 6px; cursor: pointer; transition: all 0.15s;
      border: 1px solid transparent;
    }
    .mp-host-dlg-cancel {
      background: transparent; color: var(--r-text-dim, #94a3b8);
      border-color: rgba(255, 255, 255, 0.15);
    }
    .mp-host-dlg-cancel:hover { color: var(--r-text, #e0e0e0); border-color: rgba(255, 255, 255, 0.3); }
    .mp-host-dlg-start {
      background: var(--accent, #7cf0ff); color: #0d0d1a; font-weight: 600;
    }
    .mp-host-dlg-start:hover { filter: brightness(1.1); }
  `;
  document.head.appendChild(style);
}
