/**
 * BenchmarkPrompt Model
 * Stores benchmark test prompts with level classification
 */

const mongoose = require('mongoose');

const BenchmarkPromptSchema = new mongoose.Schema({
    name: {
        type: String,
        required: true,
        trim: true
    },
    prompt: {
        type: String,
        required: true
    },
    level: {
        type: Number,
        required: true,
        min: 1,
        max: 5,
        index: true
    },
    category: {
        type: String,
        required: true,
        // Benchmark corpus categories. `factual` scores via the knowledge profile
        // but remains a distinct prompt/result category for reporting.
        enum: ['coding', 'reasoning', 'math', 'knowledge', 'instruction', 'creative', 'translation', 'factual'],
        index: true
    },
    expected_answer: {
        type: String,
        default: null
    },
    // Expected response length in tokens - used to calculate num_predict limit
    // Simple factual: 50-100, reasoning: 200-500, complex/creative: 500-1000
    expected_tokens: {
        type: Number,
        default: null,  // If null, uses level-based defaults
        min: 10,
        max: 10000
    },
    scoring_type: {
        type: String,
        enum: ['coding', 'reasoning', 'math', 'knowledge', 'instruction', 'creative', 'translation', 'custom'],
        default: 'reasoning'
    },
    scoring_dimensions: {
        type: [{
            name: {
                type: String,
                required: true,
                trim: true
            },
            weight: {
                type: Number,
                required: true,
                min: 0,
                max: 1
            },
            description: {
                type: String,
                required: true,
                trim: true
            },
            scale: {
                type: String,
                default: '0-10',
                trim: true
            },
            rubric: {
                type: String,
                default: '',
                trim: true
            }
        }],
        default: undefined
    },
    // Deterministic scoring configuration (bypasses LLM judge)
    // Explicit routing authority. `criteria` is retained for migration/reporting
    // but must be opt-in; absent means the scorer resolves a safe default.
    scoring_plan: {
        type: String,
        enum: ['deterministic', 'criteria', 'reference', 'decomposed', 'llm_judge', 'hybrid', 'auto', null],
        default: null
    },
    // Declares which evidence is allowed to decide correctness. `executable`
    // prompts may still be LLM-judged for diagnostic feedback, but their
    // ordinary batch rows are quarantined from leaderboard aggregation until
    // the named repository fixture is executed.
    evaluation_authority: {
        type: String,
        enum: ['judge', 'deterministic', 'executable'],
        default: 'judge'
    },
    executable_fixture_id: {
        type: String,
        default: null,
        trim: true,
        required: function executableFixtureRequired() {
            return this.evaluation_authority === 'executable';
        }
    },
    deterministic_scoring: {
        type: {
            type: String,
            enum: ['exact', 'numeric', 'json', 'regex'],
            required: false
        },
        // For regex type: patterns that must be present
        must_contain: [{
            pattern: { type: String },
            weight: { type: Number, default: 1 }
        }],
        // For regex type: patterns that must NOT be present
        must_not_contain: [String],
        // For numeric type: tolerance for matching (default 0.001)
        numeric_tolerance: { type: Number, default: 0.001 },
        // For numeric type: use relative tolerance (as percentage of expected)
        relative_match: { type: Boolean, default: false },
        // For exact type: case-sensitive comparison
        case_sensitive: { type: Boolean, default: false },
        // For exact type: only trim whitespace, don't normalize
        trim_only: { type: Boolean, default: false },
        // Named semantic validator for prompts where exact structural equality
        // is too strict for the correctness axis. The output_contract still
        // measures exact format separately.
        semantic_validator: {
            type: String,
            enum: [
                'job_shop_schedule',
                'dfa_divisible_by_3',
                'numeric_vector',
                'csv_table',
                'csv_fields',
                'numeric_tuple',
                'key_value_fields',
                'numeric_answer'
            ],
            default: undefined
        },
        // For numeric_answer: the set of values a correct answer must contain
        // (math prompts whose answer is numbers embedded in prose).
        answer_numbers: [{ type: Number }],
        // For numeric_answer: relative tolerance per value (default 0.01 = 1%).
        answer_tolerance: { type: Number, default: undefined }
    },
    // Output format contract for dual scoring (semantic vs format).
    //
    // Uses Mixed because contract shape is heterogeneous across types:
    //   - number_only: { type, allow_latex, description }
    //   - exact:       { type, template, description }
    //   - regex:       { type, pattern, description }
    //   - json_schema: { type, schema_keys, description }
    //   - structured_text: { type, word_count: {min,max,exact}|int,
    //                       sentence_count: {min,max}|int,
    //                       must_include: [string], must_not_include: [string],
    //                       required_terms: [string], forbidden_terms: [string],
    //                       line_word_count: {min,max}, ... }
    //
    // Prior strict-subschema definition silently stripped the structured_text
    // subfields on insert (see 0149 §6.1 / TODO 0150). formatComplianceScorer
    // tolerates unknown fields and validates types at scoring time, so Mixed
    // is safe here and restores round-trip fidelity for the catalog JSON.
    output_contract: {
        type: mongoose.Schema.Types.Mixed,
        default: undefined
    },
    // Expert reference answer for reference-based scoring
    reference_answer: {
        type: String,
        default: null
    },
    // Structured criteria for deterministic judging (e.g. ["Names Pine Ridge as the closed trail"])
    judge_criteria: {
        type: [String],
        default: undefined
    },
    representative: {
        type: Boolean,
        default: false
    },
    custom: {
        type: Boolean,
        default: false,
        index: true
    },
    created_at: {
        type: Date,
        default: Date.now,
        index: true
    }
}, {
    timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' }
});

// Compound indexes for common queries
BenchmarkPromptSchema.index({ level: 1, category: 1 });
BenchmarkPromptSchema.index({ custom: 1, created_at: -1 });

// Static helper methods
BenchmarkPromptSchema.statics.getByLevel = function(level) {
    return this.find({ level }).sort({ category: 1, name: 1 });
};

BenchmarkPromptSchema.statics.getByLevels = function(levels) {
    return this.find({ level: { $in: levels } }).sort({ level: 1, category: 1 });
};

BenchmarkPromptSchema.statics.getByCategory = function(category) {
    return this.find({ category }).sort({ level: 1, name: 1 });
};

BenchmarkPromptSchema.statics.getAllGroupedByLevel = async function() {
    const prompts = await this.find().sort({ level: 1, category: 1 });
    const byLevel = {};
    prompts.forEach(p => {
        if (!byLevel[p.level]) {
            byLevel[p.level] = [];
        }
        byLevel[p.level].push(p);
    });
    return { prompts, byLevel };
};

BenchmarkPromptSchema.statics.getCustomPrompts = function() {
    return this.find({ custom: true }).sort({ created_at: -1 });
};

BenchmarkPromptSchema.statics.seedFromArray = async function(prompts) {
    const count = await this.countDocuments();
    if (count === 0) {
        const docs = prompts.map(p => ({
            ...p,
            custom: false,
            created_at: new Date()
        }));
        await this.insertMany(docs);
        return docs.length;
    }
    return 0;
};

module.exports = mongoose.model('BenchmarkPrompt', BenchmarkPromptSchema);
