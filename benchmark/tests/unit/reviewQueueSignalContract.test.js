const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '../..');
const read = (...parts) => fs.readFileSync(path.join(root, ...parts), 'utf8');

describe('Courthouse review signal contract', () => {
    const queueSource = read('public', 'js', 'courthouse-v2', 'review-queue.js');
    const routeSource = read('routes', 'benchmark', 'results.js');

    test('projects an authoritative multi-judge divergence verdict', () => {
        expect(routeSource).toContain('judge_divergence: 1');
        expect(routeSource).toContain('judge_consensus: 1');
        expect(routeSource).toContain('judge_divergent:');
        expect(routeSource).toContain('DIVERGENCE_THRESHOLD');
        expect(routeSource).toContain('needs_review: 1');
    });

    test('uses independent review signals instead of exclusive classification', () => {
        expect(queueSource).toContain('function classifyFlags(r)');
        expect(queueSource).toContain("return candidates.filter(r => classifyFlags(r).includes(filterId))");
        expect(queueSource).not.toContain('function classifyFlag(r)');
        expect(queueSource).not.toContain("{ id: 'anomaly'");
        expect(queueSource).not.toContain('r.anomaly_flag');
    });

    test('renders unknown when the returned evidence omits a signal contract', () => {
        expect(queueSource).toContain('function hasSignalCoverage(candidates, filterId)');
        expect(queueSource).toContain("const count = covered");
        expect(queueSource).toContain("'—'");
        expect(queueSource).toContain('Signal unavailable in the returned evidence');
    });
});
