const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '../..');
const read = (...segments) => fs.readFileSync(path.join(ROOT, ...segments), 'utf8');

describe('Courthouse dashboard count contracts', () => {
    test('publishes authoritative operational counts', () => {
        const results = read('src', 'services', 'benchmark', 'results.js');
        expect(results).toContain('BenchmarkResult.countDocuments({ needs_review: true })');
        expect(results).toContain("human_review_status: { $in: ['approved', 'overridden', 'rejected'] }");
        expect(results).toContain("BenchmarkResult.countDocuments({ human_review_status: 'overridden' })");
        expect(results).toContain('JudgeGroundTruth.countDocuments(buildCourthouseGroundTruthCountQuery())');
        expect(results).toContain('ground_truth_count: groundTruthCount');
    });

    test('renders missing evidence as unknown instead of zero', () => {
        const bench = read('public', 'js', 'courthouse-v2', 'the-bench.js');
        expect(bench).toContain('o.ground_truth_count   ?? null');
        expect(bench).toContain("value == null ? '—'");
        expect(bench).not.toContain('o.ground_truth_count   ?? 0');
    });
});
