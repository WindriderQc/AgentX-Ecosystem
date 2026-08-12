const { resolveMultiJudge, RULES } = require('../../../src/services/benchmark/resolveMultiJudge');

const HOST_DEFAULTS = {
    'http://192.0.2.66:11434': 'qwen2.5:14b-instruct-q4_K_M',
    'http://192.0.2.12:11434': 'qwen2.5:14b-instruct-q4_K_M',
    'http://192.0.2.99:11434': 'qwen2.5:7b-instruct-q5_K_M'
};

describe('resolveMultiJudge', () => {
    describe('disabled inputs', () => {
        it('returns disabled config for null', () => {
            const cfg = resolveMultiJudge(null);
            expect(cfg.enabled).toBe(false);
            expect(cfg.rule).toBe(RULES.OFF);
            expect(cfg.judges).toEqual([]);
        });

        it('returns disabled config for undefined', () => {
            const cfg = resolveMultiJudge(undefined);
            expect(cfg.enabled).toBe(false);
        });

        it('returns disabled config for "off"', () => {
            const cfg = resolveMultiJudge('off');
            expect(cfg.enabled).toBe(false);
            expect(cfg.rule).toBe(RULES.OFF);
        });

        it('returns disabled config when object has enabled:false', () => {
            const cfg = resolveMultiJudge({ enabled: false, judges: [{ model: 'a', host: 'b' }] });
            expect(cfg.enabled).toBe(false);
        });

        it('returns disabled config when no host map and rule is set', () => {
            const cfg = resolveMultiJudge('l4l5', { hostDefaults: {} });
            expect(cfg.enabled).toBe(false);
        });

        it('returns disabled config when only one host is available', () => {
            const cfg = resolveMultiJudge('l4l5', {
                hostDefaults: { 'http://only-host:11434': 'qwen2.5:14b' }
            });
            expect(cfg.enabled).toBe(false);
        });
    });

    describe('rule expansion', () => {
        it('expands "l4l5" with high-level escalation only', () => {
            const cfg = resolveMultiJudge('l4l5', { hostDefaults: HOST_DEFAULTS });
            expect(cfg.enabled).toBe(true);
            expect(cfg.rule).toBe(RULES.LEVEL_4_5);
            expect(cfg.escalateOnHighLevel).toBe(true);
            expect(cfg.escalateOnLowConfidence).toBe(false);
            expect(cfg.escalateOnReview).toBe(false);
            expect(cfg.autoMinLevel).toBe(4);
            expect(cfg.judges).toHaveLength(3);
        });

        it('expands "low_confidence" with confidence + review escalation', () => {
            const cfg = resolveMultiJudge('low_confidence', { hostDefaults: HOST_DEFAULTS });
            expect(cfg.enabled).toBe(true);
            expect(cfg.escalateOnLowConfidence).toBe(true);
            expect(cfg.escalateOnReview).toBe(true);
            expect(cfg.escalateOnHighLevel).toBe(false);
        });

        it('expands "always" with autoMinLevel:1 and all flags on', () => {
            const cfg = resolveMultiJudge('always', { hostDefaults: HOST_DEFAULTS });
            expect(cfg.enabled).toBe(true);
            expect(cfg.autoMinLevel).toBe(1);
            expect(cfg.escalateOnHighLevel).toBe(true);
            expect(cfg.escalateOnLowConfidence).toBe(true);
        });

        it('picks the largest model as tiebreaker', () => {
            const cfg = resolveMultiJudge('l4l5', { hostDefaults: HOST_DEFAULTS });
            expect(cfg.tiebreaker).not.toBeNull();
            expect(cfg.tiebreaker.model).toMatch(/14b/i);
        });

        it('does not pick a redundant tiebreaker when only two judges are available', () => {
            const cfg = resolveMultiJudge('low_confidence', {
                hostDefaults: {
                    'http://judge-a:11434': 'qwen2.5:14b-instruct-q4_K_M',
                    'http://judge-b:11434': 'qwen2.5:14b-instruct-q4_K_M'
                }
            });
            expect(cfg.enabled).toBe(true);
            expect(cfg.judges).toHaveLength(2);
            expect(cfg.tiebreaker).toBeNull();
        });

        it('is case-insensitive for rule strings', () => {
            const cfg = resolveMultiJudge('L4L5', { hostDefaults: HOST_DEFAULTS });
            expect(cfg.enabled).toBe(true);
            expect(cfg.rule).toBe(RULES.LEVEL_4_5);
        });

        it('treats unknown rule strings as off', () => {
            const cfg = resolveMultiJudge('bogus-rule', { hostDefaults: HOST_DEFAULTS });
            expect(cfg.enabled).toBe(false);
        });
    });

    describe('custom object input', () => {
        it('passes through a fully-specified custom object', () => {
            const input = {
                enabled: true,
                judges: [
                    { model: 'judge-a', host: 'http://h1:11434' },
                    { model: 'judge-b', host: 'http://h2:11434' }
                ],
                tiebreaker: { model: 'judge-c', host: 'http://h3:11434' },
                autoMinLevel: 3,
                confidenceThreshold: 0.6,
                escalateOnLowConfidence: true
            };
            const cfg = resolveMultiJudge(input);
            expect(cfg.enabled).toBe(true);
            expect(cfg.judges).toHaveLength(2);
            expect(cfg.tiebreaker.model).toBe('judge-c');
            expect(cfg.autoMinLevel).toBe(3);
            expect(cfg.confidenceThreshold).toBe(0.6);
            expect(cfg.escalateOnLowConfidence).toBe(true);
        });

        it('disables when custom object provides fewer than 2 judges', () => {
            const cfg = resolveMultiJudge({
                enabled: true,
                judges: [{ model: 'only-one', host: 'http://h:11434' }]
            });
            expect(cfg.enabled).toBe(false);
        });

        it('drops malformed judge entries silently', () => {
            const cfg = resolveMultiJudge({
                enabled: true,
                judges: [
                    { model: 'good', host: 'http://h1:11434' },
                    { model: '', host: 'http://h2:11434' },
                    null,
                    { model: 'good2', host: 'http://h3:11434' }
                ]
            });
            expect(cfg.enabled).toBe(true);
            expect(cfg.judges).toHaveLength(2);
        });

        it('clamps autoMinLevel into [1,10]', () => {
            const cfg = resolveMultiJudge({
                enabled: true,
                judges: [
                    { model: 'a', host: 'h1' },
                    { model: 'b', host: 'h2' }
                ],
                autoMinLevel: 99
            });
            expect(cfg.autoMinLevel).toBe(10);
        });

        it('clamps confidenceThreshold into [0,1]', () => {
            const cfg = resolveMultiJudge({
                enabled: true,
                judges: [
                    { model: 'a', host: 'h1' },
                    { model: 'b', host: 'h2' }
                ],
                confidenceThreshold: 5
            });
            expect(cfg.confidenceThreshold).toBe(1);
        });

        it('expands rule when object only carries a rule field', () => {
            const cfg = resolveMultiJudge({ rule: 'l4l5' }, { hostDefaults: HOST_DEFAULTS });
            expect(cfg.enabled).toBe(true);
            expect(cfg.rule).toBe(RULES.LEVEL_4_5);
        });

        it('merges rule flags onto custom judges when a known rule is provided', () => {
            const cfg = resolveMultiJudge({
                rule: 'low_confidence',
                judges: [
                    { model: 'a', host: 'h1' },
                    { model: 'b', host: 'h2' }
                ]
            });
            expect(cfg.enabled).toBe(true);
            expect(cfg.rule).toBe('low_confidence');
            expect(cfg.escalateOnLowConfidence).toBe(true);
            expect(cfg.escalateOnReview).toBe(true);
            expect(cfg.escalateOnHighLevel).toBe(false);
        });

        it('warns when all judges are from the same model family', () => {
            const cfg = resolveMultiJudge({
                enabled: true,
                judges: [
                    { model: 'qwen2.5:7b', host: 'h1' },
                    { model: 'qwen2.5:14b', host: 'h2' }
                ]
            });

            expect(cfg.judge_families).toEqual(['qwen']);
            expect(cfg.family_warnings.join(' ')).toMatch(/one model family/);
        });

        it('passes cross-family judge panels without warnings', () => {
            const cfg = resolveMultiJudge({
                enabled: true,
                judges: [
                    { model: 'qwen2.5:14b', host: 'h1' },
                    { model: 'llama3.1:8b', host: 'h2' },
                    { model: 'devstral:24b', host: 'h3' }
                ]
            });

            expect(cfg.judge_families.sort()).toEqual(['llama', 'mistral', 'qwen']);
            expect(cfg.family_warnings).toEqual([]);
        });
    });
});
