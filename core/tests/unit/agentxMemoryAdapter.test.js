// Phase 6g — AgentX memory adapter unit tests.
// Mock the Mongoose models so we don't need a live DB.

jest.mock('../../models/Conversation', () => ({
  find: jest.fn(),
  countDocuments: jest.fn(),
}));
jest.mock('../../models/Alert', () => ({
  find: jest.fn(),
  countDocuments: jest.fn(),
}));
jest.mock('../../models/ActivityLog', () => ({
  find: jest.fn(),
  countDocuments: jest.fn(),
}));
jest.mock('../../models/InferenceLog', () => ({
  find: jest.fn(),
  countDocuments: jest.fn(),
}));

const Conversation = require('../../models/Conversation');
const Alert = require('../../models/Alert');
const ActivityLog = require('../../models/ActivityLog');
const InferenceLog = require('../../models/InferenceLog');
const mongoose = require('mongoose');
const { searchAgentx, statusForSource } = require('../../src/services/memoryAdapters');

const BenchmarkResult = {
  find: jest.fn(),
};
let originalBenchmarkResultModel;

function chainable(rows) {
  return {
    sort() { return this; },
    limit() { return this; },
    lean() { return Promise.resolve(rows); },
  };
}

describe('searchAgentx (Phase 6g)', () => {
  beforeAll(() => {
    originalBenchmarkResultModel = mongoose.models.BenchmarkResult;
    mongoose.models.BenchmarkResult = BenchmarkResult;
  });

  afterAll(() => {
    if (originalBenchmarkResultModel) mongoose.models.BenchmarkResult = originalBenchmarkResultModel;
    else delete mongoose.models.BenchmarkResult;
  });

  beforeEach(() => {
    Conversation.find.mockReset();
    Alert.find.mockReset();
    ActivityLog.find.mockReset();
    InferenceLog.find.mockReset();
    BenchmarkResult.find.mockReset();
    BenchmarkResult.find.mockReturnValue(chainable([]));
  });

  it('returns empty when terms cannot be extracted', async () => {
    const r = await searchAgentx('   ', 5);
    expect(r).toEqual([]);
  });

  it('returns scored snippets across collections', async () => {
    const now = new Date();
    Conversation.find.mockReturnValue(chainable([
      { _id: 'c1', title: 'Host Beta benchmarks', messages: [{ content: 'qwen Host Beta wedge note' }], updatedAt: now },
    ]));
    Alert.find.mockReturnValue(chainable([
      { _id: 'a1', title: 'Host Beta critical', message: 'host wedged', lastOccurrence: now },
    ]));
    ActivityLog.find.mockReturnValue(chainable([]));
    InferenceLog.find.mockReturnValue(chainable([]));

    const r = await searchAgentx('Host Beta', 5);
    expect(r.length).toBeGreaterThan(0);
    expect(r[0].source).toBe('agentx');
    expect(r.find(x => x.ref.startsWith('conversation:'))).toBeTruthy();
    expect(r.find(x => x.ref.startsWith('alert:'))).toBeTruthy();
    r.forEach(x => {
      expect(typeof x.score).toBe('number');
      expect(typeof x.text).toBe('string');
      expect(x.text.length).toBeLessThanOrEqual(500);
      expect(typeof x.collection).toBe('string');
      expect(Array.isArray(x.matchedFields)).toBe(true);
    });
  });

  it('ranks alert records before noisy benchmark chunks for alert queries', async () => {
    const now = new Date();
    Conversation.find.mockReturnValue(chainable([]));
    Alert.find.mockReturnValue(chainable([
      {
        _id: 'a1',
        title: 'Alert Triggered',
        message: 'Inference latency spike over threshold',
        ruleName: 'Inference latency',
        severity: 'warning',
        status: 'active',
        lastOccurrence: now,
      },
    ]));
    ActivityLog.find.mockReturnValue(chainable([]));
    InferenceLog.find.mockReturnValue(chainable([]));
    BenchmarkResult.find.mockReturnValue(chainable([
      {
        _id: 'b1',
        model: 'ax/noisy:latest',
        prompt: 'Design a caching system',
        response: 'alerts alert alert alert latency latency monitoring alert alert alert',
        task: 'coding',
        createdAt: now,
      },
    ]));

    const r = await searchAgentx('alert latency', 5);
    expect(r[0].ref).toBe('alert:a1');
    expect(r[0].collection).toBe('alert');
    expect(r[0].matchedFields).toEqual(expect.arrayContaining(['title', 'message', 'ruleName']));
    const benchmark = r.find(x => x.ref === 'benchmark:b1');
    expect(benchmark).toBeTruthy();
    expect(r[0].score).toBeGreaterThan(benchmark.score);
  });

  it('still returns benchmark results for benchmark-oriented queries', async () => {
    const now = new Date();
    Conversation.find.mockReturnValue(chainable([]));
    Alert.find.mockReturnValue(chainable([]));
    ActivityLog.find.mockReturnValue(chainable([]));
    InferenceLog.find.mockReturnValue(chainable([]));
    BenchmarkResult.find.mockReturnValue(chainable([
      {
        _id: 'b1',
        model: 'ax/gemma4:31b-it-q8_0',
        prompt: 'Benchmark throughput and judge score for coding level prompts',
        response: 'Composite quality score and tokens per second were recorded.',
        task: 'benchmark',
        createdAt: now,
      },
    ]));

    const r = await searchAgentx('benchmark throughput score', 5);
    expect(r.length).toBeGreaterThan(0);
    expect(r[0].ref).toBe('benchmark:b1');
    expect(r[0].collection).toBe('benchmark');
  });

  it('ranks chat and Buddy records before benchmark chunks for Buddy queries', async () => {
    const now = new Date();
    Conversation.find.mockReturnValue(chainable([
      {
        _id: 'c1',
        title: 'Buddy personality notes',
        messages: [{ content: 'Buddy chat should use Hermes personality.' }],
        updatedAt: now,
      },
    ]));
    Alert.find.mockReturnValue(chainable([]));
    ActivityLog.find.mockReturnValue(chainable([]));
    InferenceLog.find.mockReturnValue(chainable([
      {
        _id: 'i1',
        model: 'ax/gemma4:e4b',
        callerDetail: 'buddy/chat',
        taskType: 'buddy_reaction',
        status: 'success',
        createdAt: now,
      },
    ]));
    BenchmarkResult.find.mockReturnValue(chainable([
      {
        _id: 'b1',
        model: 'ax/noisy:latest',
        prompt: 'A benchmark prompt that mentions buddy chat several times',
        response: 'buddy buddy buddy chat chat chat',
        task: 'benchmark',
        createdAt: now,
      },
    ]));

    const r = await searchAgentx('buddy chat', 5);
    expect(['conversation:c1', 'inferencelog:i1']).toContain(r[0].ref);
    const benchmark = r.find(x => x.ref === 'benchmark:b1');
    expect(benchmark).toBeTruthy();
    expect(r[0].score).toBeGreaterThan(benchmark.score);
  });

  it('errors in one collection do not break others', async () => {
    Conversation.find.mockImplementation(() => { throw new Error('boom'); });
    Alert.find.mockReturnValue(chainable([
      { _id: 'a1', title: 'matches keyword', message: '', lastOccurrence: new Date() },
    ]));
    ActivityLog.find.mockReturnValue(chainable([]));
    InferenceLog.find.mockReturnValue(chainable([]));

    const r = await searchAgentx('keyword', 5);
    expect(r.length).toBeGreaterThan(0);
    expect(r[0].ref).toMatch(/^alert:/);
  });

  it('caps total at 2*k', async () => {
    const now = new Date();
    const many = Array.from({ length: 30 }, (_, i) => ({
      _id: 'c' + i, title: 'keyword keyword keyword #' + i, messages: [], updatedAt: now,
    }));
    Conversation.find.mockReturnValue(chainable(many));
    Alert.find.mockReturnValue(chainable([]));
    ActivityLog.find.mockReturnValue(chainable([]));
    InferenceLog.find.mockReturnValue(chainable([]));

    const r = await searchAgentx('keyword', 3);
    expect(r.length).toBeLessThanOrEqual(6);
  });
});

describe('statusForSource agentx (Phase 6g)', () => {
  beforeEach(() => {
    Conversation.countDocuments.mockReset();
    Alert.countDocuments.mockReset();
    ActivityLog.countDocuments.mockReset();
    InferenceLog.countDocuments.mockReset();
  });

  it('returns counts per collection', async () => {
    Conversation.countDocuments.mockResolvedValue(100);
    Alert.countDocuments.mockResolvedValue(5);
    ActivityLog.countDocuments.mockResolvedValue(2);
    InferenceLog.countDocuments.mockResolvedValue(50);

    const s = await statusForSource('agentx');
    expect(s.source).toBe('agentx');
    expect(s.available).toBe(true);
    expect(s.counts.conversations.total).toBe(100);
    expect(s.counts.alerts.total).toBe(5);
  });
});
