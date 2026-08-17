'use strict';

const { buildNestorFastlaneConfig } = require('../../src/services/nestorFastlaneConfigService');

function registryFixture() {
  return {
    agents: {
      main: {
        type: 'openclaw_front_door',
        persona: 'Nestor',
        runtime: 'openclaw',
        role_docs: ['./roles/Nestor.md'],
        model: {
          primary: 'anthropic/claude-sonnet-4-6',
          fallbacks: [
            'openrouter/nvidia/nemotron-3-super-120b-a12b:free',
            'ollama/ax/gemma4:26b-a4b-it-qat'
          ],
          selection_policy: 'front-door chain'
        },
        answer_heavy_escalation: {
          budget_gate: 'http://agentx.test/api/budget/escalation-recommendation',
          status_source: 'http://agentx.test/api/budget/status',
          targets: ['cloudx', 'anthropicx'],
          policy: { green: 'allow', yellow: 'limited', red: 'deny', unknown: 'deny' },
          live_apply: 'human gated'
        },
        boundary: 'front-door boundary'
      },
      cloudx: {
        type: 'openclaw_cloud_specialist_role',
        runtime: 'openclaw',
        model: { primary: 'openrouter/free-model' },
        boundary: 'cloudx boundary'
      },
      anthropicx: {
        type: 'openclaw_cloud_specialist_role',
        runtime: 'openclaw',
        model: { primary: 'anthropic/claude-sonnet-4-6' },
        boundary: 'anthropicx boundary'
      }
    },
    runtimes: {
      openclaw: {
        host: 'host-delta',
        gateway_port: 18789,
        current_provider: 'agentx_openclaw_ollama_proxy',
        base_url: 'http://agentx.test/api/openclaw-ollama',
        context: 65536,
        memory_policies: [
          {
            agentId: 'deepcoding',
            expected: true,
            classification: 'missing',
            status: 'missing_bootstrap_source',
            reason: 'Bootstrap source is absent.'
          }
        ],
        mcp_skill_bus: {
          server_name: 'agentx',
          url: 'http://agentx.test/mcp',
          tools: ['agentx__check_health', 'agentx__create_todo']
        }
      },
      hermes: {
        host: 'host-delta',
        current_provider: 'agentx_hermes_openai_proxy',
        base_url: 'http://agentx.test/api/hermes-openai/v1',
        primary_model: 'ax/gemma4:26b-a4b-it-qat',
        context: 65536
      }
    }
  };
}

describe('nestorFastlaneConfigService', () => {
  test('builds the two-level Nestor routing config from registry and env', async () => {
    const data = await buildNestorFastlaneConfig({
      registry: registryFixture(),
      repoRoot: 'C:/repo',
      env: {
        CORE_PUBLIC_URL: 'http://agentx.test',
        PROXY_RAG_REFLEX: 'true',
        PROXY_RAG_REFLEX_TOPK: '7',
        PROXY_RAG_REFLEX_TIMEOUT_MS: '1234',
        AGENTX_MCP_TOKEN: 'secret',
        NESTOR_MEMORY_RAG_TIMEOUT_MS: '4321'
      }
    });

    expect(data.frontDoor).toEqual(expect.objectContaining({
      id: 'main',
      persona: 'Nestor',
      runtime: 'openclaw'
    }));
    expect(data.frontDoor.model.primary).toBe('anthropic/claude-sonnet-4-6');
    expect(data.routingModel.dispositions.map(d => d.key)).toEqual([
      'answer_light',
      'answer_heavy',
      'do_light',
      'do_heavy'
    ]);
    expect(data.controls.ragReflex).toEqual(expect.objectContaining({
      enabled: true,
      topK: 7,
      timeoutMs: 1234
    }));
    expect(data.controls.mcpSkillBus).toEqual(expect.objectContaining({
      tokenConfigured: true,
      endpoint: 'http://agentx.test/mcp'
    }));
    expect(data.controls.memory.ragTimeoutMs).toBe(4321);
    expect(data.controls.budgetGate.targets).toEqual(['cloudx', 'anthropicx']);
    expect(data.controls.openclawRuntime.memoryPolicies).toEqual([
      expect.objectContaining({
        agentId: 'deepcoding',
        classification: 'missing',
        status: 'missing_bootstrap_source'
      })
    ]);
    expect(data.specialists.map(s => s.id)).toEqual(['cloudx', 'anthropicx']);
    expect(data.configRows.some(row => row.key === 'MCP Auth' && row.value === 'token configured')).toBe(true);
    expect(data.uiPolicy.liveApplyFromUi).toBe(false);
  });

  test('keeps degraded gates visible when optional env flags are off', async () => {
    const data = await buildNestorFastlaneConfig({
      registry: registryFixture(),
      repoRoot: 'C:/repo',
      env: { CORE_PUBLIC_URL: 'http://agentx.test' }
    });

    const answerLight = data.routingModel.dispositions.find(d => d.key === 'answer_light');
    const doLight = data.routingModel.dispositions.find(d => d.key === 'do_light');

    expect(data.controls.ragReflex.enabled).toBe(false);
    expect(data.controls.mcpSkillBus.tokenConfigured).toBe(false);
    expect(answerLight.state).toBe('warn');
    expect(doLight.status).toBe('MCP token not set');
  });

  test('leaves runtime context unresolved when the registry has no context evidence', async () => {
    const registry = registryFixture();
    delete registry.runtimes.openclaw.context;
    delete registry.runtimes.hermes.context;

    const data = await buildNestorFastlaneConfig({
      registry,
      repoRoot: 'C:/repo',
      env: { CORE_PUBLIC_URL: 'http://agentx.test' }
    });

    expect(data.controls.openclawRuntime.context).toBeNull();
    expect(data.controls.hermesRuntime.context).toBeNull();
  });
});
