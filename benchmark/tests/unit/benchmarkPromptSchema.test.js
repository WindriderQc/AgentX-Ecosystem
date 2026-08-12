/**
 * TODO 0150 — BenchmarkPrompt schema round-trip for `structured_text`
 * output contracts.
 *
 * Background
 * ----------
 * Before 0150, `output_contract.type` was a strict enum
 *   ['number_only', 'exact', 'regex', 'json_schema', 'none']
 * that did not include 'structured_text', and the subschema declared
 * no `word_count` / `sentence_count` / `must_include` / `must_not_include`
 * fields. On `insertMany`, Mongoose silently stripped every structured_text
 * contract in `benchmark/data/benchmark-prompts.json`, so the downstream
 * format-compliance scorer saw no contract and returned `format_score = null`
 * on R007 / R010 / R029 (see 0149 feedback §6.1).
 *
 * 0150 replaces the subschema with `Schema.Types.Mixed` so the contract
 * round-trips verbatim. This test proves the round-trip holds via a real
 * in-memory Mongo save + findOne cycle (not just instance coercion), and
 * also covers the sibling fix: `BenchmarkResult.format_gated` persists.
 */

const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');

jest.mock('../../config/logger', () => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn()
}));

const BenchmarkPrompt = require('../../models/BenchmarkPrompt');
const BenchmarkResult = require('../../models/BenchmarkResult');
const { seedPrompts } = require('../../src/services/benchmark/init');

let mongoServer;

beforeAll(async () => {
    mongoServer = await MongoMemoryServer.create();
    await mongoose.connect(mongoServer.getUri());
});

afterAll(async () => {
    await mongoose.disconnect();
    await mongoServer.stop();
});

afterEach(async () => {
    await BenchmarkPrompt.deleteMany({});
    await BenchmarkResult.deleteMany({});
});

describe('BenchmarkPrompt — structured_text output_contract round-trip', () => {
    test('output_contract path is declared as Mixed (not strict subschema)', () => {
        const path = BenchmarkPrompt.schema.path('output_contract');
        expect(path).toBeDefined();
        // Mixed paths register as instance 'Mixed' in Mongoose 7
        expect(path.instance).toBe('Mixed');
    });

    test('structured_text contract with word_count + must_include round-trips intact', async () => {
        const contract = {
            type: 'structured_text',
            word_count: { min: 45, max: 60 },
            must_include: ['test']
        };

        const saved = await BenchmarkPrompt.create({
            name: 'roundtrip-structured-text-0150',
            prompt: 'Write a short paragraph that mentions the word "test" in 45-60 words.',
            level: 3,
            category: 'instruction',
            output_contract: contract
        });

        const fetched = await BenchmarkPrompt.findById(saved._id).lean();
        expect(fetched).toBeTruthy();
        expect(fetched.output_contract).toBeDefined();
        expect(fetched.output_contract).not.toBeNull();

        // All three declared subfields must round-trip.
        expect(fetched.output_contract.type).toBe('structured_text');
        expect(fetched.output_contract.word_count).toEqual({ min: 45, max: 60 });
        expect(fetched.output_contract.must_include).toEqual(['test']);
    });

    test('structured_text contract with sentence_count + must_not_include round-trips', async () => {
        const contract = {
            type: 'structured_text',
            sentence_count: { min: 3, max: 5 },
            must_not_include: ['banned', 'forbidden']
        };

        const saved = await BenchmarkPrompt.create({
            name: 'roundtrip-sentence-count-0150',
            prompt: 'Write 3-5 sentences about clouds without using the words banned or forbidden.',
            level: 2,
            category: 'creative',
            output_contract: contract
        });

        const fetched = await BenchmarkPrompt.findById(saved._id).lean();
        expect(fetched.output_contract.type).toBe('structured_text');
        expect(fetched.output_contract.sentence_count).toEqual({ min: 3, max: 5 });
        expect(fetched.output_contract.must_not_include).toEqual(['banned', 'forbidden']);
    });

    test('legacy number_only contract still round-trips (no regression)', async () => {
        const contract = {
            type: 'number_only',
            allow_latex: true,
            description: 'single numeric answer'
        };

        const saved = await BenchmarkPrompt.create({
            name: 'roundtrip-number-only-0150',
            prompt: 'What is 2 + 2?',
            level: 1,
            category: 'math',
            output_contract: contract
        });

        const fetched = await BenchmarkPrompt.findById(saved._id).lean();
        expect(fetched.output_contract.type).toBe('number_only');
        expect(fetched.output_contract.allow_latex).toBe(true);
        expect(fetched.output_contract.description).toBe('single numeric answer');
    });

    test('insertMany preserves structured_text — matches the seeder path', async () => {
        // Mirror how src/services/benchmark/init.js#seedPrompts feeds records
        // from benchmark-prompts.json into BenchmarkPrompt.insertMany. This is
        // the exact call site that was stripping fields pre-0150.
        const records = [
            {
                name: 'seed-strucured-0150-A',
                prompt: 'Write 100 words.',
                level: 5,
                category: 'creative',
                output_contract: {
                    type: 'structured_text',
                    word_count: { min: 95, max: 105 }
                }
            },
            {
                name: 'seed-strucured-0150-B',
                prompt: 'List three items.',
                level: 2,
                category: 'instruction',
                output_contract: {
                    type: 'structured_text',
                    must_include: ['one', 'two', 'three'],
                    sentence_count: { min: 3, max: 3 }
                }
            }
        ];

        await BenchmarkPrompt.insertMany(records);

        const a = await BenchmarkPrompt.findOne({ name: 'seed-strucured-0150-A' }).lean();
        const b = await BenchmarkPrompt.findOne({ name: 'seed-strucured-0150-B' }).lean();

        expect(a.output_contract.word_count).toEqual({ min: 95, max: 105 });
        expect(b.output_contract.must_include).toEqual(['one', 'two', 'three']);
        expect(b.output_contract.sentence_count).toEqual({ min: 3, max: 3 });
    });

    test('seedPrompts syncs library output contracts onto existing prompt rows', async () => {
        await BenchmarkPrompt.create({
            name: 'Capital City Recall',
            prompt: 'What is the capital of France?',
            level: 1,
            category: 'knowledge',
            expected_answer: 'Paris',
            expected_tokens: 20,
            scoring_type: 'knowledge',
            deterministic_scoring: {
                type: 'exact',
                case_sensitive: false
            }
        });

        await seedPrompts();

        const fetched = await BenchmarkPrompt.findOne({ name: 'Capital City Recall' }).lean();
        expect(fetched.prompt).toBe('Answer with only the city name: What is the capital of France?');
        expect(fetched.output_contract).toEqual({
            type: 'exact',
            template: 'Paris'
        });
    });
});

describe('BenchmarkResult — format_gated field (0149 sibling fix)', () => {
    test('format_gated path is declared on the schema', () => {
        const path = BenchmarkResult.schema.path('format_gated');
        expect(path).toBeDefined();
        expect(path.instance).toBe('Boolean');
    });

    test('format_gated defaults to null and persists true on round-trip', async () => {
        const saved = await BenchmarkResult.create({
            model: 'test-model',
            host: 'http://localhost:11434',
            prompt: 'structured output probe',
            success: true,
            format_gated: true
        });

        const fetched = await BenchmarkResult.findById(saved._id).lean();
        expect(fetched.format_gated).toBe(true);
    });

    test('format_gated absent in input persists as null (default)', async () => {
        const saved = await BenchmarkResult.create({
            model: 'test-model',
            host: 'http://localhost:11434',
            prompt: 'no gate probe',
            success: true
        });

        const fetched = await BenchmarkResult.findById(saved._id).lean();
        expect(fetched.format_gated).toBeNull();
    });
});
