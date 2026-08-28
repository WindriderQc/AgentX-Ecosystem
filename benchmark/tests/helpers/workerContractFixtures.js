'use strict';

const { fingerprint } = require('../../../shared/workerContract');

function envelopeInput(overrides = {}) {
  return {
    schema: 'agentx.worker-envelope/v1',
    schemaVersion: 1,
    task: { id: 'task-001', correlationId: 'campaign-001' },
    work: { reference: 'fixture.coding-001', description: 'Apply the bounded fixture change.' },
    workspace: { id: 'workspace-001', kind: 'repository' },
    dataClassification: 'internal',
    executionProfile: 'portable',
    selection: {
      harness: { constraints: ['supports.patch', 'supports.tests'] },
      model: { provider: 'provider-a', id: 'model-a', version: '2026-08', constraints: ['tools'] },
    },
    prompt: { reference: 'prompt.portable-v1', fingerprint: fingerprint('portable prompt v1') },
    tools: {
      allowed: [{ name: 'workspace.patch', version: '1.0.0', schemaFingerprint: fingerprint({ op: 'patch' }) }],
    },
    budgets: {
      maxDurationMs: 300000,
      maxTokens: 20000,
      maxCostNanodollars: 500000000,
      maxTurns: 20,
      maxToolCalls: 50,
    },
    policies: {
      filesystem: { mode: 'workspace_write', workspaceOnly: true, allowedOperations: ['read', 'update'] },
      network: { mode: 'none', allowedDestinations: [] },
      output: { mode: 'patch_and_artifacts', maxBytes: 1000000, publicProjection: 'allowlist_only' },
    },
    resultContract: { format: 'patch', requiredEvidence: ['patch', 'tests'] },
    ...overrides,
  };
}

function receiptInput(envelope, overrides = {}) {
  return {
    schema: 'agentx.worker-receipt/v1',
    schemaVersion: 1,
    executionProfile: envelope.executionProfile,
    identity: {
      harness: { name: 'harness-a', version: '1.2.3' },
      adapter: { name: 'adapter-a', version: '2.0.0' },
      provider: { name: 'provider-a', version: '2026-08' },
      model: {
        name: 'model-a',
        version: '2026-08',
        digest: `sha256:${'a'.repeat(64)}`,
        runtimeFingerprint: 'b'.repeat(64),
      },
      api: { name: 'messages', version: '2026-01' },
      environment: { id: 'sandbox-a', version: 'image-1', fingerprint: 'c'.repeat(64) },
    },
    fingerprints: {
      prompt: envelope.prompt.fingerprint,
      tools: envelope.tools.schemaFingerprint,
      policies: envelope.policies.fingerprint,
      envelope: envelope.fingerprint,
    },
    finalState: 'succeeded',
    failure: { classification: null, code: null },
    usage: {
      durationMs: 1200,
      inputTokens: 100,
      outputTokens: 50,
      totalTokens: 150,
      costNanodollars: 1000,
      turns: 2,
      toolCalls: 3,
    },
    toolErrors: [],
    humanInterventions: [],
    evidence: {
      patches: [{ id: 'patch-001', digest: `sha256:${'d'.repeat(64)}` }],
      artifacts: [{ id: 'artifact-001', digest: `sha256:${'e'.repeat(64)}` }],
      tests: [{ id: 'tests.unit', status: 'passed', digest: `sha256:${'f'.repeat(64)}` }],
    },
    violations: [],
    result: { contractSatisfied: true, fingerprint: fingerprint({ result: 'ok' }) },
    ...overrides,
  };
}

module.exports = { envelopeInput, receiptInput };
