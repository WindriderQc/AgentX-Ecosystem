'use strict';

const express = require('express');

const DOCUMENTATION_PATH = 'docs/TRUSTED_EXTENSIONS.md';
const DOCUMENTATION_URL = 'https://github.com/WindriderQc/AgentX-Ecosystem/blob/main/docs/TRUSTED_EXTENSIONS.md';

function createUnavailableProjection({ profile = 'full', now = () => new Date() } = {}) {
  return {
    ok: true,
    status: 'success',
    schemaVersion: 1,
    available: false,
    availability: 'not-installed',
    authority: {
      id: 'agentx.trusted-extension',
      kind: 'trusted-extension',
      readOnly: true
    },
    reason: {
      code: 'AGENT_OPS_EXTENSION_NOT_INSTALLED',
      message: 'No installed trusted extension handled the Agent Ops projection.'
    },
    generatedAt: now().toISOString(),
    setup: {
      requiredProfile: 'full',
      activeProfile: profile,
      environmentVariable: 'AGENTX_EXTENSION_MODULES',
      guidance: 'Install and pin a separately owned Agent Ops extension, enable the full profile, then restart Core.',
      documentation: {
        path: DOCUMENTATION_PATH,
        url: DOCUMENTATION_URL
      }
    },
    links: {
      nerveCenter: '/nerve-center',
      pipeline: '/pipeline'
    }
  };
}

function createAgentOpsAvailabilityRouter(options = {}) {
  const router = express.Router();
  router.get('/', (_req, res) => res.status(200).json(createUnavailableProjection(options)));
  return router;
}

module.exports = {
  DOCUMENTATION_PATH,
  DOCUMENTATION_URL,
  createUnavailableProjection,
  createAgentOpsAvailabilityRouter
};
