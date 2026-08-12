const mongoose = require('mongoose');

const ProbeStepSchema = new mongoose.Schema({
    numCtx: Number,
    tokPerSec: Number,
    vramMiB: Number
}, { _id: false });

const SpillSchema = new mongoose.Schema({
    spillDetected: Boolean,
    lastSafeNumCtx: Number,
    spillNumCtx: Number,
    vramAtSpill: Number,
    sizeVram: Number,
    sizeTotal: Number
}, { _id: false });

const ThroughputCurvePointSchema = new mongoose.Schema({
    contextFillPct: Number,
    numCtx: Number,
    tokensPerSec: Number,
    vramUsedMiB: Number,
    gpuOffloaded: Boolean
}, { _id: false });

const GenerationStabilityPointSchema = new mongoose.Schema({
    numPredict: Number,
    tokensPerSec: Number,
    totalLatencyMs: Number
}, { _id: false });

const LoadTimingSchema = new mongoose.Schema({
    coldLoadMs: Number,
    hotLoadMs: Number
}, { _id: false });

const PrefillDecodeCellSchema = new mongoose.Schema({
    prefillTokens: Number,
    decodeTokens: Number,
    status: {
        type: String,
        enum: ['pass', 'short_completion', 'error', 'skipped'],
        default: 'pass'
    },
    promptTokens: Number,
    completionTokens: Number,
    prefillTokensPerSec: Number,
    decodeTokensPerSec: Number,
    ttftMs: Number,
    latencyMs: Number,
    error: String
}, { _id: false });

// Fixed prefill/decode matrix (task 0365): absolute workload sizes shared by
// every model/host so prefill and decode throughput are directly comparable.
const PrefillDecodeMatrixSchema = new mongoose.Schema({
    measuredAt: Date,
    numCtx: Number,
    prefillTokens: { type: [Number], default: [] },
    decodeTokens: { type: [Number], default: [] },
    cellCount: Number,
    passCount: Number,
    skippedCount: Number,
    cells: [PrefillDecodeCellSchema]
}, { _id: false });

const HardwareGpuSnapshotSchema = new mongoose.Schema({
    index: Number,
    name: String,
    busId: String,
    utilizationPct: Number,
    memoryUsedMiB: Number,
    memoryTotalMiB: Number,
    powerDrawW: Number,
    powerLimitW: Number,
    temperatureC: Number,
    pcieGen: Number,
    pcieWidth: Number,
    source: String
}, { _id: false });

const HardwareDiagnosticsSchema = new mongoose.Schema({
    vramPressurePct: Number,
    gpuUtilizationPct: Number,
    gpuImbalancePct: Number,
    pcieWarning: String,
    thermalWarning: String,
    powerWarning: String,
    notes: { type: [String], default: [] }
}, { _id: false });

const HardwareTelemetrySnapshotSchema = new mongoose.Schema({
    phase: String,
    capturedAt: Date,
    ok: Boolean,
    source: String,
    gpuName: String,
    gpuCount: Number,
    utilization: Number,
    temperature: Number,
    powerDrawW: Number,
    pcieGen: Number,
    pcieWidth: Number,
    vramUsedMiB: Number,
    vramTotalMiB: Number,
    topology: String,
    gpus: [HardwareGpuSnapshotSchema],
    runningModels: [{
        name: String,
        sizeVramMiB: Number,
        sizeTotalMiB: Number
    }],
    diagnostics: HardwareDiagnosticsSchema,
    error: String
}, { _id: false });

const HardwareTelemetrySchema = new mongoose.Schema({
    enabled: { type: Boolean, default: true },
    source: String,
    capturedAt: Date,
    latest: HardwareTelemetrySnapshotSchema,
    diagnostics: HardwareDiagnosticsSchema,
    snapshots: [HardwareTelemetrySnapshotSchema]
}, { _id: false });

const ThroughputSampleSchema = new mongoose.Schema({
    sample: Number,
    tokensPerSec: Number,
    promptEvalTokensPerSec: Number,
    ttftMs: Number,
    latencyMs: Number,
    promptTokens: Number,
    completionTokens: Number,
    vramUsedMiB: Number,
    status: String,
    error: String,
    // When true, this sample is excluded from measurementQuality stats.
    // Used to drop the first (warm-up settle) run when 3+ samples are
    // requested, so CV reflects steady-state variance only.
    discarded: { type: Boolean, default: false },
    discardReason: String
}, { _id: false });

const MeasurementQualitySchema = new mongoose.Schema({
    sampleCount: Number,
    tokensPerSecMean: Number,
    tokensPerSecMedian: Number,
    tokensPerSecMin: Number,
    tokensPerSecMax: Number,
    tokensPerSecStdDev: Number,
    coefficientOfVariation: Number,
    reliability: {
        type: String,
        enum: ['high', 'medium', 'low', 'unknown'],
        default: 'unknown'
    }
}, { _id: false });

const ThinkingProbeCallSchema = new mongoose.Schema({
    probeName: String,
    promptHash: String,
    finalAnswerExpected: String,
    attempt: Number,
    numPredict: Number,
    retried: { type: Boolean, default: false },
    retryReason: String,
    initialNumPredict: Number,
    attempts: { type: [mongoose.Schema.Types.Mixed], default: undefined },
    requestedThink: Boolean,
    ok: { type: Boolean, default: false },
    error: String,
    channel: {
        type: String,
        enum: ['hidden', 'visible_tags', 'mixed', 'none', 'unknown', 'error'],
        default: 'unknown'
    },
    visibleFinalAnswerOk: { type: Boolean, default: false },
    finalAnswerContractOk: { type: Boolean, default: false },
    thinkingPresent: { type: Boolean, default: false },
    nativeThinkingPresent: { type: Boolean, default: false },
    visibleThinkingTags: { type: Boolean, default: false },
    thinkingOnlyResponse: { type: Boolean, default: false },
    runawayRisk: { type: Boolean, default: false },
    responseTruncated: { type: Boolean, default: false },
    doneReason: String,
    latencyMs: Number,
    promptTokens: Number,
    completionTokens: Number,
    tokensPerSec: Number,
    visibleChars: Number,
    thinkingChars: Number,
    rawContentChars: Number
}, { _id: false });

const ThinkingProfileSchema = new mongoose.Schema({
    profileVersion: Number,
    profiledAt: Date,
    apiMode: {
        type: String,
        enum: ['chat'],
        default: 'chat'
    },
    promptHash: String,
    probeCount: Number,
    probeAttempts: Number,
    retryProbeCount: Number,
    maxProbeNumPredict: Number,
    defaultProbeNumPredict: Number,
    supported: { type: Boolean, default: false },
    supportSignal: {
        type: String,
        enum: ['hidden_channel', 'visible_tags', 'mixed_channel', 'token_overhead', 'latency_overhead', 'none', 'error'],
        default: 'none'
    },
    supportSignals: [String],
    signalsByProbe: { type: mongoose.Schema.Types.Mixed, default: undefined },
    channel: {
        type: String,
        enum: ['hidden', 'visible_tags', 'mixed', 'none', 'unknown', 'error'],
        default: 'unknown'
    },
    visibleFinalAnswerOk: { type: Boolean, default: false },
    finalAnswerContractOk: { type: Boolean, default: false },
    thinkingOnlyResponse: { type: Boolean, default: false },
    runawayRisk: { type: Boolean, default: false },
    contractSensitive: { type: Boolean, default: false },
    contractlessVisibleAnswerOk: { type: Boolean, default: false },
    stressVisibleAnswerOk: { type: Boolean, default: false },
    tokenMultiplier: Number,
    latencyMultiplier: Number,
    recommendedPolicy: {
        type: String,
        enum: ['off', 'metered', 'on', 'disallowed', 'unknown'],
        default: 'unknown'
    },
    recommendationReason: String,
    control: ThinkingProbeCallSchema,
    think: ThinkingProbeCallSchema,
    probes: { type: mongoose.Schema.Types.Mixed, default: undefined }
}, { _id: false });

const DeploymentHistoryEntrySchema = new mongoose.Schema({
    status: String,
    deployedAt: Date,
    modelfileHash: String,
    error: String
}, { _id: false });

const LineageSchema = new mongoose.Schema({
    parentModel: String,
    rootModel: String,
    quantization: String,
    adaptedFrom: String,
    createdVia: { type: String, enum: ['profiler', 'manual'], default: 'profiler' }
}, { _id: false });

const ContextInsightSchema = new mongoose.Schema({
    previousNumCtx: Number,
    previousSource: String,
    discoveredNumCtx: Number,
    upgradeAvailable: Boolean,
    upgradeFactor: Number,
    recommendation: String
}, { _id: false });

const ModelAdaptationSchema = new mongoose.Schema({
    modelName: { type: String, required: true, index: true },
    hostId: { type: String, required: true, index: true },
    adaptedName: String,
    profile: {
        tokensPerSec: Number,
        promptEvalTokensPerSec: Number,
        ttftMs: Number,
        comparisonPromptTokens: Number,
        comparisonPromptTargetTokens: Number,
        contextProbeFillPct: Number,
        comparisonWorkloadMode: {
            type: String,
            enum: ['fixed', 'fixed_fallback_to_ctx', 'scaled'],
            default: 'fixed'
        },
        optimalNumCtx: Number,
        vramUsedMiB: Number,
        throughputSamples: [ThroughputSampleSchema],
        measurementQuality: MeasurementQualitySchema,
        degradationPct: Number,
        probeSteps: [ProbeStepSchema],
        profiledAt: Date,
        profileDepth: {
            type: String,
            enum: ['quick', 'standard', 'full'],
            default: 'standard'
        },
        spill: SpillSchema,
        contextInsight: ContextInsightSchema,
        thinking: ThinkingProfileSchema,
        throughputCurve: [ThroughputCurvePointSchema],
        generationStability: [GenerationStabilityPointSchema],
        prefillDecodeMatrix: PrefillDecodeMatrixSchema,
        loadTiming: LoadTimingSchema,
        hardwareTelemetry: HardwareTelemetrySchema
    },
    config: {
        num_ctx: Number,
        num_gpu: Number,
        num_batch: Number,
        num_thread: Number,
        num_predict: Number,
        num_keep: Number
    },
    modelfile: {
        content: String,
        generatedAt: Date,
        hash: String
    },
    deployment: {
        status: {
            type: String,
            enum: ['pending', 'deployed', 'failed', 'removed'],
            default: 'pending'
        },
        deployedAt: Date,
        ollamaDigest: String,
        error: String,
        history: [DeploymentHistoryEntrySchema]
    },
    staleness: {
        stale: { type: Boolean, default: false },
        reason: {
            type: String,
            enum: ['age', 'ollama_version', 'model_repulled', 'invalid_probe', null],
            default: null
        },
        lastCheckedAt: Date,
        profileAgeDays: Number
    },
    lineage: LineageSchema
}, { collection: 'modeladaptations', timestamps: true });

ModelAdaptationSchema.index(
    { modelName: 1, hostId: 1 },
    { unique: true, name: 'model_host_unique' }
);

module.exports = mongoose.model('ModelAdaptation', ModelAdaptationSchema);
