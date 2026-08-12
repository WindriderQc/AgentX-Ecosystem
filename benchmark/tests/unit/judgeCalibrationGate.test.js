const path = require('path');
const { runCalibration, applyGates } = require('../../scripts/ci/judge-calibration-gate');
const goldset = require('../../data/judge-calibration-set.json');

const scoresByName = new Map(goldset.map((entry) => [`config-goldset-${entry.id}`, entry.gold_score]));

describe('judge calibration gate', () => {
    test('passes when injected scorer matches the goldset scores', async () => {
        const run = await runCalibration({
            judgeConfig: { host: 'http://judge:11434', model: 'stub' },
            goldsetPath: path.join(__dirname, '..', '..', 'data', 'judge-calibration-set.json'),
            scoreResponseFn: async ({ prompt }) => ({
                quality_score: scoresByName.get(prompt.name),
                scoring_method: 'stub',
                judge_confidence: 1,
                needs_review: false
            })
        });

        expect(run.summary.tolerance_rate).toBe(100);
        expect(run.summary.mae).toBe(0);
        expect(applyGates(run.summary).pass).toBe(true);
    });

    test('fails when mae exceeds the gate', () => {
        const result = applyGates({
            tolerance_rate: 50,
            review_match_rate: 100,
            mae: 3
        });

        expect(result.pass).toBe(false);
        expect(result.failures.join(' ')).toMatch(/mae/);
    });
});
