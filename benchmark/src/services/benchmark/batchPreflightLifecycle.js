'use strict';

const logger = require('../../../config/logger');
const profilerOrchestrator = require('../profiler/profilerOrchestrator');
const { activeProfiles } = require('../profiler/activeProfileState');

const PROFILE_ALLOWANCE_MS = 20 * 60 * 1000;
const ADAPT_ALLOWANCE_MS = 2 * 60 * 1000;

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
    if (process.env.BENCHMARK_ALLOW_UNPROFILED === 'true') {
        logger.info('Profiler preflight skipped (BENCHMARK_ALLOW_UNPROFILED=true)');
        return null;
    }

    await setBatchPhase(
        'profiling',
        `Profiler preflight: validating profiles for ${executionModels.length} model(s)…`
    );
    try {
        const result = await profilerOrchestrator.preflight({ models: executionModels });
        if (result.warnings.length) {
            logger.warn('Profiler preflight warnings', { warnings: result.warnings });
        }
        return result;
    } catch (error) {
        logger.warn('Profiler preflight check failed — continuing with existing config', {
            error: error.message
        });
        return null;
    }
}

function preflightCounts(preflightResult) {
    const profileCount = preflightResult?.profilesNeeded?.length || 0;
    const adaptCount = preflightResult?.adaptsNeeded?.length || 0;
    return {
        profileCount,
        adaptCount,
        allowanceMs: profileCount * PROFILE_ALLOWANCE_MS + adaptCount * ADAPT_ALLOWANCE_MS
    };
}

async function runBatchPreflight({
    preflightResult,
    batchId,
    defaultHost,
    setBatchPhase,
    recordBatchTimelineEvent
}) {
    const { profileCount, adaptCount } = preflightCounts(preflightResult);
    if (!profileCount && !adaptCount) return;

    await setBatchPhase(
        'profiling',
        `Preflight: profiling ${profileCount} and adapting ${adaptCount} model(s)…`
    );
    logger.info('Profiler preflight: running auto-profile/adapt under batch claim', {
        batchId,
        profilesNeeded: profileCount,
        adaptsNeeded: adaptCount
    });
    const preflightWork = [
        ...preflightResult.profilesNeeded,
        ...preflightResult.adaptsNeeded
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
        logger.warn('Profiler preflight run failed — continuing with existing config', {
            batchId,
            error: error.message
        });
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
