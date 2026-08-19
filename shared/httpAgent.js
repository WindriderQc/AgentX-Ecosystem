'use strict';

const http = require('http');
const https = require('https');

const AGENT_CONFIG = Object.freeze({
  keepAlive: true,
  keepAliveMsecs: 1000,
  maxSockets: 10,
  maxFreeSockets: 2,
  timeout: 60000,
  scheduling: 'lifo'
});

const httpAgent = new http.Agent(AGENT_CONFIG);
const httpsAgent = new https.Agent(AGENT_CONFIG);

function getAgent(url) {
  if (!url) return null;
  return String(url).toLowerCase().startsWith('https://') ? httpsAgent : httpAgent;
}

function getFetchOptions(url, options = {}) {
  return { ...options, agent: getAgent(url) };
}

function destroyAgents() {
  httpAgent.destroy();
  httpsAgent.destroy();
}

module.exports = {
  AGENT_CONFIG,
  destroyAgents,
  getAgent,
  getFetchOptions,
  httpAgent,
  httpsAgent
};
