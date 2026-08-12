/**
 * Unit tests for scoringProfile.js
 * Tests pure functions: buildDefaultProfile (via getDefaultScoringProfile),
 * validation logic, and deep merge. MongoDB-backed functions are tested
 * separately in integration tests.
 */

// Mock mongoose connection so scoringProfile.js loads without a real DB
jest.mock('mongoose', () => ({
    connection: { db: null }
}));

const {
    getDefaultScoringProfile,
    invalidateScoringProfileCache
} = require('../../../src/services/benchmark/scoringProfile');

describe('getDefaultScoringProfile', () => {
    it('returns an object with all required top-level keys', () => {
        const p = getDefaultScoringProfile();
        expect(p).toHaveProperty('categoryWeights');
        expect(p).toHaveProperty('generalist');
    });

    it('does not expose removed fields (dimensionWeights/compositeWeights/latencyCaps)', () => {
        const p = getDefaultScoringProfile();
        expect(p).not.toHaveProperty('dimensionWeights');
        expect(p).not.toHaveProperty('compositeWeights');
        expect(p).not.toHaveProperty('latencyCaps');
    });

    it('categoryWeights sum to 1.0', () => {
        const { categoryWeights } = getDefaultScoringProfile();
        const total = Object.values(categoryWeights).reduce((s, v) => s + v, 0);
        expect(Math.abs(total - 1.0)).toBeLessThan(0.001);
    });

    it('includes all 7 benchmark categories in categoryWeights', () => {
        const CATS = ['coding', 'reasoning', 'math', 'knowledge', 'instruction', 'creative', 'translation'];
        const { categoryWeights } = getDefaultScoringProfile();
        CATS.forEach(cat => expect(categoryWeights).toHaveProperty(cat));
    });

    it('generalist section contains expected fields with sane defaults', () => {
        const { generalist } = getDefaultScoringProfile();
        expect(generalist.coveragePenaltyMax).toBe(20);
        expect(generalist.difficultyPenaltyMax).toBe(20);
        expect(generalist.fullScopeMinLevel).toBe(4);
        expect(generalist.requiredPromptLevels).toEqual([4, 5]);
        expect(generalist.minFullScopeResults).toBe(28);
        expect(generalist.minConsistencyResults).toBe(42);
        expect(generalist.evidenceConfidenceTarget).toBe(0.75);
        expect(generalist.evidenceConfidencePenaltyMax).toBe(8);
        expect(generalist.consistencyBonus).toBe(5);
        expect(generalist.consistencyStddevThreshold).toBe(15);
        expect(generalist.minQualityForBonus).toBe(10);
        expect(generalist.emptyResponseFilterThreshold).toBe(0.5);
    });

    it('returns a fresh object on each call (no shared mutation risk)', () => {
        const a = getDefaultScoringProfile();
        const b = getDefaultScoringProfile();
        expect(a).not.toBe(b);
        a.categoryWeights.coding = 999;
        expect(b.categoryWeights.coding).not.toBe(999);
    });
});

describe('invalidateScoringProfileCache', () => {
    it('executes without error', () => {
        expect(() => invalidateScoringProfileCache()).not.toThrow();
    });
});

describe('categoryWeights default values', () => {
    it('coding weight is 0.20', () => {
        const { categoryWeights } = getDefaultScoringProfile();
        expect(categoryWeights.coding).toBeCloseTo(0.20, 5);
    });

    it('reasoning weight is 0.20', () => {
        const { categoryWeights } = getDefaultScoringProfile();
        expect(categoryWeights.reasoning).toBeCloseTo(0.20, 5);
    });
});
