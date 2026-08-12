#!/usr/bin/env node

const path = require('path');

const {
    loadCalibrationSet,
    validateCalibrationSet,
    evaluateCalibrationCase,
    summarizeCalibrationResults
} = require(path.resolve(__dirname, '../../src/services/benchmark/judgeCalibration'));

const GATES = {
    minToleranceRate: Number(process.env.CAL_MIN_TOLERANCE_RATE || 75),
    minReviewMatchRate: Number(process.env.CAL_MIN_REVIEW_MATCH_RATE || 75),
    maxMae: Number(process.env.CAL_MAX_MAE || 1.5)
};

async function runCalibration({ judgeConfig, scoreResponseFn = null, goldsetPath = undefined } = {}) {
    const scoreResponse = scoreResponseFn
        || require(path.resolve(__dirname, '../../src/services/qualityScorer')).scoreResponse;
    const { SCORER_VERSION } = require(path.resolve(__dirname, '../../src/services/scoring/scorerVersion'));

    const goldset = loadCalibrationSet(goldsetPath);
    validateCalibrationSet(goldset);

    const results = [];
    for (const entry of goldset) {
        const actual = await scoreResponse({
            response: entry.response,
            prompt: {
                name: entry.name,
                prompt: entry.prompt,
                category: entry.category,
                scoring_type: entry.category,
                expected_answer: entry.expected_answer,
                level: entry.difficulty || 3,
                judge_criteria: Array.isArray(entry.judge_criteria) ? entry.judge_criteria : []
            },
            judgeConfig
        });
        results.push(evaluateCalibrationCase(entry, actual));
    }

    return {
        scorer_version: SCORER_VERSION,
        judge: judgeConfig || {},
        summary: summarizeCalibrationResults(results),
        results
    };
}

function applyGates(summary, gates = GATES) {
    const failures = [];
    if (summary.tolerance_rate < gates.minToleranceRate) {
        failures.push(`tolerance_rate ${summary.tolerance_rate}% < ${gates.minToleranceRate}%`);
    }
    if (summary.review_match_rate < gates.minReviewMatchRate) {
        failures.push(`review_match_rate ${summary.review_match_rate}% < ${gates.minReviewMatchRate}%`);
    }
    if (summary.mae === null || summary.mae > gates.maxMae) {
        failures.push(`mae ${summary.mae} > ${gates.maxMae}`);
    }
    return { pass: failures.length === 0, failures };
}

async function main() {
    const judgeHost = process.env.JUDGE_HOST || process.env.OLLAMA_HOST;
    const judgeModel = process.env.JUDGE_MODEL;
    if (!judgeHost) {
        console.error('JUDGE_HOST or OLLAMA_HOST is required');
        process.exit(2);
    }

    const run = await runCalibration({
        judgeConfig: {
            host: judgeHost,
            ...(judgeModel ? { model: judgeModel } : {})
        }
    });
    const gate = applyGates(run.summary);

    console.log(`Judge Calibration Gate - scorer ${run.scorer_version}`);
    console.log(JSON.stringify({ summary: run.summary, gates: GATES, gate }, null, 2));
    if (!gate.pass) {
        process.exit(1);
    }
}

if (require.main === module) {
    main().catch((error) => {
        console.error(`judge-calibration-gate failed: ${error.message}`);
        process.exit(2);
    });
}

module.exports = { runCalibration, applyGates, GATES };
