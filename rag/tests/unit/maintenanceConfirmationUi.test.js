const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..', '..');
const read = (...segments) => fs.readFileSync(path.join(root, ...segments), 'utf8');

describe('RAG maintenance destructive-action confirmations', () => {
  const view = read('views', 'pages', 'maintenance.ejs');
  const maintenance = read('public', 'js', 'maintenance.js');
  const api = read('public', 'js', 'api.js');

  test('provides one accessible exact-phrase dialog for cleanup and reindex', () => {
    expect(view).toContain('<dialog id="maintenance-confirm-dialog"');
    expect(view).toContain('aria-labelledby="maintenance-confirm-title"');
    expect(view).toContain('aria-describedby="maintenance-confirm-description"');
    expect(view).toContain('id="maintenance-confirm-input"');
    expect(view).toContain('id="maintenance-confirm-error"');
    expect(view).toContain('id="maintenance-confirm-submit"');
    expect(maintenance).toContain("actionConfirmInput.value === actionConfirmExpected.textContent");
    expect(maintenance).toContain("actionConfirmDialog.addEventListener('cancel'");
    expect(maintenance).not.toMatch(/\bconfirm\s*\(/);
  });

  test('binds cleanup confirmation to the selected source and forwards it', () => {
    expect(maintenance).toContain("var expected = 'DELETE STALE DOCUMENTS FROM ' + source;");
    expect(maintenance).toContain('RAG.runCleanup(source, false, expected)');
    expect(api).toContain('async function runCleanup(source, dryRun, confirmation)');
    expect(api).toContain('body.confirmation = confirmation');
  });

  test('requires and forwards the global reindex phrase', () => {
    expect(maintenance).toContain("var expected = 'REINDEX ALL DOCUMENTS';");
    expect(maintenance).toContain('RAG.triggerReindex(expected)');
    expect(api).toContain('async function triggerReindex(confirmation)');
    expect(api).toContain('body: JSON.stringify({ confirmation: confirmation })');
  });
});
