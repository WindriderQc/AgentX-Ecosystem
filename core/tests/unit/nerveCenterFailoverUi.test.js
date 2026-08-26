const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '../..');
const view = fs.readFileSync(path.join(root, 'views/pages/nerve-center.ejs'), 'utf8');
const controller = fs.readFileSync(path.join(root, 'public/js/nerve-center.js'), 'utf8');
const routing = fs.readFileSync(path.join(root, 'public/js/nerve-center-routing.js'), 'utf8');

describe('Nerve Center failover UI', () => {
  it('shows persisted actual routing and does not expose process-local intent controls', () => {
    expect(view).toContain('Intent → Last Served');
    expect(view).toContain('embeddings are excluded');
    expect(view).toContain('Persisted actual-route state');
    expect(view).not.toContain('id="btnFailover"');
    expect(view).not.toContain('id="btnResetPrimary"');
    expect(controller).not.toContain('manual_nerve_center');
    expect(routing).toContain('persisted actual routes');
  });
});
