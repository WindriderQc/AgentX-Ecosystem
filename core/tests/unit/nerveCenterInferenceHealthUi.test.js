'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const source = fs.readFileSync(
  path.join(__dirname, '../../public/js/nerve-center-inference-health.js'),
  'utf8'
);

function loadUi() {
  const context = {
    console: { warn: jest.fn(), error: jest.fn(), log: jest.fn() },
    document: { getElementById: jest.fn() },
    setInterval: jest.fn(),
    window: {
      NerveCenterShared: {
        escapeHtml: value => String(value),
        fetchJson: jest.fn(),
        setSectionBusy: jest.fn(),
        finishSectionLoad: jest.fn(),
        renderSectionError: jest.fn()
      }
    }
  };
  vm.runInNewContext(source, context, { filename: 'nerve-center-inference-health.js' });
  return context.window.NerveCenterInferenceHealth;
}

describe('Nerve Center judge drift evidence honesty', () => {
  const neutral = '#94a3b8';
  const healthy = '#4ade80';

  test.each([
    [undefined, 'unknown'],
    ['unknown', 'unknown'],
    ['insufficient_data', 'insufficient'],
    ['no_baseline', 'no baseline'],
    ['skipped', 'skipped'],
    ['failed', 'failed']
  ])('renders %s as neutral rather than healthy', (overallStatus, label) => {
    const ui = loadUi();
    const html = ui.buildJudgeDriftPanel({ overall_status: overallStatus, categories: [] });

    expect(html).toContain(`color:${neutral}`);
    expect(html).toContain(`<strong>${label}</strong>`);
    expect(html).not.toContain(`color:${healthy};font-size:12px`);
  });

  test('uses green only for explicit ok evidence', () => {
    const ui = loadUi();
    const html = ui.buildJudgeDriftPanel({ overall_status: 'ok', categories: [] });

    expect(html).toContain(`color:${healthy};font-size:12px`);
    expect(html).toContain('<strong>OK</strong>');
  });

  test.each([
    [{}, 'unknown'],
    [{ overall_status: 'insufficient_data' }, 'insufficient_data'],
    [{ overall_status: 'no_baseline' }, 'no_baseline'],
    [{ unavailable: true }, 'unavailable']
  ])('keeps summary status %s neutral and explicit', (judgeDrift, label) => {
    const ui = loadUi();
    const html = ui.buildSummary({ judgeDrift });

    expect(html).toContain(`color:${neutral}`);
    expect(html).toContain(`judge ${label}`);
    expect(html).not.toContain(`color:${healthy}`);
  });
});
