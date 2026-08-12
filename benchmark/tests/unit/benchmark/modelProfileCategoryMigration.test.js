'use strict';

const mongoose = require('mongoose');
const {
    buildMigrationPlan,
    normalizeCategories
} = require('../../../src/services/benchmark/modelProfileCategoryMigration');

describe('modelProfileCategoryMigration', () => {
    it('plans a minimal insert for benchmark-known legacy metadata', () => {
        const plan = buildMigrationPlan({
            profileDocs: [],
            benchmarkResultNames: ['qwen2.5:7b-instruct-q5_K_M', 'gemma4:e4b'],
            registryDocs: [
                {
                    modelName: 'qwen2.5:7b-instruct-q5_K_M',
                    displayName: 'Qwen 2.5 7B Instruct (Q5_K_M)',
                    categories: ['generalist', 'judge', 'ops'],
                    benchmarkStats: { bestCategory: null }
                },
                {
                    modelName: 'llama3.1:8b',
                    displayName: 'Llama 3.1 8B',
                    categories: ['generalist'],
                    benchmarkStats: { bestCategory: null }
                }
            ]
        });

        expect(plan.summary.matchedRegistryDocs).toBe(1);
        expect(plan.summary.plannedInserts).toBe(1);
        expect(plan.summary.skippedUnmatched).toBe(1);
        expect(plan.operations).toHaveLength(1);

        const operation = plan.operations[0].updateOne;
        expect(operation.filter).toEqual({ name: 'qwen2.5:7b-instruct-q5_K_M' });
        expect(operation.update.$set).toEqual({
            categories: ['generalist', 'judge', 'ops']
        });
        expect(operation.update.$setOnInsert).toEqual({
            name: 'qwen2.5:7b-instruct-q5_K_M',
            displayName: 'Qwen 2.5 7B Instruct (Q5_K_M)',
            tags: []
        });
    });

    it('becomes a no-op when the destination already matches the migrated metadata', () => {
        const existingId = new mongoose.Types.ObjectId();
        const plan = buildMigrationPlan({
            profileDocs: [
                {
                    _id: existingId,
                    name: 'qwen2.5:7b-instruct-q5_K_M',
                    categories: ['generalist', 'judge', 'ops'],
                    benchmarkStats: { bestCategory: 'judge' }
                }
            ],
            benchmarkResultNames: ['qwen2.5:7b-instruct-q5_K_M'],
            registryDocs: [
                {
                    modelName: 'qwen2.5:7b-instruct-q5_K_M',
                    displayName: 'Qwen 2.5 7B Instruct (Q5_K_M)',
                    categories: ['generalist', 'judge', 'ops'],
                    benchmarkStats: { bestCategory: 'judge' }
                }
            ]
        });

        expect(plan.summary.matchedRegistryDocs).toBe(1);
        expect(plan.summary.skippedNoChange).toBe(1);
        expect(plan.summary.plannedInserts).toBe(0);
        expect(plan.summary.plannedUpdates).toBe(0);
        expect(plan.operations).toHaveLength(0);
    });

    it('normalizes duplicate and blank categories without creating useless work', () => {
        expect(normalizeCategories([' generalist ', '', 'generalist', 'judge'])).toEqual([
            'generalist',
            'judge'
        ]);
    });
});
