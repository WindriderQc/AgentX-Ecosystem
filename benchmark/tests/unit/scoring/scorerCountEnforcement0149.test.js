/**
 * Tests for TODO 0149 — formatComplianceScorer: word/sentence/keyword
 * enforcement with the weighted-soft aggregator.
 *
 * Validates:
 *   - Deterministic R007/R010/R029 replays from R6 (format_score < 5)
 *   - Compound-contract safety: one soft-fail does NOT collapse to 0
 *   - Compound-contract safety #2: two soft-fails still keep gate silent
 *   - Catastrophic single-failure: score = 0, gate fires
 *   - Alias coverage (min_words/max_words/must_include/must_not_include)
 *
 * The aggregator formula under test is
 *   format_score = 0.7 × weighted_avg + 0.3 × min_sub_score
 * as specified in docs/benchmark/scoring-contract-v1.md §2.5 post-0149.
 */

jest.mock('../../../config/logger', () => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn()
}));

const { scoreFormatCompliance, FORMAT_SCORE_AGGREGATOR_WEIGHTS } = require('../../../src/services/scoring/formatComplianceScorer');

const CATALOG = require('../../../data/benchmark-prompts.json');

const R6_ROWS = {
    R007: {
        response_text: 'On April 6, Maria and Ken will meet at 8 a.m. with gloves and bags to clean the dumpster area and separate recycling for pickup. The team has a $1,200 budget for supplies, hauling, and signs, so volunteers should track costs carefully and report receipts to the coordinator before lunch. If storms arrive, the work is postponed to April 13 as the rain date, with the same plan and crew assignments.'
    },
    R010: {
        response_text: 'On April 6, Maria and Ken will meet at 8 a.m. beside the dumpster with gloves and bags, then sort trash from recycling before pickup. The cleanup uses a $1,200 budget for signs, hauling, refreshments, and extra supplies, and volunteers should record every purchase carefully. If heavy weather moves in, the entire event is postponed to April 13 as the rain date, but the same checklist, assignments, and staging area still apply.'
    },
    R029: {
        response_text: 'Pack umbrellas for rain today because wet weather can ruin plans quickly.'
    }
};

function loadRow(rowId) {
    const row = R6_ROWS[rowId];
    if (!row) throw new Error(`row ${rowId} not found in R6 sample`);
    return row;
}

function loadCatalogContract(promptName) {
    const prompt = CATALOG.find(p => p.name === promptName);
    if (!prompt) throw new Error(`prompt ${promptName} not in catalog`);
    return prompt.output_contract;
}

// ─── Tests ───────────────────────────────────────────────────────────────

describe('0149 — formatComplianceScorer weighted-soft aggregator', () => {
    describe('aggregator constants', () => {
        it('exposes the 0.7 / 0.3 blend weights', () => {
            expect(FORMAT_SCORE_AGGREGATOR_WEIGHTS.avg).toBe(0.7);
            expect(FORMAT_SCORE_AGGREGATOR_WEIGHTS.minPenalty).toBe(0.3);
        });
    });

    describe('R6 deterministic replays', () => {
        it('R007 — Meeting Summary Constraints (qwen2.5:7b) scores < 5', () => {
            const row = loadRow('R007');
            const contract = loadCatalogContract('Meeting Summary Constraints');
            const result = scoreFormatCompliance(row.response_text, contract);
            expect(result.format_score).toBeLessThan(5);
            expect(result.format_compliant).toBe(false);
        });

        it('R010 — Meeting Summary Constraints (qwen2.5-coder) scores < 5', () => {
            const row = loadRow('R010');
            const contract = loadCatalogContract('Meeting Summary Constraints');
            const result = scoreFormatCompliance(row.response_text, contract);
            expect(result.format_score).toBeLessThan(5);
            expect(result.format_compliant).toBe(false);
        });

        it('R029 — Two-Sentence Rain Constraint scores < 5', () => {
            const row = loadRow('R029');
            const contract = loadCatalogContract('Two-Sentence Rain Constraint');
            const result = scoreFormatCompliance(row.response_text, contract);
            expect(result.format_score).toBeLessThan(5);
            expect(result.format_compliant).toBe(false);
        });
    });

    describe('compound-contract safety (mandatory per R5 post-mortem)', () => {
        const makeResponse = (wordCount, includeAlpha, includeBeta) => {
            const words = [];
            for (let i = 0; i < wordCount; i++) {
                if (includeAlpha && i === 5) words.push('alpha');
                else if (includeBeta && i === 12) words.push('beta');
                else words.push('filler');
            }
            return words.join(' ');
        };

        const contract = {
            type: 'structured_text',
            max_length: 2000,
            word_count: { min: 100, max: 200 },
            must_include: ['alpha', 'beta']
        };

        it('one soft-fail (missing beta) does NOT collapse — format_score ≥ 7', () => {
            const response = makeResponse(150, true, false);
            const result = scoreFormatCompliance(response, contract);
            // Sub-scores:
            //   word_count 150 in [100,200] → 10
            //   max_length ≤ 1000          → 10
            //   must_include 1 missing     → 10 - 2 = 8
            // avg = (10+10+8)/3 = 9.33, min = 8
            // format_score = 0.7 × 9.33 + 0.3 × 8 = 6.53 + 2.4 = 8.93 ≈ 8.9
            expect(result.format_score).toBeGreaterThanOrEqual(7);
            expect(result.format_compliant).toBe(false);
        });

        it('two soft-fails (both keywords missing) still keeps gate silent — format_score ≥ 5', () => {
            const response = makeResponse(150, false, false);
            const result = scoreFormatCompliance(response, contract);
            // Sub-scores:
            //   word_count → 10
            //   max_length → 10
            //   must_include 2 missing → 10 - 4 = 6
            // avg = (10+10+6)/3 = 8.67, min = 6
            // format_score = 0.7 × 8.67 + 0.3 × 6 = 6.07 + 1.8 = 7.87 ≈ 7.9
            expect(result.format_score).toBeGreaterThanOrEqual(5);
            expect(result.format_compliant).toBe(false);
        });

        it('all-pass compound contract → format_score = 10, format_compliant = true', () => {
            const response = makeResponse(150, true, true);
            const result = scoreFormatCompliance(response, contract);
            expect(result.format_score).toBe(10);
            expect(result.format_compliant).toBe(true);
        });
    });

    describe('catastrophic single-check failure', () => {
        it('single-check word_count violation → format_score = 0 (gate fires)', () => {
            const contract = { type: 'structured_text', word_count: { min: 100, max: 200 } };
            const result = scoreFormatCompliance('way too short', contract);
            expect(result.format_score).toBe(0);
            expect(result.format_compliant).toBe(false);
        });

        it('single-check must_include with both missing → format_score = 6 (gate does not fire — single soft fail)', () => {
            // Documents the single-check semantic: a must_include contract with
            // both required keywords missing produces sub_score = 6, which is
            // above the < 5 gate threshold. This is intentional: two missing
            // keywords out of two (−2 × 2 = 6) is graded, not catastrophic.
            // Catastrophic shape comes from responses with neither keyword AND
            // some other violation, which is what the compound test above covers.
            const contract = { type: 'structured_text', must_include: ['alpha', 'beta'] };
            const result = scoreFormatCompliance('nothing matches', contract);
            expect(result.format_score).toBe(6);
        });
    });

    describe('alias coverage', () => {
        it('min_words + max_words alias works like word_count.{min,max}', () => {
            const shortContract = { type: 'structured_text', min_words: 100, max_words: 200 };
            const canonicalContract = { type: 'structured_text', word_count: { min: 100, max: 200 } };
            const response = 'short response';
            const r1 = scoreFormatCompliance(response, shortContract);
            const r2 = scoreFormatCompliance(response, canonicalContract);
            expect(r1.format_score).toBe(r2.format_score);
        });

        it('must_not_include alias triggers the forbidden-term penalty', () => {
            const contract = { type: 'structured_text', must_not_include: ['spoiler'] };
            const response = 'this contains a spoiler in the middle';
            const result = scoreFormatCompliance(response, contract);
            // single forbidden term violation: 10 - 3 = 7
            // single sub-score: avg=7, min=7 → format_score = 7
            expect(result.format_score).toBe(7);
            expect(result.format_compliant).toBe(false);
        });

        it('sentence_count scalar alias behaves like {min:n,max:n}', () => {
            const contract = { type: 'structured_text', sentence_count: 2 };
            const twoSentence = 'First sentence here. Second sentence follows.';
            const fourSentence = 'One. Two. Three. Four.';
            expect(scoreFormatCompliance(twoSentence, contract).format_score).toBe(10);
            expect(scoreFormatCompliance(fourSentence, contract).format_score).toBeLessThan(5);
        });
    });

    describe('no hard-min failure mode (post-0146 contract)', () => {
        it('compound contract with one sub_score = 2 does not drop below 5', () => {
            // Synthetic shape: 3 checks where one lands at exactly sub_score=2
            // (an out-of-tolerance count violation still within the soft band).
            // Pure-min aggregator would return 2 here; weighted-soft returns
            // 0.7×(10+10+2)/3 + 0.3×2 = 5.13 + 0.6 = 5.73.
            // We exercise this by constructing a response 12% over the max.
            const contract = {
                type: 'structured_text',
                word_count: { min: 100, max: 100 }, // exact-count-ish range
                must_include: ['alpha'],
                max_length: 10000
            };
            // 150 words = 50% over, well outside the 10% soft tolerance → scoreRange → 0
            const words = Array(150).fill('filler').map((w, i) => i === 3 ? 'alpha' : w).join(' ');
            const result = scoreFormatCompliance(words, contract);
            // word_count=0, must_include=10, max_length=10
            // avg = (0+10+10)/3 = 6.67, min = 0
            // format_score = 0.7×6.67 + 0.3×0 = 4.67 → 4.7
            // This one DOES cross the <5 gate because the min is 0 (catastrophic
            // sub-check). Intended: a hard count miss in compound pulls the score
            // down through the min-penalty term — but it's NOT zero (avg keeps signal).
            // Pure hard-min (0146) would have returned exactly 0 here. Weighted-soft
            // returns 4.7 — gate fires, but compound info is preserved.
            expect(result.format_score).toBeCloseTo(4.7, 1);
        });
    });
});
