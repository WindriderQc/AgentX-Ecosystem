'use strict';

const express = require('express');
const request = require('supertest');
const {
  createAgentOpsAvailabilityRouter,
  createUnavailableProjection
} = require('../../routes/agent-ops-availability');

describe('Agent Ops extension availability contract', () => {
  test('returns absence as a successful, read-only capability observation', async () => {
    const app = express();
    app.use('/api/agent-ops', createAgentOpsAvailabilityRouter({
      profile: 'full',
      now: () => new Date('2026-08-28T15:00:00.000Z')
    }));

    const response = await request(app).get('/api/agent-ops').expect(200);

    expect(response.body).toEqual(expect.objectContaining({
      ok: true,
      status: 'success',
      schemaVersion: 1,
      available: false,
      availability: 'not-installed',
      generatedAt: '2026-08-28T15:00:00.000Z'
    }));
    expect(response.body.authority).toEqual({
      id: 'agentx.trusted-extension',
      kind: 'trusted-extension',
      readOnly: true
    });
    expect(response.body.reason).toEqual(expect.objectContaining({
      code: 'AGENT_OPS_EXTENSION_NOT_INSTALLED'
    }));
    expect(response.body.setup).toEqual(expect.objectContaining({
      requiredProfile: 'full',
      activeProfile: 'full',
      environmentVariable: 'AGENTX_EXTENSION_MODULES',
      guidance: expect.stringMatching(/install and pin/i),
      documentation: expect.objectContaining({ path: 'docs/TRUSTED_EXTENSIONS.md' })
    }));
    expect(response.body.links).toEqual({
      nerveCenter: '/nerve-center',
      pipeline: '/pipeline'
    });
    expect(response.body).not.toHaveProperty('data');
    expect(response.body).not.toHaveProperty('agents');
    expect(response.body).not.toHaveProperty('automations');
  });

  test('does not shadow a projection registered earlier by an extension', async () => {
    const app = express();
    app.get('/api/agent-ops', (_req, res) => res.json({
      ok: true,
      available: true,
      authority: 'test-extension',
      data: { proof: 'extension-owned' }
    }));
    app.use('/api/agent-ops', createAgentOpsAvailabilityRouter());

    const response = await request(app).get('/api/agent-ops').expect(200);

    expect(response.body).toEqual({
      ok: true,
      available: true,
      authority: 'test-extension',
      data: { proof: 'extension-owned' }
    });
  });

  test('emits a valid observation timestamp without deployment data', () => {
    const projection = createUnavailableProjection({ profile: 'demo' });
    expect(Number.isNaN(Date.parse(projection.generatedAt))).toBe(false);
    expect(projection.setup.activeProfile).toBe('demo');
    expect(JSON.stringify(projection)).not.toMatch(/https?:\/\/(?:10\.|192\.168\.|172\.(?:1[6-9]|2\d|3[01])\.)/);
  });
});
