'use strict';

const { getBenchmarkClaimIdentity, getWorkloadAdmissionIdentity } = require('../../clients/coreApiClient');

// All judge implementations use the same managed-workload identity. A batch
// also owns a host claim; standalone calibration only owns its workload.
function judgeRequestIdentity(config = {}) {
    const workloadId = config.cancelSignal?.workloadId || config.signal?.workloadId || config.batch_id;
    return {
        ...(getWorkloadAdmissionIdentity(workloadId) || {}),
        ...(getBenchmarkClaimIdentity(config.host, workloadId) || {})
    };
}

module.exports = { judgeRequestIdentity };
