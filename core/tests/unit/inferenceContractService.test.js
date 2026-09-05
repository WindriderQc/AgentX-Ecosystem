'use strict';

const {
  estimateInputTokens,
  getThinkingCapabilityStatus,
  hasQualifiedThinkingCapability,
  resolveCapabilityContract,
  resolveCapabilities,
  resolveContextBudget,
  resolveInferenceContract,
  resolveInferenceContractSnapshot,
  resolveToolCapability
} = require('../../src/services/inferenceContractService');
const { buildRuntimeFingerprint } = require('../../../shared/artifactIdentity');

const HOSTS = [
  {
    id: 'primary',
    name: 'Host Alpha',
    url: 'http://192.0.2.199:11434'
  },
  {
    id: 'secondary',
    name: 'Host Beta',
    url: 'http://192.0.2.12:11434'
  }
];

function profileCollection(profile) {
  return {
    findOne: jest.fn(async () => profile)
  };
}

describe('inferenceContractService', () => {
  it('resolves thinking from the deployed host/artifact profile rather than its name', async () => {
    const hostProfile = {
      hostId: 'host-alpha',
      hostUrl: 'http://192.0.2.199:11434',
      displayName: 'Host Alpha'
    };
    const runtimeFingerprint = buildRuntimeFingerprint(hostProfile, hostProfile.hostUrl);
    const capabilities = await resolveCapabilities(
      'ax/plain-custom-model:latest',
      'http://192.0.2.199:11434',
      {
        configuredHosts: HOSTS,
        includeArtifactIdentity: true,
        hostProfilesCollection: profileCollection(hostProfile),
        resolveArtifactDigest: jest.fn(async () => 'sha256:profiled'),
        registryEntry: {
          _id: 'registry-a',
          modelName: 'ax/plain-custom-model',
          installations: [{ hostUrl: hostProfile.hostUrl, digest: 'sha256:profiled', status: 'active', isActive: true }]
        },
        toolQualificationEvidence: {
          contract: 'agentx.tool-capability-qualification.v1',
          state: 'supported',
          supported: true,
          qualified: true,
          reasons: [],
          expected: {
            schemaVersion: 'agentx.tool-capability-qualification.v1',
            protocolVersion: 'ollama.chat.native-tools.v1',
            fixtureVersion: 'toolcall-fixtures.v1',
            fixtureFingerprint: 'fixture-a'
          },
          evidence: {
            schemaVersion: 'agentx.tool-capability-qualification.v1',
            modelName: 'ax/plain-custom-model',
            hostId: 'host-alpha',
            hostUrl: hostProfile.hostUrl,
            artifactDigest: 'sha256:profiled',
            runtimeFingerprint,
            protocolVersion: 'ollama.chat.native-tools.v1',
            fixtureVersion: 'toolcall-fixtures.v1',
            fixtureFingerprint: 'fixture-a',
            outcome: 'supported',
            repetitionsRequested: 3,
            repetitionsCompleted: 3,
            evidenceDigest: 'a'.repeat(64),
            completedAt: '2026-09-04T00:00:00Z',
            validUntil: '2099-01-01T00:00:00Z'
          }
        },
        modelProfilesCollection: profileCollection({
          name: 'ax/plain-custom-model',
          capabilities: { tools: true },
          readiness: {
            'host-alpha': {
              stage: 'profiled',
              stale: false,
              benchmarkQualified: true,
              artifact: {
                model: 'ax/plain-custom-model',
                hostId: 'host-alpha',
                hostUrl: hostProfile.hostUrl,
                digest: 'sha256:profiled',
                runtimeFingerprint,
                registryQualified: true
              }
            }
          },
          thinkingProfiles: {
            'host-alpha': {
              supported: true,
              channel: 'hidden',
              recommendedPolicy: 'metered',
              visibleFinalAnswerOk: true,
              finalAnswerContractOk: true,
              thinkingOnlyResponse: false,
              profiledAt: new Date('2026-07-20T00:00:00Z')
            },
            secondary: {
              supported: false,
              channel: 'none',
              recommendedPolicy: 'off'
            }
          }
        })
      }
    );

    expect(capabilities.artifact).toMatchObject({
      model: 'ax/plain-custom-model',
      matchedProfile: 'ax/plain-custom-model',
      hostId: 'host-alpha'
    });
    expect(capabilities.qualification).toMatchObject({
      state: 'profiled',
      qualified: true
    });
    expect(capabilities.thinking).toMatchObject({
      supported: true,
      modes: ['off', 'on'],
      channel: 'hidden',
      recommendedPolicy: 'metered',
      source: 'benchmark_model_profile',
      visibleFinalAnswer: {
        required: true,
        qualified: true,
        thinkingOnlyObserved: false
      }
    });
    expect(capabilities.tools).toMatchObject({
      supported: true,
      qualified: true,
      state: 'supported',
      source: 'benchmark_tool_capability_qualification'
    });
    expect(hasQualifiedThinkingCapability({
      qualification: capabilities.qualification,
      capabilities: { thinking: capabilities.thinking }
    })).toBe(true);
  });

  it('does not infer thinking capability from a Qwen-like artifact name', async () => {
    const capabilities = await resolveCapabilities(
      'qwen-super-reasoning:99b',
      'http://192.0.2.199:11434',
      {
        configuredHosts: HOSTS,
        modelProfilesCollection: profileCollection(null)
      }
    );

    expect(capabilities.thinking).toMatchObject({
      supported: null,
      modes: ['off'],
      source: 'unqualified'
    });
    expect(capabilities.qualification.qualified).toBe(false);
    expect(hasQualifiedThinkingCapability({
      qualification: capabilities.qualification,
      capabilities: { thinking: capabilities.thinking }
    })).toBe(false);
  });

  it('treats a legacy tools false profile as unknown without dedicated evidence', async () => {
    const capabilities = await resolveCapabilities(
      'legacy-model:8b',
      HOSTS[0].url,
      {
        configuredHosts: HOSTS,
        modelProfilesCollection: profileCollection({
          name: 'legacy-model:8b',
          capabilities: { tools: false },
          readiness: {},
          thinkingProfiles: {}
        })
      }
    );

    expect(capabilities.tools).toEqual({
      supported: null,
      qualified: false,
      state: 'unknown',
      source: 'unqualified',
      reasons: ['artifact_identity_unqualified']
    });
  });

  it('maps only exact fresh supported or unsupported tool evidence and keeps drift unknown', () => {
    const artifact = {
      model: 'owner/model:8b',
      hostId: 'host-a',
      hostUrl: 'http://host-a:11434',
      digest: 'sha256:a',
      runtimeFingerprint: 'runtime-a',
      identityQualified: true
    };
    const evidence = {
      schemaVersion: 'agentx.tool-capability-qualification.v1',
      modelName: artifact.model,
      hostId: artifact.hostId,
      hostUrl: artifact.hostUrl,
      artifactDigest: artifact.digest,
      runtimeFingerprint: artifact.runtimeFingerprint,
      protocolVersion: 'ollama.chat.native-tools.v1',
      fixtureVersion: 'toolcall-fixtures.v1',
      fixtureFingerprint: 'fixture-a',
      outcome: 'supported',
      repetitionsRequested: 3,
      repetitionsCompleted: 3,
      evidenceDigest: 'a'.repeat(64),
      completedAt: '2026-09-04T00:00:00Z',
      validUntil: '2026-10-04T00:00:00Z'
    };
    const envelope = {
      contract: 'agentx.tool-capability-qualification.v1',
      expected: {
        schemaVersion: 'agentx.tool-capability-qualification.v1',
        protocolVersion: 'ollama.chat.native-tools.v1',
        fixtureVersion: 'toolcall-fixtures.v1',
        fixtureFingerprint: 'fixture-a'
      },
      qualified: true,
      reasons: [],
      evidence
    };

    expect(resolveToolCapability({
      ...envelope, state: 'supported'
    }, artifact, new Date('2026-09-04T00:00:00Z'))).toMatchObject({ supported: true, qualified: true, state: 'supported' });
    expect(resolveToolCapability({
      ...envelope, state: 'unsupported', evidence: { ...evidence, outcome: 'unsupported' }
    }, artifact, new Date('2026-09-04T00:00:00Z'))).toMatchObject({ supported: false, qualified: true, state: 'unsupported' });
    expect(resolveToolCapability({
      state: 'stale', qualified: false, reasons: ['fixture_fingerprint_mismatch'], evidence: null
    }, artifact, new Date('2026-09-04T00:00:00Z'))).toEqual({
      supported: null,
      qualified: false,
      state: 'stale',
      source: 'benchmark_tool_capability_qualification',
      reasons: ['fixture_fingerprint_mismatch']
    });
    expect(resolveToolCapability({
      state: 'interrupted', qualified: false, reasons: ['evidence_interrupted'], evidence
    }, artifact)).toMatchObject({ supported: null, qualified: false, state: 'unknown' });
    expect(resolveToolCapability({
      ...envelope, state: 'supported', evidence: { ...evidence, artifactDigest: 'sha256:old' }
    }, artifact, new Date('2026-09-04T00:00:00Z'))).toMatchObject({
      supported: null,
      qualified: false,
      state: 'stale',
      reasons: ['artifact_digest_mismatch']
    });
    expect(resolveToolCapability({
      ...envelope,
      state: 'supported',
      evidence: { ...evidence, fixtureFingerprint: 'old-fixture' }
    }, artifact, new Date('2026-09-04T00:00:00Z'))).toMatchObject({
      supported: null,
      qualified: false,
      state: 'stale',
      reasons: ['fixture_fingerprint_mismatch']
    });
    expect(resolveToolCapability({
      ...envelope,
      state: 'supported',
      evidence: { ...evidence, validUntil: '2026-08-01T00:00:00Z' }
    }, artifact, new Date('2026-09-04T00:00:00Z'))).toMatchObject({
      supported: null,
      qualified: false,
      state: 'stale',
      reasons: ['evidence_expired']
    });
    expect(resolveToolCapability({
      ...envelope,
      state: 'supported',
      evidence: { ...evidence, repetitionsCompleted: 2 }
    }, artifact, new Date('2026-09-04T00:00:00Z'))).toMatchObject({
      supported: null,
      qualified: false,
      state: 'stale',
      reasons: ['evidence_repetitions_incomplete']
    });
  });

  it('calculates a reusable context budget and reports overflow without mutating input', async () => {
    const messages = [
      { role: 'system', content: 's'.repeat(400) },
      { role: 'user', content: 'u'.repeat(4000) }
    ];
    const budget = await resolveContextBudget(
      {
        model: 'model-a',
        host: HOSTS[0].url,
        messages,
        requestedMaxOutputTokens: 512
      },
      {
        resolveContextDetails: jest.fn(async () => ({
          num_ctx: 1024,
          source: 'model_context_profile',
          authoritative: true,
          details: { verifiedInputTokens: 400 }
        }))
      }
    );

    expect(budget).toMatchObject({
      windowTokens: 1024,
      source: 'model_context_profile',
      validatedWindowTokens: 1024,
      validatedInputTokens: 400,
      output: { reservedTokens: 512, source: 'caller' },
      enforcement: 'report_only',
      transformations: {
        condensation: { applied: false, removedTokens: 0 },
        truncation: { applied: false, removedTokens: 0 },
        upstreamTruncationRisk: true
      }
    });
    expect(budget.input.estimatedTokens).toBeGreaterThan(budget.input.availableTokens);
    expect(budget.input.overflowTokens).toBeGreaterThan(0);
    expect(budget.input.validatedOverflowTokens).toBeGreaterThan(0);
    expect(budget.input.validatedFits).toBe(false);
    expect(budget.warnings).toEqual(expect.arrayContaining([
      expect.stringMatching(/upstream truncation/i),
      expect.stringMatching(/largest measured successful prompt/i)
    ]));
    expect(messages).toHaveLength(2);
    expect(messages[1].content).toHaveLength(4000);
  });

  it('keeps an explicit caller context while flagging a validated-limit overrun', async () => {
    const budget = await resolveContextBudget(
      {
        model: 'model-a',
        host: HOSTS[0].url,
        prompt: 'hello',
        requestedNumCtx: 32768,
        numCtxSource: 'caller'
      },
      {
        resolveContextDetails: jest.fn(async () => ({
          num_ctx: 16384,
          source: 'context_test'
        }))
      }
    );

    expect(budget.windowTokens).toBe(32768);
    expect(budget.source).toBe('caller');
    expect(budget.validatedWindowTokens).toBe(16384);
    expect(budget.warnings).toEqual(expect.arrayContaining([
      expect.stringMatching(/exceeds the latest validated/i)
    ]));
  });

  it('keeps resident capacity separate from measured window and input limits', async () => {
    const budget = await resolveContextBudget(
      {
        model: 'model-a',
        host: HOSTS[0].url,
        prompt: 'short request',
        requestedMaxOutputTokens: 4096
      },
      {
        resolveContextDetails: jest.fn(async () => ({
          num_ctx: 262144,
          source: 'host_preference_pin',
          verifiedMaxContext: 237568,
          verifiedInputTokens: 160000
        }))
      }
    );

    expect(budget).toMatchObject({
      windowTokens: 262144,
      source: 'host_preference_pin',
      validatedWindowTokens: 237568,
      validatedInputTokens: 160000,
      output: { reservedTokens: 4096 },
      input: {
        availableTokens: 258048,
        fits: true,
        validatedFits: true
      }
    });
    expect(budget.warnings).toEqual(expect.arrayContaining([
      expect.stringMatching(/runtime context exceeds the latest validated/i)
    ]));
  });

  it('reports unresolved context without inventing a smaller runtime window', async () => {
    const budget = await resolveContextBudget(
      {
        model: 'unprofiled-model',
        host: HOSTS[0].url,
        prompt: 'hello'
      },
      {
        resolveContextDetails: jest.fn(async () => ({
          num_ctx: null,
          source: 'unresolved'
        }))
      }
    );

    expect(budget).toMatchObject({
      windowTokens: null,
      source: 'unresolved',
      resolvedWindowTokens: null,
      resolvedSource: 'unresolved',
      input: {
        availableTokens: null,
        remainingTokens: null,
        overflowTokens: null,
        fits: null
      }
    });
    expect(budget.warnings).toEqual([
      expect.stringMatching(/no context window was inferred/i)
    ]);
  });

  it('returns one versioned contract containing capability and budget evidence', async () => {
    const contract = await resolveInferenceContract(
      {
        model: 'plain-custom-model',
        host: HOSTS[0].url,
        prompt: 'hello'
      },
      {
        configuredHosts: HOSTS,
        modelProfilesCollection: profileCollection({
          name: 'plain-custom-model',
          capabilities: { tools: false },
          readiness: { primary: { stage: 'profiled' } },
          thinkingProfiles: {
            primary: {
              supported: false,
              channel: 'none',
              recommendedPolicy: 'off'
            }
          }
        }),
        resolveContextDetails: jest.fn(async () => ({
          num_ctx: 49152,
          source: 'model_context_profile'
        }))
      }
    );

    expect(contract.version).toBe('agentx.inference-contract.v1');
    expect(contract.artifact.hostId).toBe('primary');
    expect(contract.capabilities.thinking.supported).toBe(false);
    expect(contract.contextBudget.windowTokens).toBe(49152);
    expect(contract.contextBudget.input.fits).toBe(true);
  });

  it('returns a capability-only contract for catalog and runtime consumers', async () => {
    const fetchImpl = jest.fn();
    const contract = await resolveCapabilityContract(
      {
        model: 'plain-custom-model',
        host: HOSTS[0].url
      },
      {
        configuredHosts: HOSTS,
        modelProfilesCollection: profileCollection(null),
        registryEntry: {
          modelName: 'plain-custom-model',
          capabilities: { supportsThinking: true }
        },
        fetchImpl
      }
    );

    expect(contract).toMatchObject({
      version: 'agentx.inference-contract.v1',
      artifact: { model: 'plain-custom-model', hostId: 'primary' },
      qualification: { qualified: false },
      capabilities: {
        thinking: {
          supported: true,
          source: 'model_registry_fallback'
        }
      }
    });
    expect(contract.contextBudget).toBeUndefined();
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(getThinkingCapabilityStatus(contract)).toEqual({
      supported: true,
      qualified: false,
      source: 'model_registry_fallback',
      qualificationState: 'unknown',
      visibleFinalQualified: false
    });
  });

  it('creates a deterministic campaign-freeze snapshot without request text', async () => {
    const deps = {
      now: new Date('2026-07-25T04:00:00Z'),
      configuredHosts: HOSTS,
      modelProfilesCollection: profileCollection(null),
      resolveContextDetails: jest.fn(async () => ({
        num_ctx: 16384,
        source: 'model_context_profile'
      }))
    };
    const snapshot = await resolveInferenceContractSnapshot({
      model: 'model-a',
      host: HOSTS[0].url,
      prompt: 'this attempt-specific prompt must not enter the frozen snapshot',
      requestedMaxOutputTokens: 4096
    }, deps);
    const repeated = await resolveInferenceContractSnapshot({
      model: 'model-a',
      host: HOSTS[0].url,
      prompt: 'different attempt',
      requestedMaxOutputTokens: 4096
    }, {
      ...deps,
      now: new Date('2026-07-25T05:00:00Z')
    });

    expect(snapshot.snapshot).toMatchObject({
      schemaVersion: 1,
      resolvedAt: '2026-07-25T04:00:00.000Z',
      scope: 'deployed_artifact_host',
      freezeRecommended: true,
      reusePolicy: 'resolve_once_per_campaign'
    });
    expect(snapshot.snapshot.fingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(snapshot.snapshot.fingerprint).toBe(repeated.snapshot.fingerprint);
    expect(snapshot.contextBudget.windowTokens).toBe(16384);
    expect(snapshot.contextBudget.output.reservedTokens).toBe(4096);
    expect(snapshot.contextBudget.input.estimatedTokens).toBe(0);
  });

  it('binds a campaign snapshot fingerprint to the deployed Ollama artifact digest', async () => {
    const baseDeps = {
      now: new Date('2026-07-25T04:00:00Z'),
      configuredHosts: HOSTS,
      hostProfilesCollection: profileCollection({ hostId: 'primary', hostUrl: HOSTS[0].url }),
      modelProfilesCollection: profileCollection(null),
      resolveContextDetails: jest.fn(async () => ({
        num_ctx: 32768,
        source: 'model_context_profile'
      }))
    };
    const first = await resolveInferenceContractSnapshot({
      model: 'ax/model-a:latest',
      host: HOSTS[0].url
    }, {
      ...baseDeps,
      resolveArtifactDigest: jest.fn(async () => 'sha256:first'),
      registryEntry: {
        _id: 'registry-a',
        modelName: 'ax/model-a',
        installations: [{ hostUrl: HOSTS[0].url, digest: 'sha256:first', status: 'active', isActive: true }]
      }
    });
    const repulled = await resolveInferenceContractSnapshot({
      model: 'ax/model-a:latest',
      host: HOSTS[0].url
    }, {
      ...baseDeps,
      resolveArtifactDigest: jest.fn(async () => 'sha256:second'),
      registryEntry: {
        _id: 'registry-a',
        modelName: 'ax/model-a',
        installations: [{ hostUrl: HOSTS[0].url, digest: 'sha256:second', status: 'active', isActive: true }]
      }
    });

    expect(first.artifact).toMatchObject({
      model: 'ax/model-a',
      digest: 'sha256:first',
      identityQualified: true,
      identitySource: 'core_registry+ollama_tags'
    });
    expect(first.snapshot.fingerprint).not.toBe(repulled.snapshot.fingerprint);
  });

  it('labels token estimates as approximate', () => {
    expect(estimateInputTokens({
      messages: [{ role: 'user', content: '12345678' }]
    })).toEqual({
      tokens: 8,
      characters: 8,
      method: 'token_counter_plus_message_overhead',
      exact: false
    });
  });
});
