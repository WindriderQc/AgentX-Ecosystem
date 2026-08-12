/**
 * Regression Detector (paired, version-gated)
 * ===========================================
 *
 * Compares benchmark batches by pairing scores on the same
 * (model, host, prompt_name). This avoids false regressions when a newer batch
 * simply ran a harder prompt mix. It also labels comparisons across different
 * scorer versions because score shifts may reflect the instrument, not models.
 */

const logger = require('../../../config/logger');
const mongoose = require('mongoose');
const BenchmarkResult = require('../../../models/BenchmarkResult');
const BenchmarkBatch = require('../../../models/BenchmarkBatch');
const { confidenceMargin } = require('./generalistScore');
const { versionsComparable } = require('../scoring/scorerVersion');

const REGRESSION_THRESHOLD = 5;
const IMPROVEMENT_THRESHOLD = 5;
const MIN_PAIRED_PROMPTS = 3;
const MIN_CATEGORY_PAIRS = 2;

const round1 = (value) => Math.round(value * 10) / 10;

function toBatchObjectId(batchId) {
    return mongoose.Types.ObjectId.isValid(batchId)
        ? new mongoose.Types.ObjectId(batchId)
        : batchId;
}

async function getBatchPromptScores(batchId) {
    const batchOid = toBatchObjectId(batchId);
    const rows = await BenchmarkResult.aggregate([
        { $match: { batch_id: batchOid, success: true, quality_score: { $ne: null } } },
        {
            $group: {
                _id: {
                    model: '$model',
                    host: '$host',
                    prompt_name: '$prompt_name',
                    category: '$prompt_category'
                },
                avg_quality: { $avg: '$quality_score' }
            }
        }
    ]);

    const map = new Map();
    for (const row of rows) {
        const key = `${row._id.model}@@${row._id.host || ''}`;
        if (!map.has(key)) {
            map.set(key, {
                model: row._id.model,
                host: row._id.host || null,
                prompts: {},
                _sum: 0,
                count: 0
            });
        }
        const entry = map.get(key);
        const promptName = row._id.prompt_name || `__unnamed_${entry.count}`;
        entry.prompts[promptName] = {
            q: row.avg_quality,
            category: row._id.category || null
        };
        entry._sum += row.avg_quality;
        entry.count += 1;
    }

    for (const entry of map.values()) {
        entry.avg_quality = entry.count > 0 ? entry._sum / entry.count : 0;
        delete entry._sum;
    }
    return map;
}

async function getBatchScorerVersions(batchId) {
    const versions = await BenchmarkResult.distinct('scorer_version', { batch_id: toBatchObjectId(batchId) });
    return versions.map((value) => value || null);
}

function assessComparability(currentVersions, previousVersions) {
    const warnings = [];
    const unique = (values) => [...new Set(values || [])];
    const cur = unique(currentVersions);
    const prev = unique(previousVersions);

    if (cur.length > 1) warnings.push(`Current batch mixes scorer versions: ${cur.join(', ')}`);
    if (prev.length > 1) warnings.push(`Previous batch mixes scorer versions: ${prev.join(', ')}`);

    const curVersion = cur[0] ?? null;
    const prevVersion = prev[0] ?? null;
    let comparable = false;

    if (curVersion === null && prevVersion === null) {
        comparable = true;
        warnings.push('Both batches predate scorer versioning; comparability assumed');
    } else if (curVersion === null || prevVersion === null) {
        warnings.push('One batch is unversioned and the other is versioned');
    } else {
        comparable = versionsComparable(curVersion, prevVersion);
        if (!comparable) {
            warnings.push(`Scorer versions differ (${prevVersion} -> ${curVersion})`);
        }
    }

    return {
        comparable: comparable && cur.length <= 1 && prev.length <= 1,
        current_versions: cur,
        previous_versions: prev,
        warnings
    };
}

function avgOf(prompts) {
    const values = Object.values(prompts || {});
    if (values.length === 0) return 0;
    return values.reduce((sum, value) => sum + value.q, 0) / values.length;
}

function pairedModelCompare(currentEntry, previousEntry) {
    const curPrompts = currentEntry.prompts || {};
    const prevPrompts = previousEntry.prompts || {};
    const shared = Object.keys(curPrompts).filter((name) => prevPrompts[name] !== undefined);

    if (shared.length < MIN_PAIRED_PROMPTS) {
        const cur = (currentEntry.avg_quality ?? avgOf(curPrompts)) * 10;
        const prev = (previousEntry.avg_quality ?? avgOf(prevPrompts)) * 10;
        return {
            method: 'unpaired_low_confidence',
            n_pairs: shared.length,
            meanDelta: round1(cur - prev),
            ci_margin: null,
            significant: false,
            previous: round1(prev),
            current: round1(cur),
            categoryDeltas: []
        };
    }

    const deltas = [];
    let curSum = 0;
    let prevSum = 0;
    const byCategory = {};

    for (const name of shared) {
        const current = curPrompts[name].q * 10;
        const previous = prevPrompts[name].q * 10;
        const delta = current - previous;
        deltas.push(delta);
        curSum += current;
        prevSum += previous;

        const category = curPrompts[name].category || prevPrompts[name].category || 'uncategorized';
        if (!byCategory[category]) byCategory[category] = { deltas: [], curSum: 0, prevSum: 0 };
        byCategory[category].deltas.push(delta);
        byCategory[category].curSum += current;
        byCategory[category].prevSum += previous;
    }

    const n = deltas.length;
    const meanDelta = deltas.reduce((sum, value) => sum + value, 0) / n;
    const variance = n > 1
        ? deltas.reduce((sum, value) => sum + ((value - meanDelta) ** 2), 0) / (n - 1)
        : 0;
    const margin = confidenceMargin(Math.sqrt(variance), n);
    const significant = margin !== null && Math.abs(meanDelta) > margin;

    const categoryDeltas = Object.entries(byCategory)
        .filter(([, value]) => value.deltas.length >= MIN_CATEGORY_PAIRS)
        .map(([category, value]) => ({
            category,
            n: value.deltas.length,
            meanDelta: round1(value.deltas.reduce((sum, delta) => sum + delta, 0) / value.deltas.length),
            previous: round1(value.prevSum / value.deltas.length),
            current: round1(value.curSum / value.deltas.length)
        }));

    return {
        method: 'paired',
        n_pairs: n,
        meanDelta: round1(meanDelta),
        ci_margin: margin === null ? null : round1(margin),
        significant,
        previous: round1(prevSum / n),
        current: round1(curSum / n),
        categoryDeltas
    };
}

async function compareBatchRegression(currentBatchId, previousBatchId) {
    const [currentStats, previousStats, currentBatch, previousBatch, curVersions, prevVersions] = await Promise.all([
        getBatchPromptScores(currentBatchId),
        getBatchPromptScores(previousBatchId),
        BenchmarkBatch.findById(currentBatchId).select('run_name created_at completed_at').lean(),
        BenchmarkBatch.findById(previousBatchId).select('run_name created_at completed_at').lean(),
        getBatchScorerVersions(currentBatchId),
        getBatchScorerVersions(previousBatchId)
    ]);

    const comparability = assessComparability(curVersions, prevVersions);
    const regressions = [];
    const improvements = [];
    const stable = [];
    const newModels = [];
    const removedModels = [];
    const categoryChanges = [];

    for (const [key, current] of currentStats) {
        const previous = previousStats.get(key);

        if (!previous) {
            newModels.push({ model: current.model, host: current.host, avg_quality: round1(current.avg_quality) });
            continue;
        }

        const cmp = pairedModelCompare(current, previous);
        const confidence = !comparability.comparable
            ? 'low'
            : (cmp.method === 'paired' ? (cmp.significant ? 'high' : 'medium') : 'low');

        const entry = {
            model: current.model,
            host: current.host,
            previous: cmp.previous,
            current: cmp.current,
            delta: cmp.meanDelta,
            n_pairs: cmp.n_pairs,
            ci_margin: cmp.ci_margin,
            significant: cmp.significant,
            method: cmp.method,
            confidence
        };

        const isRegression = cmp.meanDelta <= -REGRESSION_THRESHOLD && cmp.significant && comparability.comparable;
        const isImprovement = cmp.meanDelta >= IMPROVEMENT_THRESHOLD && cmp.significant && comparability.comparable;

        if (isRegression) {
            regressions.push(entry);
        } else if (isImprovement) {
            improvements.push(entry);
        } else {
            stable.push({
                model: current.model,
                host: current.host,
                score: cmp.current,
                delta: cmp.meanDelta,
                n_pairs: cmp.n_pairs,
                method: cmp.method
            });
        }

        for (const cat of cmp.categoryDeltas) {
            if (Math.abs(cat.meanDelta) >= REGRESSION_THRESHOLD && comparability.comparable) {
                categoryChanges.push({
                    model: current.model,
                    host: current.host,
                    category: cat.category,
                    previous: cat.previous,
                    current: cat.current,
                    delta: cat.meanDelta,
                    n_pairs: cat.n,
                    type: cat.meanDelta < 0 ? 'regression' : 'improvement'
                });
            }
        }
    }

    for (const [, previous] of previousStats) {
        const key = `${previous.model}@@${previous.host || ''}`;
        if (!currentStats.has(key)) {
            removedModels.push({ model: previous.model, host: previous.host, avg_quality: round1(previous.avg_quality) });
        }
    }

    regressions.sort((a, b) => a.delta - b.delta);
    improvements.sort((a, b) => b.delta - a.delta);

    if (!comparability.comparable) {
        logger.warn('Batch comparison across incomparable scorer versions', {
            currentBatchId,
            previousBatchId,
            ...comparability
        });
    }

    return {
        currentBatch: {
            id: currentBatchId,
            name: currentBatch?.run_name,
            date: currentBatch?.completed_at || currentBatch?.created_at
        },
        previousBatch: {
            id: previousBatchId,
            name: previousBatch?.run_name,
            date: previousBatch?.completed_at || previousBatch?.created_at
        },
        comparability,
        summary: {
            regressions: regressions.length,
            improvements: improvements.length,
            stable: stable.length,
            newModels: newModels.length,
            removedModels: removedModels.length,
            categoryChanges: categoryChanges.length,
            method: 'paired_v2'
        },
        regressions,
        improvements,
        stable,
        newModels,
        removedModels,
        categoryChanges
    };
}

async function detectLatestRegression() {
    const batches = await BenchmarkBatch.find({ status: 'completed' })
        .sort({ completed_at: -1 })
        .limit(2)
        .select('_id')
        .lean();

    if (batches.length < 2) {
        return null;
    }

    return compareBatchRegression(
        batches[0]._id.toString(),
        batches[1]._id.toString()
    );
}

function generateChangelog(report) {
    const lines = [];
    lines.push('## Benchmark Changelog');
    lines.push(`**${report.currentBatch.name || report.currentBatch.id}** vs **${report.previousBatch.name || report.previousBatch.id}**\n`);

    if (report.comparability && !report.comparability.comparable) {
        lines.push(`> **WARNING - incomparable scorer versions.** ${report.comparability.warnings.join(' ')}`);
        lines.push('> No regression/improvement verdicts are issued for this pair.\n');
    }

    if (report.regressions.length > 0) {
        lines.push('### Regressions');
        for (const r of report.regressions) {
            lines.push(`- **${r.model}**: ${r.previous} -> ${r.current} (${r.delta > 0 ? '+' : ''}${r.delta}, n=${r.n_pairs}, CI +/-${r.ci_margin})`);
        }
        lines.push('');
    }

    if (report.improvements.length > 0) {
        lines.push('### Improvements');
        for (const r of report.improvements) {
            lines.push(`- **${r.model}**: ${r.previous} -> ${r.current} (+${r.delta}, n=${r.n_pairs}, CI +/-${r.ci_margin})`);
        }
        lines.push('');
    }

    if (report.newModels.length > 0) {
        lines.push('### New Models');
        for (const m of report.newModels) {
            lines.push(`- **${m.model}**: ${(m.avg_quality * 10).toFixed(1)}`);
        }
        lines.push('');
    }

    if (report.removedModels.length > 0) {
        lines.push('### Removed Models');
        for (const m of report.removedModels) {
            lines.push(`- ${m.model}`);
        }
        lines.push('');
    }

    if (report.categoryChanges.length > 0) {
        lines.push('### Category Changes');
        for (const c of report.categoryChanges) {
            const icon = c.type === 'regression' ? 'DOWN' : 'UP';
            lines.push(`- ${c.model} / ${c.category}: ${c.previous} -> ${c.current} (${icon} ${c.delta > 0 ? '+' : ''}${c.delta}, n=${c.n_pairs})`);
        }
        lines.push('');
    }

    if (report.summary.regressions === 0 && report.summary.improvements === 0) {
        lines.push('No significant changes detected. All models stable.\n');
    }

    return lines.join('\n');
}

module.exports = {
    REGRESSION_THRESHOLD,
    IMPROVEMENT_THRESHOLD,
    MIN_PAIRED_PROMPTS,
    MIN_CATEGORY_PAIRS,
    compareBatchRegression,
    detectLatestRegression,
    generateChangelog,
    pairedModelCompare,
    assessComparability,
    getBatchPromptScores,
    getBatchScorerVersions
};
