const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '../..');
const view = fs.readFileSync(path.join(root, 'views/pages/nerve-center.ejs'), 'utf8');
const module_ = fs.readFileSync(path.join(root, 'public/js/nerve-center-brainmap.js'), 'utf8');
const app = fs.readFileSync(path.join(root, 'src/app.js'), 'utf8');

describe('Nerve Center Fleet Brain Map UI (0509)', () => {
  it('renders the section in overview mode (not operator-detail-only)', () => {
    expect(view).toContain('id="sectionBrainMap"');
    expect(view).toContain('id="sectionBrainMapBody"');
    expect(view).toContain('id="btnRefreshBrainMap"');
    expect(view).toContain('Fleet Brain Map');
    const sectionTag = view.split('id="sectionBrainMap"')[0].split('<div class="nc-section').pop();
    expect(sectionTag).not.toContain('nc-detail-only');
  });

  it('is presentation-only over the three existing endpoints', () => {
    expect(module_).toContain('/api/nerve-center/host-preferences');
    expect(module_).toContain('/api/hosts');
    expect(module_).toContain('/api/nerve-center/routing/config');
    // No mutation from this panel — it is a map, not a control surface.
    expect(module_).not.toMatch(/method:\s*['"](POST|PUT|DELETE)/i);
  });

  it('tells the day/night story and cites the evidence docs', () => {
    expect(module_).toContain('Day mode');
    expect(module_).toContain('Deep-work window');
    expect(module_).toContain('fleet-brain-map.md');
    expect(module_).toContain('0373');
  });

  it('is wired into the nerve-center page scripts', () => {
    expect(app).toContain('/js/nerve-center-brainmap.js');
  });
});
