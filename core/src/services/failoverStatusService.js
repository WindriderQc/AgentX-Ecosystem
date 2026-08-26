const InferenceLog = require('../../models/InferenceLog');

// The top-line routing signal is scoped to interactive/generative traffic.
// Embeddings are high-frequency and intentionally favor their own host, so
// including them makes "latest actual host" structurally constant.
const TRUSTED_ROUTING_CALLERS = ['chat', 'proxy'];

function observedState(intentState, latest, failoverCount) {
  const intent = intentState || {};
  const fallbackUsed = latest?.fallbackUsed === true;
  const currentHost = latest?.host || intent.currentHost || intent.primaryHost || null;

  return {
    currentHost,
    isFailedOver: fallbackUsed,
    failoverTimestamp: fallbackUsed ? latest.timestamp : null,
    reason: fallbackUsed ? latest.fallbackReason || 'actual_route_fallback' : null,
    failoverCount: Number(failoverCount) || 0,
    primaryHost: intent.primaryHost || null,
    secondaryHost: intent.secondaryHost || null,
    tertiaryHost: intent.tertiaryHost || null,
    authority: 'inference_log',
    statePersisted: true,
    observedRequest: latest ? {
      id: latest._id ? String(latest._id) : null,
      caller: latest.caller || null,
      model: latest.model || null,
      actualHost: latest.host || null,
      requestedHost: latest.routedHostUrl || null,
      fallbackUsed,
      fallbackReason: latest.fallbackReason || null,
      timestamp: latest.timestamp || null
    } : null,
    requestedIntent: {
      currentHost: intent.currentHost || null,
      isFailedOver: intent.isFailedOver === true,
      reason: intent.reason || null,
      timestamp: intent.failoverTimestamp || null
    }
  };
}

async function getObservedFailoverStatus(intentState) {
  const filter = {
    caller: { $in: TRUSTED_ROUTING_CALLERS },
    taskType: { $ne: 'embeddings' },
    status: 'success'
  };
  const [latest, failoverCount] = await Promise.all([
    InferenceLog.findOne(filter).sort({ timestamp: -1 }).lean(),
    InferenceLog.countDocuments({ ...filter, fallbackUsed: true })
  ]);
  return observedState(intentState, latest, failoverCount);
}

module.exports = {
  TRUSTED_ROUTING_CALLERS,
  observedState,
  getObservedFailoverStatus
};
