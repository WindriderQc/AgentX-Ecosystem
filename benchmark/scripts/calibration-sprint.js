#!/usr/bin/env node
/**
 * Calibration sprint — re-judge the goldset with a given judge and report
 * per-category agreement with the expert scores. Optionally ratify the
 * result as the active CalibrationBaseline (0129 loop).
 *
 *   node scripts/calibration-sprint.js \
 *     [--judge-model=qwen2.5:14b-instruct-q4_K_M] [--judge-host=http://192.0.2.12:11434] \
 *     [--category=math] [--limit=N] [--no-config] [--materialize-config] \
 *     [--stamp] [--ratify] [--label=baseline-2026-06-12]
 *
 * Default judge: the env-resolved JUDGE_CONFIG (JUDGE_MODEL/JUDGE_HOST).
 * --stamp   updates judge_score_at_review + reviewed_at on the Mongo
 *           ground-truth entries that were scored (config-goldset entries are
 *           file-based unless --materialize-config is also passed). This is
 *           what the drift endpoint reads, so stamping aligns "current ρ"
 *           with this sprint.
 * --materialize-config
 *           with --stamp, upserts scored config-goldset anchors into Mongo
 *           using their stable config-goldset-* names so drift can read the
 *           same anchors as this sprint. Existing Mongo rows win on future
 *           loadUnionedGoldset() calls.
 * --ratify  ratifies a CalibrationBaseline from this sprint's stats.
 *
 * Run inside the benchmark container:
 *   docker exec agentx-benchmark node scripts/calibration-sprint.js
 */

require('dotenv').config({ path: __dirname + '/../.env' });
const mongoose = require('mongoose');
const JudgeGroundTruth = require('../models/JudgeGroundTruth');
const { loadUnionedGoldset } = require('../src/services/benchmark/retroCalibration');
const { runCalibrationBatch } = require('../src/services/benchmark/calibrationRunner');
const { ratifyBaseline } = require('../src/services/benchmark/judgeDriftService');
const { calculatePearsonCorrelation } = require('../src/services/judgeValidationHelpers');
const { resolveJudgeConfig } = require('../src/services/scoring/resolveJudgeConfig');

const CONFIG_GOLDSET_MATERIALIZATION_SOURCE = 'human-validation-sprint-2026-07-02-config-goldset';

function parseArgs(argv) {
    const args = { flags: {}, values: {} };
    for (const a of argv.slice(2)) {
        const m = a.match(/^--([^=]+)(?:=(.*))?$/);
        if (!m) continue;
        if (m[2] === undefined) args.flags[m[1]] = true;
        else args.values[m[1]] = m[2];
    }
    return args;
}

function fmt(n, d = 3) { return n == null || Number.isNaN(n) ? '—' : Number(n).toFixed(d); }

async function main() {
    const { flags, values } = parseArgs(process.argv);

    const judgeConfig = resolveJudgeConfig({
        ...(values['judge-model'] ? { model: values['judge-model'] } : {}),
        ...(values['judge-host'] ? { host: values['judge-host'] } : {})
    });

    await mongoose.connect(process.env.MONGODB_URI || 'mongodb://mongo:27017/agentx');

    let entries = await loadUnionedGoldset({
        includeConfig: !flags['no-config'],
        includeHuman: true,
        category: values.category || null
    });
    if (values.limit) entries = entries.slice(0, parseInt(values.limit, 10));

    console.log(`Calibration sprint — judge ${judgeConfig.model} @ ${judgeConfig.host}`);
    console.log(`Goldset entries: ${entries.length} (config + human union)\n`);

    const started = Date.now();
    const scored = await runCalibrationBatch(entries, judgeConfig);
    const elapsed = ((Date.now() - started) / 1000).toFixed(0);

    // Pair fresh judge scores with expert scores.
    const pairs = [];
    for (let i = 0; i < entries.length; i++) {
        const e = entries[i];
        const s = scored[i];
        const human = e.expert_scores?.overall;
        if (s.score === null || human === null || human === undefined) continue;
        pairs.push({
            id: e._id, name: e.name, category: e.category, difficulty: e.difficulty,
            human, judge: s.score, dev: Math.abs(s.score - human),
            isMongo: !String(e._id).startsWith('cfg-'),
            entry: e
        });
    }
    const errors = scored.filter(s => s.error).length;

    // Per-category stats.
    const cats = [...new Set(pairs.map(p => p.category))].sort();
    const categories = [];
    console.log('category     |  n | rho    | mae   | bias   ');
    console.log('-------------|----|--------|-------|--------');
    for (const cat of cats) {
        const rows = pairs.filter(p => p.category === cat);
        const j = rows.map(r => r.judge);
        const h = rows.map(r => r.human);
        const rho = rows.length >= 2 ? calculatePearsonCorrelation(j, h) : null;
        const mae = rows.reduce((a, r) => a + r.dev, 0) / rows.length;
        const bias = rows.reduce((a, r) => a + (r.judge - r.human), 0) / rows.length;
        categories.push({
            category: cat,
            rho: rho === null ? null : Number(rho.toFixed(3)),
            sample_size: rows.length,
            mae: Number(mae.toFixed(2)),
            bias: Number(bias.toFixed(2))
        });
        console.log(`${cat.padEnd(13)}| ${String(rows.length).padStart(2)} | ${fmt(rho).padEnd(6)} | ${fmt(mae, 2).padEnd(5)} | ${fmt(bias, 2)}`);
    }
    const overallRho = pairs.length >= 2
        ? Number(calculatePearsonCorrelation(pairs.map(p => p.judge), pairs.map(p => p.human)).toFixed(3))
        : null;
    console.log(`\noverall rho: ${fmt(overallRho)} on ${pairs.length} pairs (${errors} scoring errors, ${elapsed}s)`);

    // Worst anchors.
    const worst = [...pairs].sort((a, b) => b.dev - a.dev).slice(0, 8);
    console.log('\nWorst anchors (|judge - human|):');
    for (const w of worst) {
        console.log(`  ${fmt(w.dev, 1)}  ${w.category}/L${w.difficulty}  judge=${fmt(w.judge, 1)} human=${fmt(w.human, 1)}  ${w.name}`);
    }

    if (flags['materialize-config'] && !flags.stamp) {
        console.warn('\n--materialize-config requires --stamp so persisted rows match a fresh judge run; skipping materialization.');
    }

    if (flags.stamp) {
        let stamped = 0;
        for (const p of pairs.filter(p => p.isMongo)) {
            await JudgeGroundTruth.updateOne(
                { _id: p.id },
                { $set: { judge_score_at_review: p.judge, reviewed_at: new Date() } }
            );
            stamped++;
        }
        console.log(`\nStamped judge_score_at_review on ${stamped} Mongo entries.`);

        if (flags['materialize-config']) {
            const reviewedAt = new Date();
            let materialized = 0;
            for (const p of pairs.filter(p => !p.isMongo && p.entry?.source === 'config-goldset')) {
                const e = p.entry;
                await JudgeGroundTruth.updateOne(
                    { name: e.name },
                    {
                        $set: {
                            prompt: e.prompt,
                            response: e.response,
                            category: e.category,
                            expected_answer: e.expected_answer || null,
                            expert_scores: {
                                overall: p.human,
                                dimensions: {}
                            },
                            expert_rationale: e.expert_rationale || e._config_notes || `Config goldset anchor ${e.name} materialized for drift calibration.`,
                            created_by: 'calibration-sprint',
                            source: CONFIG_GOLDSET_MATERIALIZATION_SOURCE,
                            reviewed_at: reviewedAt,
                            judge_score_at_review: p.judge,
                            difficulty: e.difficulty || 3,
                            tags: ['config-goldset', 'drift-anchor', 'judge-0321'],
                            active: true
                        }
                    },
                    { upsert: true }
                );
                materialized++;
            }
            console.log(`Materialized ${materialized} config-goldset entries into JudgeGroundTruth.`);
        }
    }

    if (flags.ratify) {
        const label = values.label || `baseline-${new Date().toISOString().slice(0, 10)}-${judgeConfig.model.replace(/[^a-zA-Z0-9.:-]/g, '_')}`;
        const doc = await ratifyBaseline({
            label,
            source_sprint: `calibration-sprint ${new Date().toISOString()}`,
            categories,
            overall_rho: overallRho,
            overall_sample_size: pairs.length,
            notes: `Ratified from calibration-sprint.js with judge ${judgeConfig.model} @ ${judgeConfig.host}; ${pairs.length} pairs, ${errors} errors.`
        });
        console.log(`\nRatified baseline "${doc.label}" (active).`);
    }

    await mongoose.disconnect();
}

main().catch(err => {
    console.error('calibration-sprint failed:', err);
    process.exit(1);
});
