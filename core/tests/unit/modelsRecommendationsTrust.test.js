const fs = require('fs');
const path = require('path');

const source = fs.readFileSync(
  path.join(__dirname, '../../public/js/models-recommendations.js'),
  'utf8'
);

describe('Models recommendation evidence language', () => {
  test('requests an explicit Trusted scope and never calls the panel a winner', () => {
    expect(source).toContain('&trustScope=trusted');
    expect(source).toContain('Benchmark Evidence');
    expect(source).toContain('Trusted observation — no qualified winner');
    expect(source).toContain('Exploratory observation');
    expect(source).not.toContain('Benchmark Recommends');
    expect(source).not.toContain('Qualified winner');
  });

  test('caps a forged high-confidence row unless the verdict explicitly allows it', () => {
    expect(source).toContain("trustVerdict.contract === 'agentx.benchmark-consumer-trust/v1'");
    expect(source).toContain("!phase0Projection && trustVerdict?.highConfidenceAllowed === true");
    expect(source).toContain("rec.confidence === 'high' ? 'medium'");
  });
});
