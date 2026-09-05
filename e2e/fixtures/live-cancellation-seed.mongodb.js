'use strict';

const executionModel = 'agentx-cancel-fixture:1';
const executionDigest = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const hostId = 'primary';
const hostUrl = 'http://ollama-fixture:11434';
const registryId = ObjectId('65f000000000000000000100');
const performanceEvidenceId = ObjectId('65f000000000000000000101');
const prompt1Id = ObjectId('66d000000000000000000001');
const prompt2Id = ObjectId('66d000000000000000000002');
const runtimeFingerprint = '79047f2496ffb27ae0bc420274c2036aa42dbce3f84f260c0d6f49f38dbe35d3';
const now = new Date();

const seededCollections = [
  'hostprofiles',
  'modelregistries',
  'modelprofiles',
  'modelcontextprofiles',
  'modelperformanceprofiles',
  'benchmarkprompts',
];

for (const name of seededCollections) {
  if (db.getCollection(name).countDocuments({}) !== 0) {
    throw new Error(`Live cancellation seed requires an empty ${name} collection`);
  }
}

const hostIdentity = {
  hostId,
  hostUrl,
  displayName: 'Live cancellation fixture',
  gpu: {
    model: 'CI fixture',
    vramTotalMiB: 8192,
    computeCapability: 'fixture',
    driver: 'fixture',
  },
  ollama: {
    version: 'fixture-1',
    backend: 'CPU',
    cudaVersion: null,
  },
  cpu: {
    cores: 1,
    threadOverride: null,
  },
  baseline: {
    referenceModel: executionModel,
    tokensPerSec: 100,
    latencyMs: 1,
    ttftMs: 1,
    testedAt: now,
  },
  status: 'online',
  lastSeenAt: now,
  createdAt: now,
  updatedAt: now,
};

const artifact = {
  model: executionModel,
  hostId,
  hostUrl,
  digest: executionDigest,
  runtimeFingerprint,
  registryId: registryId.toString(),
  registryDigest: executionDigest,
  registryQualified: true,
};

db.hostprofiles.insertOne(hostIdentity);

db.modelregistries.insertOne({
  _id: registryId,
  modelName: executionModel,
  displayName: 'Live cancellation execution fixture',
  vendor: 'unknown',
  description: 'Ephemeral CI-only cancellation fixture',
  userNote: '',
  categories: ['reasoning'],
  tags: ['ci', 'live-cancellation'],
  capabilities: {
    maxContext: 4096,
    supportsThinking: false,
    supportsVision: false,
    optimalBatchSize: 1,
  },
  host: hostUrl,
  sourceType: 'ollama',
  sourceHost: hostUrl,
  ollamaDigest: executionDigest,
  installations: [{
    hostUrl,
    digest: executionDigest,
    lastSeenAt: now,
    modelSizeBytes: 1,
    parameterSize: '1B',
    quantization: 'Q4_0',
    family: 'fixture',
    status: 'active',
    isActive: true,
  }],
  lastSeenAt: now,
  modelSizeBytes: 1,
  parameterSize: '1B',
  quantization: 'Q4_0',
  family: 'fixture',
  executionDefaults: {
    num_ctx: 4096,
    temperature: 0.2,
    _source: 'system',
    _reason: 'live cancellation fixture',
    _detectedAt: now,
  },
  executionOverrides: {},
  isActive: true,
  status: 'active',
  createdBy: 'live-cancellation-fixture',
  lastUpdated: now,
  notes: '',
  createdAt: now,
  updatedAt: now,
});

db.modelprofiles.insertOne({
  name: executionModel,
  displayName: 'Live cancellation execution fixture',
  provider: 'ollama',
  family: 'fixture',
  parameters: '1B',
  quantization: 'Q4_0',
  capabilities: {
    maxContext: 4096,
    vision: false,
    tools: false,
    thinking: false,
    thinkingPolicy: 'off',
  },
  thinkingProfiles: {},
  hosts: {
    primary: { available: true, lastSeen: now },
  },
  readiness: {
    primary: {
      stage: 'profiled',
      profiledAt: now,
      profileDepth: 'standard',
      benchmarkQualified: true,
      qualificationReason: null,
      measurementReliability: 'medium',
      benchmarkedAt: null,
      stale: false,
      staleReason: null,
      evidenceId: performanceEvidenceId,
      authorityReceipt: {
        version: 1,
        source: 'profiler_pipeline',
        evidenceId: performanceEvidenceId.toString(),
        digest: 'a30d51d360c61b0975d5d9f5c6cbef9cf91ef6c0810a0fc2e86fe1aa34aeba0c',
        issuedAt: now,
      },
      artifact,
    },
  },
  tags: ['ci', 'live-cancellation'],
  categories: ['reasoning'],
  benchmarkStats: {
    bestCategory: null,
    worstCategory: null,
    avgCompositeScore: null,
    avgQualityScore: null,
    totalTests: 0,
    lastBenchmarked: null,
  },
  createdAt: now,
  updatedAt: now,
});

db.modelcontextprofiles.insertOne({
  modelName: executionModel,
  hostUrl,
  hostId,
  artifactDigest: executionDigest,
  runtimeFingerprint,
  verifiedMaxContext: 4096,
  verifiedInputTokens: 3500,
  recommendedContext: 4096,
  modelTheoreticalMax: 4096,
  source: 'context_probe',
  stale: false,
  staleReason: null,
  lastValidatedAt: now,
  latestEvidence: {
    snapshotId: 'live-cancellation-fixture',
    testedNumCtx: 4096,
    promptFillPct: 50,
    promptTokens: 2048,
    tokensPerSec: 100,
    vramUsedMiB: 1,
    gpuPercent: 1,
    degradationPct: 0,
    completionTokens: 1,
    requestedCompletionTokens: 1,
    minCompletionTokens: 1,
    testDurationMs: 1,
    testedAt: now,
    source: 'context_probe',
  },
  createdAt: now,
  updatedAt: now,
});

db.modelperformanceprofiles.insertOne({
  _id: performanceEvidenceId,
  modelName: executionModel,
  hostId,
  artifact,
  profile: {
    profiledAt: now,
    profileDepth: 'standard',
    requiredRetainedSamples: 5,
    requiredTtftSamples: 5,
    measurementQuality: {
      passingSampleCount: 5,
      ttftSampleCount: 5,
      reliability: 'medium',
    },
    tokensPerSec: 100,
    promptEvalTokensPerSec: 100,
    ttftMs: 1,
    ttftMeasurement: 'streamed_wall_clock',
    vramUsedMiB: 1,
    maxVerifiedContext: 4096,
    recommendedInteractiveContext: 4096,
    recommendedDocumentContext: 4096,
    spill: { verified: true, spillDetected: false },
    optimalNumCtx: 4096,
    recommendedConfig: { num_ctx: 4096 },
    loadTiming: { hotLoadMs: 1 },
  },
  active: true,
  stale: false,
  staleReason: null,
  createdAt: now,
  updatedAt: now,
});

const promptDefaults = {
  level: 1,
  category: 'reasoning',
  expected_tokens: 16,
  scoring_type: 'reasoning',
  scoring_plan: 'deterministic',
  deterministic_scoring: {
    type: 'exact',
    case_sensitive: false,
    trim_only: true,
  },
  expected_answer: 'ok',
  reference_answer: 'ok',
  representative: false,
  custom: true,
  created_at: now,
  updated_at: now,
};

db.benchmarkprompts.insertMany([
  {
    _id: prompt1Id,
    ...promptDefaults,
    name: 'Live cancellation prompt 1',
    prompt: 'AGENTX_LIVE_CANCEL_PROMPT_1',
  },
  {
    _id: prompt2Id,
    ...promptDefaults,
    name: 'Live cancellation prompt 2',
    prompt: 'AGENTX_LIVE_CANCEL_PROMPT_2',
  },
]);

print(JSON.stringify({
  ok: true,
  fixture: 'agentx-live-cancellation-seed',
  promptIds: [prompt1Id.toString(), prompt2Id.toString()],
}));
