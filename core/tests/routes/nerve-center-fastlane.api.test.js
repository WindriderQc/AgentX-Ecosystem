'use strict';

const fs = require('fs').promises;
const os = require('os');
const path = require('path');
const express = require('express');
const request = require('supertest');

const router = require('../../routes/nerve-center-fastlane');

function createApp() {
  const app = express();
  app.use('/api/nerve-center/fastlane', router);
  return app;
}

async function writeRegistry(root) {
  const configDir = path.join(root, 'config');
  await fs.mkdir(configDir, { recursive: true });
  await fs.writeFile(path.join(configDir, 'agent-registry.yml'), `
agents:
  main:
    type: openclaw_front_door
    persona: Nestor
    runtime: openclaw
    model:
      primary: anthropic/claude-sonnet-4-6
      fallbacks:
        - ollama/ax/gemma4:26b-a4b-it-qat
    answer_heavy_escalation:
      budget_gate: http://agentx.test/api/budget/escalation-recommendation
      status_source: http://agentx.test/api/budget/status
      targets:
        - cloudx
      policy:
        green: allow
        yellow: limited
        red: deny
        unknown: deny
      live_apply: Human-gated runtime change only
  cloudx:
    type: openclaw_cloud_specialist_role
    runtime: openclaw
    model:
      primary: openrouter/free-model
runtimes:
  openclaw:
    host: host-delta
    base_url: http://agentx.test/api/openclaw-ollama
    mcp_skill_bus:
      server_name: agentx
      url: http://agentx.test/mcp
      tools:
        - agentx__check_health
        - agentx__create_todo
`, 'utf8');
}

describe('GET /api/nerve-center/fastlane', () => {
  let root;
  let priorRoot;
  let priorCoreUrl;
  let priorRag;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'agentx-fastlane-'));
    await writeRegistry(root);
    priorRoot = process.env.AGENTX_REPO_ROOT;
    priorCoreUrl = process.env.CORE_PUBLIC_URL;
    priorRag = process.env.PROXY_RAG_REFLEX;
    process.env.AGENTX_REPO_ROOT = root;
    process.env.CORE_PUBLIC_URL = 'http://agentx.test';
    process.env.PROXY_RAG_REFLEX = 'true';
  });

  afterEach(async () => {
    if (priorRoot === undefined) delete process.env.AGENTX_REPO_ROOT;
    else process.env.AGENTX_REPO_ROOT = priorRoot;
    if (priorCoreUrl === undefined) delete process.env.CORE_PUBLIC_URL;
    else process.env.CORE_PUBLIC_URL = priorCoreUrl;
    if (priorRag === undefined) delete process.env.PROXY_RAG_REFLEX;
    else process.env.PROXY_RAG_REFLEX = priorRag;
    await fs.rm(root, { recursive: true, force: true });
  });

  test('returns the Fastlane UI config payload', async () => {
    const res = await request(createApp())
      .get('/api/nerve-center/fastlane')
      .expect(200);

    expect(res.body.status).toBe('success');
    expect(res.body.data.frontDoor.persona).toBe('Nestor');
    expect(res.body.data.routingModel.dispositions).toHaveLength(4);
    expect(res.body.data.controls.ragReflex.enabled).toBe(true);
    expect(res.body.data.controls.budgetGate.targets).toEqual(['cloudx']);
    expect(res.body.data.specialists[0]).toEqual(expect.objectContaining({
      id: 'cloudx',
      available: true
    }));
    expect(res.body.data.configRows.length).toBeGreaterThan(5);
  });
});
