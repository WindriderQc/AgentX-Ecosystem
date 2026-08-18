'use strict';

const logger = require('../../../config/logger');
const profilerOrchestrator = require('../profiler/profilerOrchestrator');
const { activeProfiles } = require('../profiler/activeProfileState');

const PROFILE_ALLOWANCE_MS = 20 * 60 * 1000;

function executionModelsFromHostGroups(hostGroups) {
    return hostGroups.flatMap(([host, models]) => models.map(model => ({
        name: typeof model === 'string' ? model : model.name || model,
        host,
        hostUrl: host
    })));
}

async function checkBatchPreflight({ batchId, executionModels, setBatchPhase }) {
    if (executionModels.length === 0) {
        logger.info('Profiler preflight skipped: checkpoint has no pending model blocks', { batchId });
        return null;
    }
    await setBatchPhase(
        'profiling',
        `Profiler preflight: validating profiles for ${executionModels.length} model(s)…`
    );
    const result = await profilerOrchestrator.preflight({ models: executionModels });
    if (result.warnings.length) {
        logger.warn('Profiler preflight warnings', { warnings: result.warnings });
    }
    return result;
}

function preflightCounts(preflightResult) {
    const profileCount = preflightResult?.profilesNeeded?.length || 0;
    return {
        profileCount,
        allowanceMs: profileCount * PROFILE_ALLOWANCE_MS
    };
}

async function runBatchPreflight({
    preflightResult,
    batchId,
    defaultHost,
    setBatchPhase,
    recordBatchTimelineEvent
}) {
    const { profileCount } = preflightCounts(preflightResult);
    if (!profileCount) return;

    await setBatchPhase(
        'profiling',
        `Preflight: profiling ${profileCount} exact artifact(s)…`
    );
    logger.info('Profiler preflight: recording exact-artifact evidence under batch claim', {
        batchId,
        profilesNeeded: profileCount
    });
    const preflightWork = [
        ...preflightResult.profilesNeeded
    ];
    const trackerId = `preflight-${batchId}`;
    const tracker = {
        status: 'running',
        source: 'benchmark-preflight',
        batchId,
        modelName: `preflight: ${preflightWork.map(model => model.name).join(', ')}`,
        hostId: preflightWork[0]?.host || null,
        hostUrl: preflightWork[0]?.hostUrl || defaultHost,
        depth: 'standard',
        currentStep: 'preflight',
        statusMessage: 'Benchmark preflight profiling…',
        stepsCompleted: 0,
        stepsTotal: preflightWork.length,
        steps: preflightWork.map(model => model.name),
        metrics: {},
        startedAt: Date.now(),
        result: null,
        error: null
    };
    activeProfiles.set(trackerId, tracker);
    try {
        const hostMap = { [defaultHost]: defaultHost };
        const onEvent = async (event, payload) => {
            tracker.stepsCompleted = Math.min(tracker.stepsCompleted + 1, tracker.stepsTotal);
            tracker.statusMessage = `Preflight: ${payload?.model || event}`;
            return recordBatchTimelineEvent(event, payload);
        };
        await profilerOrchestrator.runPreflight(preflightResult, hostMap, { onEvent });
        tracker.status = 'completed';
    } catch (error) {
        tracker.status = 'failed';
        tracker.error = error.message;
        logger.error('Profiler preflight run failed; benchmark is blocked', {
            batchId,
            error: error.message
        });
        throw error;
    } finally {
        activeProfiles.delete(trackerId);
    }
}

module.exports = {
    checkBatchPreflight,
    executionModelsFromHostGroups,
    preflightCounts,
    runBatchPreflight
};
