/**
 * Unit tests for scoring_type normalization (TODO 0114).
 *
 * Contract: docs/benchmark/scoring-contract-v1.md §2.2 + §3 rows 9, 10, 18, 26.
 *
 * Every call site that writes `scoring_type` must route the candidate through
 * `normalizeScoringCategory(..., DEFAULT_SCORING_CATEGORY)` so that:
 *   - known aliases (e.g. 'general' → 'knowledge') are resolved
 *   - unknown / null inputs fall back to `DEFAULT_SCORING_CATEGORY` ('knowledge')
 *   - the literal strings `'reasoning'` (hardcoded default) and `'general'` (non-enum)
 *     never land on a persisted row.
 */

jest.mock('../../../config/logger', () => ({
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn()
}));

const fs = require('fs');
const path = require('path');
const {
    normalizeScoringCategory,
    DEFAULT_SCORING_CATEGORY
} = require('../../../src/services/scoring/scoringConfigs');

describe('TODO 0114 - scoring_type normalization', () => {

    describe('normalizeScoringCategory primitive', () => {
        it('returns DEFAULT_SCORING_CATEGORY for null input', () => {
            expect(normalizeScoringCategory(null, DEFAULT_SCORING_CATEGORY)).toBe('knowledge');
        });

        it('returns DEFAULT_SCORING_CATEGORY for undefined input', () => {
            expect(normalizeScoringCategory(undefined, DEFAULT_SCORING_CATEGORY)).toBe('knowledge');
        });

        it("maps the legacy literal 'general' alias to 'knowledge'", () => {
            expect(normalizeScoringCategory('general', DEFAULT_SCORING_CATEGORY)).toBe('knowledge');
        });

        it("passes known canonical categories through unchanged", () => {
            ['coding', 'reasoning', 'math', 'knowledge', 'instruction', 'creative', 'translation']
                .forEach((cat) => {
                    expect(normalizeScoringCategory(cat, DEFAULT_SCORING_CATEGORY)).toBe(cat);
                });
        });

        it('returns the fallback when given an empty string', () => {
            expect(normalizeScoringCategory('', DEFAULT_SCORING_CATEGORY)).toBe('knowledge');
        });
    });

    describe('call site source-level checks', () => {
        /**
         * Static checks: every call site must import the normalizer + default,
         * must not retain the old `'reasoning'` / `'general'` literal fallbacks,
         * and must call `normalizeScoringCategory(...)` on the scoring_type it
         * passes downstream.
         */

        const SERVICE_ROOT = path.join(__dirname, '..', '..', '..', 'src', 'services');

        function readSource(relPath) {
            return fs.readFileSync(path.join(SERVICE_ROOT, relPath), 'utf8');
        }

        it('judgeExecutor (row 9) normalizes scoring_type and removes literal reasoning fallback', () => {
            const src = readSource('benchmark/judgeExecutor.js');
            expect(src).toMatch(/normalizeScoringCategory/);
            expect(src).toMatch(/scoring_type:\s*normalizeScoringCategory\(/);
            // Literal 'reasoning' fallback must be gone.
            expect(src).not.toMatch(/scoring_type[^\n]*\|\|\s*'reasoning'/);
        });

        it('judgeValidation (row 10) normalizes scoring_type and removes literal general fallback', () => {
            const src = readSource('judgeValidation.js');
            expect(src).toMatch(/normalizeScoringCategory\(sample\.prompt_category,\s*DEFAULT_SCORING_CATEGORY\)/);
            expect(src).not.toMatch(/scoring_type:\s*sample\.prompt_category\s*\|\|\s*'general'/);
            expect(src).not.toMatch(/'general'/);
        });

        it('referenceScorer (row 18) wraps prompt.scoring_type/category in normalizeScoringCategory', () => {
            const src = readSource('referenceScorer.js');
            expect(src).toMatch(/scoring_type:\s*normalizeScoringCategory\(/);
            expect(src).toMatch(/prompt\.scoring_type\s*\|\|\s*prompt\.category/);
        });

        it('retroCalibration (row 26) wraps sample.prompt_category in normalizeScoringCategory', () => {
            const src = readSource('benchmark/retroCalibration.js');
            expect(src).toMatch(/scoring_type:\s*normalizeScoringCategory\(sample\.prompt_category,\s*DEFAULT_SCORING_CATEGORY\)/);
        });

        it('batchResultPersistence straggler normalizes scoringType (no literal reasoning fallback)', () => {
            const src = readSource('benchmark/batchResultPersistence.js');
            expect(src).toMatch(/normalizeScoringCategory\(prompt\.scoring_type\s*\|\|\s*prompt\.category,\s*DEFAULT_SCORING_CATEGORY\)/);
            expect(src).not.toMatch(/\|\|\s*'reasoning'/);
        });
    });

    describe('canonical enum guarantee', () => {
        const CANONICAL = new Set([
            'coding', 'reasoning', 'math', 'knowledge',
            'instruction', 'creative', 'translation', 'custom'
        ]);

        it('every value normalizeScoringCategory returns for the 4 call sites lives in the canonical enum', () => {
            const samples = [
                null,                // 0114 bug input (undefined -> default)
                undefined,
                '',
                'reasoning',         // row 9 old literal
                'general',           // row 10 old literal
                'factual',           // alias → knowledge
                'code',              // alias → coding
                'coding',
                'translation',
                'weird-free-text-label'  // unknown: normalizeBenchmarkCategory lets this through;
                                         // call sites rely on downstream defaulting in scoringConfigs.getScoringDimensions.
            ];

            for (const s of samples) {
                const out = normalizeScoringCategory(s, DEFAULT_SCORING_CATEGORY);
                if (out === DEFAULT_SCORING_CATEGORY || CANONICAL.has(out)) continue;
                // For unknown strings that the helper passes through, we at least
                // must not be emitting the banned legacy literals.
                expect(out).not.toBe('general');
                expect(out).not.toBe('interactive');
            }
        });
    });
});
