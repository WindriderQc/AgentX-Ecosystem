'use strict';

const { normalizeOllamaResponse } = require('../../helpers/ollamaResponseHandler');
const { hasQualifiedThinkingCapability } = require('../inferenceContractService');
const { ROUTE_OUTCOME_CODES } = require('./routeDecision');

const ROUTE_OUTCOME_HEADER = 'X-AgentX-Route-Outcome';

function setRouteOutcomeHeader(headers, outcomeCode) {
  if (outcomeCode) headers[ROUTE_OUTCOME_HEADER] = String(outcomeCode);
}

function buildInferenceResponseHeaders(context) {
  const headers = {};
  const {
    model, hostUrl, hostKey, routingSource, laneName, rawResponseRequested,
    stream, thinkingPolicy, inferenceContract, taskType, routeOutcomeCode,
  } = context;
  headers['X-Resolved-Model'] = model;
  headers['X-Routed-Host'] = hostUrl;
  headers['X-Routed-Host-Key'] = hostKey || '';
  headers['X-Routing-Source'] = routingSource;
  headers['X-Inference-Lane'] = laneName;
  headers['X-AgentX-Response-Mode'] = rawResponseRequested || stream ? 'raw' : 'normalized';
  headers['X-AgentX-Thinking-Mode'] = thinkingPolicy.mode;
  headers['X-AgentX-Thinking-Source'] = thinkingPolicy.source;
  headers['X-AgentX-Context-Window'] = String(inferenceContract.contextBudget.windowTokens);
  headers['X-AgentX-Context-Source'] = inferenceContract.contextBudget.source;
  headers['X-AgentX-Context-Input-Estimate'] = String(inferenceContract.contextBudget.input.estimatedTokens);
  headers['X-AgentX-Context-Overflow'] = String(inferenceContract.contextBudget.input.overflowTokens);
  headers['X-AgentX-Context-Condensed'] = String(inferenceContract.contextBudget.transformations.condensation.applied);
  headers['X-AgentX-Context-Truncated'] = String(inferenceContract.contextBudget.transformations.truncation.applied);
  headers['X-AgentX-Context-Truncation-Risk'] = String(inferenceContract.contextBudget.transformations.upstreamTruncationRisk);
  headers['X-AgentX-Capability-Qualification'] = inferenceContract.qualification.state;
  setRouteOutcomeHeader(headers, routeOutcomeCode || ROUTE_OUTCOME_CODES.ROUTE_SELECTED);
  if (thinkingPolicy.think !== undefined) headers['X-AgentX-Think'] = String(thinkingPolicy.think);
  if (taskType) headers['X-Routing-Task-Type'] = taskType;
  return headers;
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
  buildInferenceResponseHeaders,
};
