const fs = require('fs');
const path = require('path');

const source = fs.readFileSync(path.join(__dirname, '../../public/js/pipeline.js'), 'utf8');

describe('Pipeline Mark superseded is a previewed, confirmed, cancellable human decision', () => {
  test('the drawer offers the action on open tasks with replacement, reason and identity', () => {
    expect(source).toContain('data-drawer-action="supersede-preview"');
    expect(source).toContain('name="supersededBy"');
    expect(source).toContain('name="reason" rows="2" maxlength="2000" minlength="8" required');
    expect(source).toContain('<span>Decided by</span>');
    expect(source).toContain('Nothing is re-queued; the decision is written to both audit trails');
  });

  test('preview shows the transition and checks and confirms only when the server says ok', () => {
    expect(source).toContain('function renderSupersedePreview(task)');
    expect(source).toContain('Preview</strong> — nothing has changed yet.');
    expect(source).toContain('data-drawer-action="supersede-confirm"');
    expect(source).toContain("${preview.ok ? '' : 'disabled'}");
    expect(source).toContain('data-drawer-action="supersede-cancel"');
    expect(source).toContain("if (!pending || pending.pipelineId !== pipelineId || !pending.preview?.ok) return;");
    expect(source).toContain("body: JSON.stringify({ supersededBy: pending.supersededBy, reason: pending.reason, by: pending.by, confirm: true })");
  });

  test('the preview request never sends confirm, and cancel clears the pending decision', () => {
    expect(source).toContain("body: JSON.stringify({ supersededBy, reason, by })");
    expect(source).toContain("} else if (action === 'supersede-cancel') {");
    expect(source).toContain('state.drawer.supersede = null;');
    expect(source).toContain("closest('button[data-drawer-action=\"supersede-cancel\"]')");
  });

  test('a superseded task is labelled with its replacement and its history stays visible', () => {
    expect(source).toContain("task.resolution && task.resolution.kind === 'superseded'");
    expect(source).toContain('pipeline-chip-superseded');
    expect(source).toContain('Closed without delivery. Reopening requires an explicit decision; it never re-queues by itself.');
  });
});
