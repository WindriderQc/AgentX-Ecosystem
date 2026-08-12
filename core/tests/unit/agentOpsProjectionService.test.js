const {
  buildAgentOpsProjection,
  parseScheduledWork,
  parseLeadHolder
} = require('../../src/services/agentOpsProjectionService');

const SCHEDULED = `
# Scheduled Work

## Active

| What | When | Owner | Trigger | Why | Source |
|---|---|---|---|---|---|
| Planning reconcile | every 15 min | OpenClaw \`leadx\` | cron \`planning-reconcile\` (\`64a02b9e-a193-438e-b632-1ce7849c8392\`) | Refresh planning evidence | OpenClaw cron |
| Host telemetry | hourly (\`0 * * * *\`) | native host | Windows task | Feeds host metrics | host agent |

## Retired
`;

const REGISTRY = {
  agents: {
    codex: {
      type: 'coding_agent',
      default_scope: ['code', 'tests'],
      role_docs: ['./roles/Codex.md']
    },
    leadx: {
      type: 'openclaw_strategy_role',
      runtime: 'openclaw',
      boundary: 'Planning and scheduled reporting.',
      role_docs: ['./roles/LeadX.md']
    },
    deepsearch: {
      type: 'openclaw_research_role',
      runtime: 'openclaw',
      boundary: 'Research specialist.'
    },
    doc_janitor: {
      type: 'superseded_role',
      boundary: 'Historical only.'
    }
  },
  capabilities: {
    docs_steward: {
      type: 'documentation_governance_capability',
      not_an_agent: true,
      boundary: 'AgentX-owned documentation governance.',
      provided_by: { service: 'core', ui: '/docs-steward' }
    }
  },
  runtimes: {
    openclaw: { type: 'managed_worker_runtime', host: 'host-delta' }
  }
};

const SNAPSHOT = {
  status: 'degraded',
  generatedAt: '2026-07-17T00:00:00.000Z',
  sources: {
    openclaw: { status: 'degraded' },
    pipeline: { status: 'ok' }
  },
  runtimes: { hermes: { liveStatus: {} } },
  agents: {
    openclaw: [
      { id: 'leadx', name: 'LeadX', model: { primary: 'ollama/live', fallbacks: ['ollama/fallback'] } }
    ]
  },
  schedules: {
    openclawCron: {
      jobs: [{
        id: '64a02b9e-a193-438e-b632-1ce7849c8392',
        name: 'planning-reconcile',
        agentId: 'leadx',
        enabled: true,
        lastRunStatus: 'ok',
        lastRunAtMs: Date.parse('2026-07-17T00:00:00.000Z'),
        lastDurationMs: 42000,
        nextRunAtMs: Date.parse('2026-07-17T00:15:00.000Z'),
        schedule: { kind: 'every', everyMs: 900000 }
      }]
    },
    cluster: {
      entries: [{
        sourceId: 'oc-planning-reconcile',
        name: 'Planning Reconcile',
        agent: 'leadx',
        lastRun: '2026-07-17T00:00:00.000Z'
      }]
    }
  },
  pipeline: {
    sourceOfTruth: 'mongodb:pipelinetasks',
    counts: { queued: 2, in_progress: 1, review: 1, blocked: 1, done: 9 },
    active: [
      { pipelineId: '0400', title: 'Agent Ops', status: 'in_progress', assignee: 'codex' },
      { pipelineId: '0401', title: 'Blocked plan', status: 'blocked', assignee: 'leadx' }
    ]
  }
};

describe('agentOpsProjectionService', () => {
  test('parses only the Active scheduled-work table', () => {
    const rows = parseScheduledWork(SCHEDULED);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      name: 'Planning reconcile',
      cadence: 'every 15 min',
      owner: 'OpenClaw leadx'
    });
    expect(rows[0].runtimeIds).toContain('64a02b9e-a193-438e-b632-1ce7849c8392');
    expect(rows[1].cadence).toBe('hourly (0 * * * *)');
  });

  test('parses the active lead from frontmatter', () => {
    expect(parseLeadHolder('---\nheld_by: codex\nsince: now\n---')).toBe('codex');
    expect(parseLeadHolder('---\nheld_by: none\n---')).toBeNull();
  });

  test('joins registry, live agents, recurring work, and pipeline ownership', async () => {
    const projection = await buildAgentOpsProjection({
      registry: REGISTRY,
      scheduledMarkdown: SCHEDULED,
      leadMarkdown: '---\nheld_by: codex\n---',
      snapshot: SNAPSHOT,
      recentTasks: [
        { pipelineId: '0399', title: 'Shipped proof', status: 'done', assignee: 'codex', updatedAt: '2026-07-16T23:00:00.000Z' }
      ],
      auditEntries: [
        { _id: 'audit-1', timestamp: '2026-07-16T23:30:00.000Z', status: 'success', target: 'job-1', details: { namespace: 'agent-ops', action: 'automation-run', label: 'Run requested' } }
      ],
      openclawControl: {
        authority: 'official-openclaw-control-ui',
        mode: 'ssh-tunnel',
        launchBaseUrl: 'http://127.0.0.1:18790',
        directBaseUrl: 'http://192.0.2.66:18789',
        requiresSecureContext: true,
        requiresTunnel: true,
        tunnelCommand: 'ssh -N -L 18790:127.0.0.1:18789 yb@192.0.2.66',
        nativeCapabilities: [{ id: 'agents', label: 'Agents', path: '/agents', href: 'http://127.0.0.1:18790/agents' }],
        agentx: {
          authority: 'cross-platform-complements',
          complements: [{ id: 'integration-events', label: 'Integration events', href: '/data-toolbox#live-data' }]
        }
      }
    });

    expect(projection.summary).toMatchObject({
      registeredAgents: 4,
      activeAgents: 3,
      observedAgents: 2,
      runtimeAgents: 2,
      automations: 2,
      observedAutomations: 1,
      healthyAutomations: 1,
      openWork: 5,
      blockedWork: 1
    });

    expect(projection.coverage.automations).toMatchObject({
      documented: 2,
      observed: 1,
      matchedDocumented: 1,
      documentedOnly: 1,
      observedOnly: 0
    });

    expect(projection.agents.find((agent) => agent.id === 'codex')).toMatchObject({
      status: 'lead',
      workCount: 1
    });
    expect(projection.agents.find((agent) => agent.id === 'leadx')).toMatchObject({
      status: 'live',
      automationCount: 1,
      workCount: 1,
      model: { primary: 'ollama/live', source: 'runtime' }
    });
    expect(projection.agents.find((agent) => agent.id === 'deepsearch')).toMatchObject({
      status: 'unobserved'
    });
    expect(projection.capabilities[0]).toMatchObject({
      id: 'docs_steward',
      notAnAgent: true
    });
    expect(projection.runtimeLayers[0]).toMatchObject({
      id: 'openclaw',
      name: 'OpenClaw'
    });
    expect(projection.automations.find((item) => item.name === 'planning-reconcile')).toMatchObject({
      confidence: 'live',
      documented: true,
      health: 'healthy',
      lastRun: '2026-07-17T00:00:00.000Z',
      durationMs: 42000
    });
    expect(projection.automations.find((item) => item.name === 'Host telemetry')).toMatchObject({
      confidence: 'documented',
      health: 'documented'
    });
    expect(projection.schemaVersion).toBe(4);
    expect(projection.handoffs).toMatchObject({
      openclaw: {
        authority: 'official-openclaw-control-ui',
        mode: 'ssh-tunnel',
        requiresTunnel: true,
        capabilities: [expect.objectContaining({ id: 'agents' })]
      },
      agentx: {
        authority: 'cross-platform-complements',
        complements: [expect.objectContaining({ id: 'integration-events' })]
      }
    });
    expect(projection.links).toMatchObject({
      openclawControl: 'http://127.0.0.1:18790',
      agentxComplements: '/agent-ops'
    });
    expect(projection.responsibilities.summary).toMatchObject({
      totalSignals: 4,
      attributedSignals: 3,
      unassignedSignals: 1
    });
    expect(projection.responsibilities.lanes.find((lane) => lane.agentId === 'leadx')).toMatchObject({
      signalCount: 2,
      blockedCount: 1
    });
    expect(projection.activity.items).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'automation', targetId: '64a02b9e-a193-438e-b632-1ce7849c8392' }),
      expect.objectContaining({ kind: 'operator', title: 'Run requested' }),
      expect.objectContaining({ kind: 'work', targetId: '0399' })
    ]));
    expect(projection.warnings).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'sources-degraded', action: { kind: 'trace-sources' } }),
      expect.objectContaining({ id: 'unassigned-responsibility-signals' })
    ]));
  });
});
