'use strict';

const { normalizeOllamaResponse } = require('../../helpers/ollamaResponseHandler');
const { hasQualifiedThinkingCapability } = require('../inferenceContractService');
const { ROUTE_OUTCOME_CODES } = require('./routeDecision');

const ROUTE_OUTCOME_HEADER = 'X-AgentX-Route-Outcome';

function setRouteOutcomeHeader(res, outcomeCode) {
  if (outcomeCode) res.set(ROUTE_OUTCOME_HEADER, String(outcomeCode));
}

function setInferenceResponseHeaders(res, context) {
  const {
    model, hostUrl, hostKey, routingSource, laneName, rawResponseRequested,
    stream, thinkingPolicy, inferenceContract, taskType, routeOutcomeCode,
  } = context;
  res.set('X-Resolved-Model', model);
  res.set('X-Routed-Host', hostUrl);
  res.set('X-Routed-Host-Key', hostKey || '');
  res.set('X-Routing-Source', routingSource);
  res.set('X-Inference-Lane', laneName);
  res.set('X-AgentX-Response-Mode', rawResponseRequested || stream ? 'raw' : 'normalized');
  res.set('X-AgentX-Thinking-Mode', thinkingPolicy.mode);
  res.set('X-AgentX-Thinking-Source', thinkingPolicy.source);
  res.set('X-AgentX-Context-Window', String(inferenceContract.contextBudget.windowTokens));
  res.set('X-AgentX-Context-Source', inferenceContract.contextBudget.source);
  res.set('X-AgentX-Context-Input-Estimate', String(inferenceContract.contextBudget.input.estimatedTokens));
  res.set('X-AgentX-Context-Overflow', String(inferenceContract.contextBudget.input.overflowTokens));
  res.set('X-AgentX-Context-Condensed', String(inferenceContract.contextBudget.transformations.condensation.applied));
  res.set('X-AgentX-Context-Truncated', String(inferenceContract.contextBudget.transformations.truncation.applied));
  res.set('X-AgentX-Context-Truncation-Risk', String(inferenceContract.contextBudget.transformations.upstreamTruncationRisk));
  res.set('X-AgentX-Capability-Qualification', inferenceContract.qualification.state);
  setRouteOutcomeHeader(res, routeOutcomeCode || ROUTE_OUTCOME_CODES.ROUTE_SELECTED);
  if (thinkingPolicy.think !== undefined) res.set('X-AgentX-Think', String(thinkingPolicy.think));
  if (taskType) res.set('X-Routing-Task-Type', taskType);
}

function buildInferenceClientData(data, model, contract, body, rawResponseRequested, stream) {
  const clientData = rawResponseRequested || stream
    ? data
    : normalizeOllamaResponse(data, model, {
      suppressThinking: body.suppressThinking !== false,
      includeThinking: body.includeThinking === true,
      thinkingSupported: hasQualifiedThinkingCapability(contract),
    });
  if (!rawResponseRequested && !stream) clientData.agentx_contract = contract;
  return clientData;
}

function classifyHttpRetryFailure(status, data, raw) {
  const message = String(data?.error || raw || '');
  if (Number(status) === 404 && /model.+(?:not found|missing)|(?:not found|missing).+model/i.test(message)) {
    return { kind: 'missing_artifact', verified: true };
  }
  return { kind: 'http', status: Number(status) };
}

module.exports = {
  ROUTE_OUTCOME_HEADER,
  buildInferenceClientData,
  classifyHttpRetryFailure,
  setRouteOutcomeHeader,
  setInferenceResponseHeaders,
};
