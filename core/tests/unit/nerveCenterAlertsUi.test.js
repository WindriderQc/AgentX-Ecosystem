const fs = require('fs');
const path = require('path');

const source = fs.readFileSync(
  path.join(__dirname, '../../public/js/nerve-center-alerts.js'),
  'utf8'
);

describe('Nerve Center alerts UI', () => {
  it('reads active severity counts from the statistics response envelope', () => {
    expect(source).toContain("fetchJson('/api/alerts/stats/summary?status=active')");
    expect(source).toContain(
      'summaryRes.data?.statistics || summaryRes.data || summaryRes || {}'
    );
  });
});
