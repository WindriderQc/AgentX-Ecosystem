/** Pin detection for benchmark preparation. Claims own exact restoration. */
const logger = require('../../../config/logger');
const { getDedicationStatuses, resolveHostKey } = require('../../clients/coreApiClient');

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

module.exports = { detectDedication };
