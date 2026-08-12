const fs = require('fs');
const path = require('path');

describe('Janitor profile action safety UI', () => {
  const client = fs.readFileSync(
    path.join(__dirname, '../../public/js/janitor-profiles.js'),
    'utf8'
  );

  test('offers a recorded preview before a separately labelled apply action', () => {
    expect(client).toContain('data-jnp-action="preview"');
    expect(client).toContain('data-jnp-action="apply"');
    expect(client).toContain('Apply approved action');
    expect(client).toContain('Dry-run preview recorded; no files were changed');
    expect(client).not.toContain('data-jnp-action="approve"');
    expect(client).not.toContain('Action approved & executed');
  });

  test('sends explicit distinct preview and apply request bodies', () => {
    expect(client).toContain('JSON.stringify({ confirm: true, dry_run: true })');
    expect(client).toContain("apply_confirm: 'DELETE_APPROVED_FILES'");
    expect(client).toContain("restore_confirm: 'VERIFIED_SURVIVOR_IS_RESTORE_SOURCE'");
    expect(client).toContain('preview_id: preview.id');
    expect(client).toContain('dry_run: false');
    expect(client).toMatch(/confirm\(`Permanently delete the \$\{count\} file\(s\)/);
    expect(client).toContain('Verified survivor and restore source:');
    expect(client).toContain('${restore.file}');
    expect(client).toContain('${restore.sha256}');
  });

  test('shows the complete-hash survivor evidence recorded by the preview', () => {
    expect(client).toContain('Verified restore source:');
    expect(client).toContain('Complete SHA-256:');
    expect(client).toContain('restore.sha256 !== preview.sha256');
  });

  test('keeps apply unavailable when the preview says maintenance is uncommissioned', () => {
    expect(client).toContain('preview?.live_apply_available === true');
    expect(client).toContain('disabled title="Live maintenance is not commissioned"');
    expect(client).toContain('Apply unavailable: live maintenance is not commissioned.');
  });
});
