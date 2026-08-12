#!/usr/bin/env node
/**
 * TODO 0111 live verification: 2 models × 2 decomposed prompts.
 *
 * Drives decomposed scoring directly against real Ollama judge hosts to verify
 * that:
 *   (a) decomposed_breakdown is persisted on every decomposed row.
 *   (b) judge_confidence distribution across rows is NOT flat at 1.0.
 *
 * This script performs REAL inference calls through Core's inference proxy and
 * writes real BenchmarkResult documents so that Mongo can be queried after.
 */

// Judge calls route through the core inference proxy unconditionally. Lane
// policy (0168 + 0173) puts judge callerDetails on the direct lane so this
// script no longer pays per-call gate overhead.
process.env.MONGODB_URI = process.env.MONGODB_URI || 'mongodb://192.0.2.33:27017/agentx';

const mongoose = require('mongoose');
const { ObjectId } = mongoose.Types;
const fetch = require('node-fetch');

const BenchmarkResult = require('../models/BenchmarkResult');
const { scoreResponse } = require('../src/services/qualityScorer');

const JUDGE_HOST = 'http://192.0.2.99:11434'; // Frank
const JUDGE_MODEL = 'qwen2.5:7b-instruct-q5_K_M';

const MODELS = [
    { host: 'http://192.0.2.99:11434', model: 'gemma4:e4b' },
    { host: 'http://192.0.2.99:11434', model: 'qwen2.5:7b-instruct-q5_K_M' }
];

// Prompt mix chosen to exercise judgeConfidence.assess()'s unreliability
// signals: at least one level-5 prompt so a high score triggers level-vs-score
// mismatch (checkLevelScoreMismatch in judgeConfidence.js). Without a signal,
// a well-differentiated response legitimately stays at confidence 1.0.
const PROMPTS = [
    {
        name: 'Reasoning — Sock Drawer (L2)',
        prompt: 'You have a drawer with 10 black socks and 10 white socks, all mixed up. What is the minimum number of socks you must pull out (without looking) to guarantee you have at least one matching pair? Explain your reasoning step by step.',
        level: 2,
        category: 'reasoning',
        scoring_type: 'reasoning',
        expected_answer: '3 socks — by pigeonhole principle: 2 colors means any 3 draws must contain at least 2 of the same color.'
    },
    {
        // Level 5 — complex multi-part reasoning. If the judge scores this ≥8.5,
        // checkLevelScoreMismatch fires and confidence drops to ~0.75.
        name: 'Reasoning — Knights & Knaves (L5)',
        prompt: 'On an island, knights always tell the truth and knaves always lie. You meet three islanders: A, B, C. A says: "B is a knave." B says: "A and C are the same type." C says: "A is a knight." Determine the type of each islander and explain every logical step, including what happens if you reverse any one assumption. Provide a formal proof-like structure with clearly labeled cases.',
        level: 5,
        category: 'reasoning',
        scoring_type: 'reasoning',
        expected_answer: 'A is knight, B is knave, C is knight. Case analysis: if A is knight → B is knave (lying about A/C sameness) → A and C differ, so C could be knave, but C says A is knight (true) → C is knight. Consistent.'
    }
];

async function generateResponse(host, model, prompt) {
    const res = await fetch(`${host}/api/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            model,
            prompt,
            stream: false,
            options: { temperature: 0.2, num_predict: 600, num_ctx: 4096 }
        }),
        // 2 min per generation is generous for small models on CPU/GPU
        // eslint-disable-next-line no-undef
        signal: AbortSignal.timeout(180000)
    });
    if (!res.ok) throw new Error(`Generate HTTP ${res.status}`);
    const data = await res.json();
    return {
        response: data.response || '',
        tokens: data.eval_count || 0,
        latency_ms: data.total_duration ? Math.round(data.total_duration / 1e6) : 0,
        tokens_per_sec: data.eval_count && data.eval_duration
            ? (data.eval_count / (data.eval_duration / 1e9))
            : 0,
        time_to_first_token_ms: data.prompt_eval_duration
            ? Math.round(data.prompt_eval_duration / 1e6)
            : null
    };
}

async function main() {
    await mongoose.connect(process.env.MONGODB_URI, {
        serverSelectionTimeoutMS: 5000,
        family: 4
    });

    const batchId = new ObjectId().toString();
    console.log(`[verify0111] batch_id=${batchId}`);
    console.log(`[verify0111] judge=${JUDGE_MODEL}@${JUDGE_HOST}`);

    const rows = [];
    for (const { host, model } of MODELS) {
        for (const prompt of PROMPTS) {
            console.log(`\n[verify0111] ${model} × ${prompt.name}`);
            let generated;
            try {
                generated = await generateResponse(host, model, prompt.prompt);
                console.log(`  response chars=${generated.response.length} tokens=${generated.tokens} t/s=${generated.tokens_per_sec.toFixed(1)}`);
            } catch (err) {
                console.error(`  generation failed: ${err.message}`);
                continue;
            }

            if (!generated.response || generated.response.trim().length === 0) {
                console.warn('  empty response — skipping (nothing to score)');
                continue;
            }

            const scoreStart = Date.now();
            const scores = await scoreResponse({
                response: generated.response,
                prompt,
                judgeConfig: {
                    host: JUDGE_HOST,
                    model: JUDGE_MODEL,
                    timeout: 30000,
                    voting_count: 1
                }
            });
            const scoreTime = Date.now() - scoreStart;
            console.log(`  scored in ${scoreTime}ms method=${scores.scoring_method} q=${scores.quality_score} conf=${scores.judge_confidence} reviewReason=${scores.review_reason || '-'}`);

            const doc = new BenchmarkResult({
                batch_id: batchId,
                model,
                host,
                prompt: prompt.prompt,
                prompt_name: prompt.name,
                prompt_level: prompt.level,
                prompt_category: prompt.category,
                expected_answer: prompt.expected_answer,
                response: generated.response,
                latency: generated.latency_ms,
                tokens: generated.tokens,
                tokens_per_sec: generated.tokens_per_sec,
                time_to_first_token_ms: generated.time_to_first_token_ms,
                success: true,
                quality_score: scores.quality_score,
                quality_breakdown: scores.breakdown,
                quality_explanation: scores.explanation,
                judge_model: scores.judge_model,
                judge_host: JUDGE_HOST,
                judge_raw_response: scores.judge_raw_response,
                judge_consensus: scores.judge_consensus || null,
                scoring_method: scores.scoring_method,
                scoring_type: scores.scoring_type,
                scoring_time_ms: scores.scoring_time_ms,
                semantic_score: scores.semantic_score != null ? scores.semantic_score : null,
                format_score: scores.format_score != null ? scores.format_score : null,
                format_compliant: scores.format_compliant != null ? scores.format_compliant : null,
                judge_confidence: scores.judge_confidence,
                prompt_complexity: scores.prompt_complexity,
                needs_review: !!scores.needs_review,
                review_reason: scores.review_reason || null,
                // THE CRITICAL FIELD under test
                decomposed_breakdown: scores.decomposed_breakdown || null
            });

            await doc.save();
            rows.push({
                _id: doc._id.toString(),
                model,
                prompt: prompt.name,
                scoring_method: scores.scoring_method,
                quality_score: scores.quality_score,
                judge_confidence: scores.judge_confidence,
                has_decomposed_breakdown: !!doc.decomposed_breakdown
            });
            console.log(`  persisted _id=${doc._id.toString()}`);
        }
    }

    console.log('\n=== SUMMARY ===');
    console.log(JSON.stringify({ batch_id: batchId, rows }, null, 2));

    // Query back from Mongo to confirm persistence survives Mongoose
    const persistedRows = await BenchmarkResult.find(
        { batch_id: batchId, scoring_method: 'decomposed' },
        { judge_confidence: 1, decomposed_breakdown: 1, quality_score: 1, model: 1, prompt_name: 1 }
    ).lean();

    console.log('\n=== MONGO ROUNDTRIP ===');
    for (const r of persistedRows) {
        const hasBreakdown = r.decomposed_breakdown && typeof r.decomposed_breakdown === 'object'
            && Object.keys(r.decomposed_breakdown).length > 0;
        console.log(
            `_id=${r._id}  model=${r.model}  prompt=${r.prompt_name}  q=${r.quality_score}  ` +
            `conf=${r.judge_confidence}  decomposed_breakdown=${hasBreakdown ? 'present' : 'MISSING'}`
        );
    }

    const confidences = persistedRows.map(r => r.judge_confidence).filter(v => typeof v === 'number');
    if (confidences.length > 0) {
        const min = Math.min(...confidences);
        const max = Math.max(...confidences);
        const mean = confidences.reduce((a, b) => a + b, 0) / confidences.length;
        console.log(`\nconfidence distribution: min=${min} max=${max} mean=${mean.toFixed(3)} n=${confidences.length}`);
        console.log(`NOT flat at 1.0? ${min < 1.0}`);
    }

    await mongoose.disconnect();
    process.exit(0);
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
