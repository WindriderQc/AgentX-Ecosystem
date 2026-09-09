/**
 * Batch Planner
 * Builds execution plans from batch configuration
 */

const { JUDGE_CONFIG } = require('../qualityScorer');
const { normalizeExecutionConfig } = require('./config');
const { executionHost } = require('../../../../shared/benchmarkTargetContract');

/**
 * Build execution plan from batch config
 * Determines host-model mapping, judge hosts, and category distribution
 *
 * @param {string} host - Primary execution host
 * @param {Array} models - Models to benchmark
 * @param {Array} selectedPrompts - Prompts to run
 * @param {Object} options - Plan options
 * @returns {Object} { plan, modelsByHost, normalizedExecutionConfig }
 */
function buildExecutionPlan(host, models, selectedPrompts, options = {}) {
    const { judge_config = {}, execution_config = {}, targets = [] } = options;

    // Group models by host
    const modelsByHost = {};
    const placements = targets.length
        ? targets.map(target => ({ host: executionHost(target), model: target.model }))
        : models.map(model => ({ host, model }));
    for (const { host: targetHost, model } of placements) {
        if (!modelsByHost[targetHost]) modelsByHost[targetHost] = [];
        modelsByHost[targetHost].push(model);
    }

    const normalizedExecConfig = normalizeExecutionConfig(execution_config);
    const repeats = normalizedExecConfig.repeats;
    const targetCount = placements.length;

    const configuredJudgeHost = (judge_config && judge_config.host) ? judge_config.host : host;
    const execHosts = Object.entries(modelsByHost).map(([exec_host, hostModels]) => ({
        exec_host,
        judge_host: configuredJudgeHost,
        models: hostModels,
        tests: hostModels.length * selectedPrompts.length * repeats
    }));

    const categoryCounts = {};
    for (const p of selectedPrompts) {
        const cat = p.category || 'uncategorized';
        categoryCounts[cat] = (categoryCounts[cat] || 0) + 1;
    }

    const categories = Object.entries(categoryCounts)
        .map(([category, prompt_count]) => ({
            category,
            prompt_count,
            tests: prompt_count * targetCount * repeats
        }))
        .sort((a, b) => b.tests - a.tests);

    const totalCategoryPrompts = categories.reduce((sum, c) => sum + (Number(c.prompt_count) || 0), 0);
    const projectedTests = targetCount * totalCategoryPrompts * repeats;

    const plan = {
        exec_hosts: execHosts,
        judge_model: (judge_config && judge_config.model) ? judge_config.model : JUDGE_CONFIG.model,
        judge_num_ctx: (judge_config && judge_config.num_ctx) ? judge_config.num_ctx : (JUDGE_CONFIG.num_ctx || null),
        execution_config: normalizedExecConfig,
        total_models: targetCount,
        total_prompts: selectedPrompts.length,
        categories,
        workload_summary: {
            category_count: categories.length,
            total_category_prompts: totalCategoryPrompts,
            projected_tests: projectedTests
        }
    };

    return { plan, modelsByHost, normalizedExecutionConfig: normalizedExecConfig };
}

module.exports = { buildExecutionPlan };
