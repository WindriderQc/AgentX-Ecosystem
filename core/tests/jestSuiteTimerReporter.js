/**
 * Jest custom reporter — logs slow test suites.
 * Options: { slowSuiteMs: 5000, showTopSlow: 10 }
 */
class SuiteTimerReporter {
  constructor(globalConfig, options = {}) {
    this.slowMs = options.slowSuiteMs || 5000;
    this.topN = options.showTopSlow || 10;
    this.suites = [];
  }

  onTestResult(_test, testResult) {
    const duration = testResult.perfStats
      ? testResult.perfStats.end - testResult.perfStats.start
      : 0;
    this.suites.push({
      path: testResult.testFilePath.replace(process.cwd() + '/', ''),
      duration,
    });
  }

  onRunComplete() {
    const slow = this.suites
      .filter(s => s.duration >= this.slowMs)
      .sort((a, b) => b.duration - a.duration)
      .slice(0, this.topN);

    if (slow.length > 0) {
      console.log(`\n⏱  Slow test suites (>${this.slowMs}ms):`);
      slow.forEach(s => {
        console.log(`   ${(s.duration / 1000).toFixed(1)}s  ${s.path}`);
      });
    }
  }
}

module.exports = SuiteTimerReporter;
