#!/usr/bin/env node
/**
 * AC6 Re-run — Cross-rep variance audit for corpus 0127 (2026-04-20).
 *
 * The original AC6 audit in docs/benchmark/corpus-2026-04-20.md grouped by
 * prompt only, which pooled cross-model variance with cross-rep variance.
 * The real audit question is: for each (model, prompt) pair, what is the
 * cross-rep stdev of composite_score and quality_score?
 *
 * Usage:   node scripts/corpus-0127-ac6-rerun.js
 */

'use strict';

const path = require('path');

// Try to load mongoose from core first, then fall back to benchmark.
let mongoose;
try {
    mongoose = require(path.resolve(__dirname, '../../core/node_modules/mongoose'));
} catch (_err) {
    mongoose = require(path.resolve(__dirname, '../node_modules/mongoose'));
}

const MONGO_URI = 'mongodb://192.0.2.33:27017/agentx';

// 15 batches from docs/benchmark/corpus-2026-04-20.md
const BATCH_IDS = [
    '69e5a5709515e18e69a85e11', // gemma4@ClawdX rep1
    '69e5a6ab9515e18e69a86294', // gemma4@Brutal rep1
    '69e5a72e9515e18e69a86674', // qwen2.5@Frank rep1
    '69e5a7b19515e18e69a86a92', // qwen2.5-coder@Brutal rep1
    '69e5a8169515e18e69a86e44', // dolphin-phi@Frank rep1
    '69e5a87c9515e18e69a872ee', // gemma4@ClawdX rep2
    '69e5a93e9515e18e69a87653', // gemma4@Brutal rep2
    '69e5a9c19515e18e69a87a23', // qwen2.5@Frank rep2
    '69e5aa449515e18e69a87e00', // qwen2.5-coder@Brutal rep2
    '69e5aaaa9515e18e69a881cb', // dolphin-phi@Frank rep2
    '69e5ab0f9515e18e69a88648', // gemma4@ClawdX rep3
    '69e5ac2c9515e18e69a88a6b', // gemma4@Brutal rep3
    '69e5acb79515e18e69a88e48', // qwen2.5@Frank rep3
    '69e5ad3a9515e18e69a892bf', // qwen2.5-coder@Brutal rep3
    '69e5ada09515e18e69a896aa'  // dolphin-phi@Frank rep3
];

const COMPOSITE_THRESHOLD = 10.0;
const QUALITY_THRESHOLD = 2.0;

function mean(values) {
    if (values.length === 0) return null;
    let s = 0;
    for (const v of values) s += v;
    return s / values.length;
}

function stdev(values) {
    if (values.length < 2) return 0;
    const m = mean(values);
    let ss = 0;
    for (const v of values) ss += (v - m) * (v - m);
    // population stdev (matches what mongo $stdDevPop would yield)
    return Math.sqrt(ss / values.length);
}

function fmt(n, d = 2) {
    if (n === null || n === undefined || Number.isNaN(n)) return '—';
    return Number(n).toFixed(d);
}

(async () => {
    await mongoose.connect(MONGO_URI);
    const db = mongoose.connection.db;
    const coll = db.collection('benchmarkresults');

    const objectIds = BATCH_IDS.map((id) => new mongoose.Types.ObjectId(id));

    const rows = await coll.find({
        batch_id: { $in: objectIds }
    }, {
        projection: {
            _id: 1,
            batch_id: 1,
            model: 1,
            prompt_name: 1,
            prompt_category: 1,
            composite_score: 1,
            quality_score: 1,
            success: 1,
            infra_error: 1
        }
    }).toArray();

    console.log(`Rows pulled: ${rows.length} (expected 315)`);

    // Group by (model, prompt_name)
    const groups = new Map();
    for (const r of rows) {
        const key = `${r.model}||${r.prompt_name || '<null>'}`;
        if (!groups.has(key)) {
            groups.set(key, {
                model: r.model,
                prompt_name: r.prompt_name,
                prompt_category: r.prompt_category,
                composites: [],
                qualities: []
            });
        }
        const g = groups.get(key);
        if (typeof r.composite_score === 'number') g.composites.push(r.composite_score);
        if (typeof r.quality_score === 'number') g.qualities.push(r.quality_score);
    }

    const summaries = [];
    for (const g of groups.values()) {
        const compMean = mean(g.composites);
        const compStdev = stdev(g.composites);
        const qualMean = mean(g.qualities);
        const qualStdev = stdev(g.qualities);
        const n = Math.max(g.composites.length, g.qualities.length);
        summaries.push({
            model: g.model,
            prompt_name: g.prompt_name,
            prompt_category: g.prompt_category,
            n,
            compMean,
            compStdev,
            qualMean,
            qualStdev,
            flaggedComposite: compStdev > COMPOSITE_THRESHOLD,
            flaggedQuality: qualStdev > QUALITY_THRESHOLD,
            flagged: compStdev > COMPOSITE_THRESHOLD || qualStdev > QUALITY_THRESHOLD
        });
    }

    summaries.sort((a, b) => (b.qualStdev || 0) - (a.qualStdev || 0));

    const total = summaries.length;
    const flagged = summaries.filter((s) => s.flagged);
    const flaggedQualityOnly = summaries.filter((s) => s.flaggedQuality);
    const flaggedCompositeOnly = summaries.filter((s) => s.flaggedComposite);
    const nDist = summaries.reduce((m, s) => {
        m[s.n] = (m[s.n] || 0) + 1;
        return m;
    }, {});

    console.log('\n=== AC6 Re-run Summary ===');
    console.log(`Total (model, prompt) pairs: ${total}`);
    console.log(`Group-size distribution:     ${JSON.stringify(nDist)}`);
    console.log(`Flagged (quality stdev > ${QUALITY_THRESHOLD}):   ${flaggedQualityOnly.length}`);
    console.log(`Flagged (composite stdev > ${COMPOSITE_THRESHOLD}):${flaggedCompositeOnly.length}`);
    console.log(`Flagged (either threshold):  ${flagged.length}`);
    const pct = total > 0 ? (flaggedQualityOnly.length / total) * 100 : 0;
    console.log(`Quality-threshold flagged %: ${pct.toFixed(1)}%`);
    console.log(`Verdict (contract-spec stdev(quality) > ${QUALITY_THRESHOLD}): ${pct < 10 ? 'PASS' : 'FAIL'}`);

    if (flagged.length > 0) {
        console.log('\n=== Flagged (model, prompt) pairs — sorted by stdev(quality) desc ===');
        const header = ['Model', 'Prompt', 'n', 'stdev(qual)', 'stdev(comp)', 'mean(qual)', 'mean(comp)'];
        console.log(header.join(' | '));
        console.log(header.map(() => '---').join(' | '));
        for (const s of flagged) {
            console.log([
                s.model,
                s.prompt_name,
                s.n,
                fmt(s.qualStdev, 3),
                fmt(s.compStdev, 2),
                fmt(s.qualMean, 2),
                fmt(s.compMean, 2)
            ].join(' | '));
        }
    }

    console.log('\n=== Top 10 by stdev(quality) ===');
    for (const s of summaries.slice(0, 10)) {
        console.log([
            s.model,
            s.prompt_name,
            `n=${s.n}`,
            `qσ=${fmt(s.qualStdev, 3)}`,
            `cσ=${fmt(s.compStdev, 2)}`,
            `qμ=${fmt(s.qualMean, 2)}`,
            `cμ=${fmt(s.compMean, 2)}`,
            s.flagged ? 'FLAG' : ''
        ].join(' | '));
    }

    await mongoose.disconnect();
})().catch((err) => {
    console.error(err);
    process.exit(1);
});
