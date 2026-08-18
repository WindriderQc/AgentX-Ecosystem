/**
 * Dedication Lifecycle
 *
 * Manages GPU pinning detection and restoration during batch execution.
 * Before a batch runs, we detect which hosts have pinned models.
 * After execution completes, we restore those pins so the user's
 * intended GPU assignments are preserved.
 */

const logger = require('../../../config/logger');
const { getDedicationStatuses, resolveHostKey, restoreDedication } = require('../../clients/coreApiClient');
const { benchmarkFetch: fetch } = require('./http');
const { normalizeModelTag: normalizeModelName } = require('../../../../shared/modelNames');

function modelsMatch(left, right) {
    return normalizeModelName(left) === normalizeModelName(right);
}

function getPinnedModelName(entry) {
    return typeof entry === 'string' ? entry : entry?.model;
}

async function getRunningModels(hostUrl) {
    try {
        const res = await fetch(`${hostUrl}/api/ps`, { timeout: 5000 });
        if (!res.ok) return [];
        const data = await res.json();
        return (data.models || [])
            .map(m => normalizeModelName(m.name || m.model))
            .filter(Boolean);
    } catch {
        return [];
    }
}

async function unloadModel(hostUrl, modelName) {
    const res = await fetch(`${hostUrl}/api/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            model: modelName,
            prompt: '',
            keep_alive: 0,
            stream: false
        }),
        timeout: 30000
    });

    if (!res.ok) {
        const body = await res.text().catch(() => '');
        throw new Error(`Ollama unload ${res.status}: ${body.slice(0, 200)}`);
    }
    await res.text().catch(() => {});
}

/**
 * Detect dedicated/pinned models on a set of hosts.
 * Returns a Map of hostUrl → { hostKey, pinnedModels }.
 */
async function detectDedication(hostUrls, { batchId, recordBatchTimelineEvent, failClosed = false }) {
    const dedicationState = new Map();
    try {
        const statuses = await getDedicationStatuses();
        for (const hostUrl of hostUrls) {
            const normalized = hostUrl.replace(/\/+$/, '');
            const match = statuses.find(s => s.host?.replace(/\/+$/, '') === normalized);
            if (match?.pinnedModels?.length) {
                const hostKey = await resolveHostKey(hostUrl);
                if (hostKey) {
                    dedicationState.set(hostUrl, { hostKey, pinnedModels: match.pinnedModels });
                    logger.info('Dedication detected — will restore after batch', {
                        batchId, host: hostUrl, hostKey, pinnedModels: match.pinnedModels
                    });
                    await recordBatchTimelineEvent('dedication_detected', {
                        host: hostUrl, hostKey, pinnedModels: match.pinnedModels
                    });
                } else if (failClosed) {
                    const err = new Error(`Cannot resolve the dedication host key for ${hostUrl}`);
                    err.code = 'PIN_HOST_KEY_UNRESOLVED';
                    throw err;
                }
            }
        }
    } catch (err) {
        logger.warn('Dedication detection failed', {
            batchId, error: err.message
        });
        await recordBatchTimelineEvent('dedication_detection_failed', {
            batchId, error: err.message, fail_closed: failClosed
        }).catch(() => {});
        if (failClosed) {
            err.code = err.code || 'PIN_DETECTION_FAILED';
            throw err;
        }
    }
    return dedicationState;
}

/**
 * Unload detected pinned models while preserving their pin configuration in
 * core. Benchmark claims should already be active when this runs so core's
 * auto-restore loop does not reload the pins mid-batch.
 */
async function releaseAllDedication(dedicationState, {
    batchId,
    recordBatchTimelineEvent,
    failClosed = false
}) {
    for (const [hostUrl, { hostKey, pinnedModels }] of dedicationState) {
        const runningModels = await getRunningModels(hostUrl);
        for (const pinnedEntry of pinnedModels) {
            const pinnedModel = getPinnedModelName(pinnedEntry);
            if (!pinnedModel) continue;

            const candidates = new Set();
            candidates.add(normalizeModelName(pinnedModel));
            const matchingRunningModels = runningModels.filter((runningModel) =>
                modelsMatch(runningModel, pinnedModel)
            );
            for (const runningModel of matchingRunningModels) {
                candidates.add(runningModel);
            }

            for (const candidate of candidates) {
                try {
                    logger.info('Releasing pinned model for benchmark', {
                        batchId, host: hostUrl, hostKey, pinnedModel, unloadModel: candidate
                    });
                    await unloadModel(hostUrl, candidate);
                    await recordBatchTimelineEvent('dedication_released', {
                        host: hostUrl, hostKey, pinnedModel, unloadModel: candidate
                    });
                } catch (err) {
                    logger.warn('Pinned model unload failed during benchmark dedication release', {
                        batchId, host: hostUrl, hostKey, pinnedModel, unloadModel: candidate, error: err.message
                    });
                    await recordBatchTimelineEvent('dedication_release_failed', {
                        host: hostUrl, hostKey, pinnedModel, unloadModel: candidate, error: err.message
                    }).catch(() => {});
                    if (failClosed) {
                        err.code = err.code || 'PIN_RELEASE_FAILED';
                        err.resumeContext = { host: hostUrl, model: pinnedModel };
                        throw err;
                    }
                }
            }
        }
    }
}

/**
 * Restore all previously detected dedications.
 */
async function restoreAllDedication(dedicationState, { batchId, recordBatchTimelineEvent }) {
    for (const [hostUrl, { hostKey, pinnedModels }] of dedicationState) {
        try {
            logger.info('Restoring dedication after batch', { batchId, host: hostUrl, hostKey, pinnedModels });
            await restoreDedication(hostKey);
            logger.info('Dedication restored', { batchId, host: hostUrl, hostKey });
            await recordBatchTimelineEvent('dedication_restored', { host: hostUrl, hostKey, pinnedModels });
        } catch (err) {
            logger.error('Dedication restore failed — pinned models may need manual reload', {
                batchId, host: hostUrl, hostKey, pinnedModels, error: err.message
            });
            await recordBatchTimelineEvent('dedication_restore_failed', {
                host: hostUrl, hostKey, pinnedModels, error: err.message
            });
        }
    }
}

module.exports = { detectDedication, releaseAllDedication, restoreAllDedication };
