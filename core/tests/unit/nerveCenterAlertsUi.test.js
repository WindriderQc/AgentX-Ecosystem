const fs = require('fs');
const path = require('path');

const source = fs.readFileSync(
  path.join(__dirname, '../../public/js/nerve-center-alerts.js'),
  'utf8'
);
const summarySource = fs.readFileSync(
  path.join(__dirname, '../../public/js/nerve-center.js'),
  'utf8'
);
const healthSource = fs.readFileSync(
  path.join(__dirname, '../../public/js/nerve-center-health.js'),
  'utf8'
);

describe('Nerve Center alerts UI', () => {
  it('uses the alert-list snapshot for both rows and severity counts', () => {
    expect(source).toContain("fetchJson('/api/alerts?status=active&limit=20')");
    expect(source).not.toContain("fetchJson('/api/alerts/stats/summary?status=active')");
    expect(source).toContain('const summary = Array.isArray(alertData) ? {} : (alertData.summary || {});');
    expect(source).toContain('Number(summary.activeCount)');
  });

  it('uses the uncapped active snapshot count in the overview widget', () => {
    expect(summarySource).toMatch(/const\s+\{[^}]*\balertSummary\b[^}]*\}\s*=\s*snapshot;/);
    expect(summarySource).toContain("const ECOSYSTEM_SNAPSHOT_URL = '/api/nerve-center/ecosystem'");
    expect(summarySource).toContain('Number(alertSummary?.activeCount)');
    expect(summarySource).not.toContain('(Array.isArray(alerts) ? alerts.length : 0)');
  });

  it('labels history and discloses grouped persisted rows in the health feed', () => {
    expect(healthSource).toContain('event.groupedCount');
    expect(healthSource).toContain('persisted rows grouped');
    expect(healthSource).toContain('The feed below includes labelled history');
    expect(healthSource).toContain('feedMeta.activeAlertCount');
  });
});
