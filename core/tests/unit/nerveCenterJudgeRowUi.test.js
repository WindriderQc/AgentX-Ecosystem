const fs = require('fs');
const path = require('path');

const source = fs.readFileSync(path.join(__dirname, '../../public/js/nerve-center-inference-health.js'), 'utf8');

describe('Nerve Center judge row separates Benchmark reachability from judge usability', () => {
  it('names the failing fact instead of calling every gap unreachable', () => {
    expect(source).toContain("case 'benchmark-unreachable': return 'Benchmark service unreachable';");
    expect(source).toContain("case 'benchmark-drift-error': return `Benchmark reachable, drift endpoint failed${status}`;");
    expect(source).toContain("case 'benchmark-drift-empty': return 'Benchmark reachable, no drift evidence yet';");
    expect(source).not.toContain("jd.error || jd.reason || 'benchmark unreachable'");
  });

  it('renders judge readiness beside the HTTP fact', () => {
    expect(source).toContain('function buildJudgeReadinessLine(readiness)');
    expect(source).toContain('buildJudgeDriftPanel(data.judgeDrift, data.judgeReadiness)');
    expect(source).toContain('Judge readiness: <strong style="color:${color}">${label}</strong>');
    expect(source).toContain('data-judge-readiness="unknown"');
  });
});
