const fs = require('fs');
const path = require('path');

const controller = fs.readFileSync(path.join(__dirname, '../../public/js/memory-review.js'), 'utf8');

describe('Dreaming Review agrees with Nerve Center on a quiet loop', () => {
  test('a quiet run is healthy only when no collecting-nothing alert is active', () => {
    expect(controller).toContain("alert?.context?.metric === 'memory_review_no_eligible_evidence'");
    expect(controller).toContain("apiJson('/api/alerts?status=active&limit=100')");
    expect(controller).toContain('} else if (latest.quiet && state.collectingAlert) {');
    expect(controller).toContain('Quiet—and Nerve Center says that is not healthy');
    expect(controller).toContain('} else if (latest.quiet && latest.overdueRun) {');
    expect(controller).toContain('No active collecting alert contradicts this.');
  });

  test('the pulse states last run, last completed run, last eligible evidence, cadence and next due', () => {
    for (const fact of [
      'Last completed run',
      'Last run in which a collector produced eligible evidence',
      'Expected cadence',
      'collecting-nothing alert active',
      'no collecting alert',
    ]) {
      expect(controller).toContain(fact);
    }
    expect(controller).toContain("latest.overdueRun ? 'was due' : 'next due'");
  });
});
