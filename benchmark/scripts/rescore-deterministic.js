#!/usr/bin/env node
/**
 * rescore-deterministic.js
 *
 * Re-runs deterministic/quick scoring against stored responses without
 * calling model or judge LLMs. Intended for scoring-bug backfills where a
 * semantic validator can safely promote a row that previously scored too low.
 *
 * Usage:
 *   node scripts/rescore-deterministic.js
 *   node scripts/rescore-deterministic.js --apply
 *   node scripts/rescore-deterministic.js --prompt "Constrained Job Shop Schedule"
 *   node scripts/rescore-deterministic.js --apply --semantic-validators
 *   node scripts/rescore-deterministic.js --apply --all-exact
 */

const mongoose = require('mongoose');
const path = require('path');

process.env.BENCHMARK_ROOT = process.env.BENCHMARK_ROOT || path.resolve(__dirname, '..');

const BenchmarkResult = require('../models/BenchmarkResult');
const qualityScorer = require('../src/services/qualityScorer');
const prompts = require('../data/benchmark-prompts.json');

const args = process.argv.slice(2);
const APPLY = args.includes('--apply');
const ALL_EXACT = args.includes('--all-exact');
const SEMANTIC_VALIDATORS = args.includes('--semantic-validators');
const promptIdx = args.indexOf('--prompt');
const TARGET_PROMPT = promptIdx >= 0 ? args[promptIdx + 1] : null;

const MONGO_URI = process.env.MONGODB_URI || 'mongodb://mongo:27017/agentx';

function promptList() {
    return Array.isArray(prompts) ? prompts : (prompts.prompts || []);
}

function resolvePromptByName(name) {
    return promptList().find(p => (p.name || '').toLowerCase() === String(name || '').toLowerCase());
}

function exactMatchPromptNames() {
    return promptList()
        .filter(p => p.deterministic_scoring && p.deterministic_scoring.type === 'exact')
        .map(p => p.name);
}

function semanticValidatorPromptNames() {
    return promptList()
        .filter(p => p.deterministic_scoring && p.deterministic_scoring.semantic_validator)
        .map(p => p.name);
}

function unique(values) {
    return [...new Set(values.filter(Boolean))];
}

function targetPromptNames() {
    if (TARGET_PROMPT) return [TARGET_PROMPT];
    if (ALL_EXACT) return exactMatchPromptNames();
    if (SEMANTIC_VALIDATORS) return semanticValidatorPromptNames();
    return unique([
        'No-Solution Detection',
        ...semanticValidatorPromptNames()
    ]);
}

function promptForStoredResult(prompt, doc) {
    return {
        ...prompt,
        prompt: doc.prompt || prompt.prompt,
        name: doc.prompt_name || prompt.name,
        level: doc.prompt_level || prompt.level,
        category: doc.prompt_category || prompt.category,
        scoring_type: doc.scoring_type || prompt.scoring_type || prompt.category
    };
}

function buildComposite(result, doc, prompt) {
    return qualityScorer.calculateCompositeScore({
        latency: doc.latency,
        tokens_per_sec: doc.tokens_per_sec,
        time_to_first_token_ms: doc.time_to_first_token_ms,
        performance_baseline: doc.performance_baseline || null,
        quality_score: result.quality_score
    }, doc.prompt_category || prompt.category);
}

function buildUpdate(result, composite, prompt) {
    const scoringType = result.scoring_type || prompt.scoring_type || prompt.category;
    const set = {
        quality_score: result.quality_score,
        quality_breakdown: result.breakdown || null,
        quality_explanation: result.explanation || null,
        judge_prompt: result.judge_prompt || null,
        judge_model: result.judge_model || null,
        judge_raw_response: result.judge_raw_response || null,
        scoring_method: result.scoring_method,
        scoring_type: scoringType,
        scoring_time_ms: result.scoring_time_ms,
        quick_pattern: result.quick_pattern || null,
        deterministic_type: result.deterministic_type || result.method || null,
        matched_expected: result.matched_expected,
        deterministic_score: result.deterministic_score !== undefined ? result.deterministic_score : null,
        deterministic_pass: result.deterministic_pass !== undefined ? result.deterministic_pass : null,
        subjective_score: result.subjective_score !== undefined ? result.subjective_score : null,
        composite_formula: result.composite_formula || 'deterministic_only',
        composite_score: composite.composite_score,
        composite_profile_used: composite.composite_profile_used,
        normalized_scores: composite.normalized,
        semantic_score: result.semantic_score !== undefined ? result.semantic_score : null,
        format_score: result.format_score !== undefined ? result.format_score : null,
        format_compliant: result.format_compliant !== undefined ? result.format_compliant : null,
        format_gated: result.format_gated !== undefined ? result.format_gated : null,
        judge_confidence: result.judge_confidence,
        prompt_complexity: result.prompt_complexity || null,
        needs_review: !!result.needs_review,
        review_reason: result.review_reason || null,
        semantic_validator_backfilled_at: new Date()
    };

    return {
        $set: set,
        $unset: {
            legacy_scoring: ''
        }
    };
}

async function main() {
    await mongoose.connect(MONGO_URI);

    const targetNames = targetPromptNames();
    console.log(`Mode: ${APPLY ? 'APPLY' : 'DRY-RUN'}`);
    console.log(`Targeting prompts: ${targetNames.join(', ')}`);
    console.log('');

    let scanned = 0;
    let changed = 0;
    let unchanged = 0;
    let skipped = 0;

    for (const name of targetNames) {
        const prompt = resolvePromptByName(name);
        if (!prompt) {
            console.log(`! prompt not in benchmark-prompts.json: ${name} (skipping)`);
            continue;
        }

        const cursor = BenchmarkResult.find({
            prompt_name: name,
            success: true,
            response: { $ne: '' },
            quality_score: { $ne: null },
            scoring_method: { $ne: 'pending' },
            excluded_from_leaderboard: { $ne: true },
            human_score: null,
            human_review_status: null
        }).cursor();

        for (let doc = await cursor.next(); doc != null; doc = await cursor.next()) {
            scanned++;
            const before = Number.isFinite(Number(doc.quality_score)) ? Number(doc.quality_score) : null;
            const beforeMethod = doc.scoring_method;
            const promptForScoring = promptForStoredResult(prompt, doc);

            let result;
            try {
                result = await qualityScorer.scoreResponse({
                    response: doc.response,
                    prompt: promptForScoring,
                    skipLLM: true
                });
            } catch (err) {
                console.log(`  x scoring failed for ${doc._id}: ${err.message}`);
                skipped++;
                continue;
            }

            if (result.quality_score == null) {
                skipped++;
                continue;
            }

            const after = Number(result.quality_score);
            if (!Number.isFinite(after)) {
                skipped++;
                continue;
            }

            if (before !== null && after <= before && beforeMethod === result.scoring_method) {
                unchanged++;
                continue;
            }
            if (before !== null && after <= before) {
                unchanged++;
                continue;
            }

            const composite = buildComposite(result, doc, promptForScoring);
            changed++;
            console.log(
                `  + ${String(doc.model).padEnd(32)} ${name.padEnd(34)} `
                + `${String(before ?? 'null').padStart(5)} -> ${String(after).padStart(5)} `
                + `(${beforeMethod || '-'} -> ${result.scoring_method})`
            );

            if (APPLY) {
                await BenchmarkResult.collection.updateOne(
                    { _id: doc._id },
                    buildUpdate(result, composite, promptForScoring)
                );
            }
        }
    }

    console.log('');
    console.log(`scanned:   ${scanned}`);
    console.log(`improved:  ${changed}`);
    console.log(`unchanged: ${unchanged}`);
    console.log(`skipped:   ${skipped}`);
    if (!APPLY && changed > 0) {
        console.log('\n(Dry-run - re-run with --apply to persist.)');
    }

    await mongoose.disconnect();
}

main().catch(err => {
    console.error(err);
    process.exit(1);
});
