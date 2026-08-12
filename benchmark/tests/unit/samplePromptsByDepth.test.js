/**
 * Unit Tests for samplePromptsByDepth
 */

const { samplePromptsByDepth } = require('../../src/services/benchmark/promptSampling');

// Helper to generate mock prompts
function makePrompts(level, category, count, opts) {
    const prompts = [];
    for (let i = 1; i <= count; i++) {
        prompts.push({
            level,
            category,
            prompt: `L${level}-${category}-${i}`,
            _id: `${level}_${category}_${i}`,
            ...(opts && opts.representative && i === 1 ? { representative: true } : {})
        });
    }
    return prompts;
}

// Build a realistic prompt set matching the documented distribution
function buildFullPromptSet() {
    const prompts = [];
    const categories = ['coding', 'reasoning', 'math', 'knowledge', 'instruction', 'creative', 'translation'];
    const promptsPerLevel = { 1: 2, 2: 3, 3: 3, 4: 3, 5: 1 };

    for (let level = 1; level <= 5; level++) {
        for (const [index, category] of categories.entries()) {
            prompts.push(...makePrompts(level, category, promptsPerLevel[level], index === 0 ? { representative: true } : {}));
        }
    }
    return prompts;
}

describe('samplePromptsByDepth', () => {
    const allPrompts = buildFullPromptSet();

    describe('depth: off', () => {
        it('should return no prompts for levels set to off', () => {
            const config = { 1: 'off', 2: 'off', 3: 'off' };
            const level1to3 = allPrompts.filter(p => p.level <= 3);
            const result = samplePromptsByDepth(level1to3, config);
            expect(result).toHaveLength(0);
        });
    });

    describe('depth: full', () => {
        it('should return all prompts for a level', () => {
            const config = { 1: 'full' };
            const level1 = allPrompts.filter(p => p.level === 1);
            const result = samplePromptsByDepth(level1, config);
            expect(result).toHaveLength(level1.length);
        });

        it('should include every prompt (no filtering)', () => {
            const config = { 4: 'full' };
            const level4 = allPrompts.filter(p => p.level === 4);
            const result = samplePromptsByDepth(level4, config);
            expect(result).toEqual(expect.arrayContaining(level4));
        });
    });

    describe('depth: single', () => {
        it('should return exactly 1 prompt for the level', () => {
            const config = { 4: 'single' };
            const level4 = allPrompts.filter(p => p.level === 4);
            const result = samplePromptsByDepth(level4, config);
            expect(result).toHaveLength(1);
            expect(level4).toContainEqual(result[0]);
        });

        it('should pick the representative prompt deterministically', () => {
            const config = { 1: 'single' };
            const level1 = allPrompts.filter(p => p.level === 1);
            const result = samplePromptsByDepth(level1, config);
            expect(result).toHaveLength(1);
            expect(result[0].representative).toBe(true);
        });

        it('should return the same prompt every time (deterministic)', () => {
            const config = { 1: 'single' };
            const level1 = allPrompts.filter(p => p.level === 1);
            const results = [];
            for (let i = 0; i < 10; i++) {
                results.push(samplePromptsByDepth(level1, config)[0]);
            }
            // All 10 runs should return the exact same prompt
            const first = results[0];
            expect(results.every(r => r._id === first._id)).toBe(true);
        });

        it('should fall back to first prompt when no representative exists', () => {
            const noRepPrompts = [
                { level: 50, category: 'a', prompt: 'first', _id: '50_1' },
                { level: 50, category: 'b', prompt: 'second', _id: '50_2' },
            ];
            const result = samplePromptsByDepth(noRepPrompts, { 50: 'single' });
            expect(result).toHaveLength(1);
            expect(result[0]._id).toBe('50_1');
        });
    });

    describe('depth: light', () => {
        it('should return 1 prompt per category', () => {
            const config = { 1: 'light' };
            const level1 = allPrompts.filter(p => p.level === 1);
            const result = samplePromptsByDepth(level1, config);
            expect(result).toHaveLength(7);
            const categories = result.map(p => p.category);
            expect(new Set(categories).size).toBe(7);
        });

        it('should return 1 prompt per category for sparse levels too', () => {
            const config = { 5: 'light' };
            const level5 = allPrompts.filter(p => p.level === 5);
            const result = samplePromptsByDepth(level5, config);
            expect(result).toHaveLength(7);
        });
    });

    describe('mixed depths across levels', () => {
        it('should handle different depths for different levels', () => {
            const config = {
                1: 'full',
                2: 'light',
                3: 'off',
                4: 'single',
                5: 'full'
            };
            const prompts = allPrompts.filter(p => p.level <= 5);
            const result = samplePromptsByDepth(prompts, config);

            const byLevel = {};
            result.forEach(p => {
                if (!byLevel[p.level]) byLevel[p.level] = [];
                byLevel[p.level].push(p);
            });

            expect(byLevel[1] || []).toHaveLength(14);
            expect(byLevel[2] || []).toHaveLength(7);
            expect(byLevel[3]).toBeUndefined();
            expect(byLevel[4] || []).toHaveLength(1);
            expect(byLevel[5] || []).toHaveLength(7);
        });
    });

    describe('edge cases', () => {
        it('should return empty array for empty prompts', () => {
            const result = samplePromptsByDepth([], { 1: 'full' });
            expect(result).toHaveLength(0);
        });

        it('should handle string level keys in config', () => {
            const config = { '1': 'full' };
            const level1 = allPrompts.filter(p => p.level === 1);
            const result = samplePromptsByDepth(level1, config);
            expect(result).toHaveLength(level1.length);
        });

        it('should treat missing config levels as off', () => {
            const config = { 1: 'full' }; // No config for level 2
            const prompts = allPrompts.filter(p => p.level <= 2);
            const result = samplePromptsByDepth(prompts, config);
            expect(result.every(p => p.level === 1)).toBe(true);
        });

        it('should handle a level with only 1 prompt at any depth', () => {
            const singlePrompt = [{ level: 99, category: 'solo', prompt: 'test', _id: '99_1' }];
            expect(samplePromptsByDepth(singlePrompt, { 99: 'full' })).toHaveLength(1);
            expect(samplePromptsByDepth(singlePrompt, { 99: 'light' })).toHaveLength(1);
            expect(samplePromptsByDepth(singlePrompt, { 99: 'single' })).toHaveLength(1);
            expect(samplePromptsByDepth(singlePrompt, { 99: 'off' })).toHaveLength(0);
        });

        it('should handle unknown depth value as off', () => {
            const config = { 1: 'unknown_depth' };
            const level1 = allPrompts.filter(p => p.level === 1);
            const result = samplePromptsByDepth(level1, config);
            expect(result).toHaveLength(0);
        });
    });
});
