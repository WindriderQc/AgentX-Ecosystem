'use strict';

jest.mock('../../../src/clients/ollamaClient', () => ({
  chat: jest.fn()
}));
jest.mock('../../../config/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));

const { chat } = require('../../../src/clients/ollamaClient');
const {
  THINKING_PROFILE_VERSION,
  analyzeThinkingResponse,
  profileThinkingBehavior
} = require('../../../src/services/profiler/thinkingProfileService');

beforeEach(() => {
  jest.clearAllMocks();
});

describe('analyzeThinkingResponse()', () => {
  it('classifies native hidden thinking with visible final answer', () => {
    const out = analyzeThinkingResponse({
      message: {
        content: 'FINAL: 42',
        thinking: '17 + 25 = 42'
      },
      done_reason: 'stop',
      eval_count: 30,
      eval_duration: 1_000_000_000,
      prompt_eval_count: 20
    }, true, 1500);

    expect(out).toMatchObject({
      ok: true,
      channel: 'hidden',
      thinkingPresent: true,
      nativeThinkingPresent: true,
      visibleFinalAnswerOk: true,
      finalAnswerContractOk: true,
      thinkingOnlyResponse: false,
      runawayRisk: false,
      completionTokens: 30,
      tokensPerSec: 30
    });
  });

  it('classifies visible think tags without final answer as thinking-only runaway when truncated', () => {
    const out = analyzeThinkingResponse({
      message: { content: '<think>still working</think>' },
      done_reason: 'length',
      eval_count: 512
    }, true, 10000);

    expect(out).toMatchObject({
      channel: 'visible_tags',
      thinkingPresent: true,
      visibleFinalAnswerOk: false,
      finalAnswerContractOk: false,
      thinkingOnlyResponse: true,
      responseTruncated: true,
      runawayRisk: true
    });
  });
});

describe('profileThinkingBehavior()', () => {
  it('recommends metered when think=true is safe but expensive', async () => {
    chat
      .mockResolvedValueOnce({
        message: { content: 'FINAL: 42' },
        done_reason: 'stop',
        eval_count: 20,
        eval_duration: 1_000_000_000
      })
      .mockResolvedValueOnce({
        message: {
          content: 'FINAL: 42',
          thinking: 'long hidden chain'
        },
        done_reason: 'stop',
        eval_count: 100,
        eval_duration: 4_000_000_000
      })
      .mockResolvedValueOnce({
        message: {
          content: '42',
          thinking: 'long hidden chain'
        },
        done_reason: 'stop',
        eval_count: 90,
        eval_duration: 3_000_000_000
      })
      .mockResolvedValueOnce({
        message: {
          content: 'FINAL: 2',
          thinking: 'seat constraints'
        },
        done_reason: 'stop',
        eval_count: 110,
        eval_duration: 4_000_000_000
      });

    const profile = await profileThinkingBehavior('qwen3:8b', 'http://localhost:11434', {
      numCtx: 4096,
      numPredict: 512,
      timeoutMs: 5000
    });

    expect(profile.supported).toBe(true);
    expect(profile.supportSignal).toBe('hidden_channel');
    expect(profile.channel).toBe('hidden');
    expect(profile.tokenMultiplier).toBe(5);
    expect(profile.recommendedPolicy).toBe('metered');
    expect(profile.profileVersion).toBe(THINKING_PROFILE_VERSION);
    expect(profile.probeCount).toBe(4);
    expect(profile.probeAttempts).toBe(4);
    expect(profile.probes.contractless.visibleFinalAnswerOk).toBe(true);
    expect(chat).toHaveBeenCalledTimes(4);
  });

  it('retries contracted probes that hit the cap before marking them unsafe', async () => {
    chat
      .mockResolvedValueOnce({
        message: { content: 'FINAL: 42' },
        done_reason: 'stop',
        eval_count: 20
      })
      .mockResolvedValueOnce({
        message: {
          content: 'FINAL: 42',
          thinking: '17 + 25 = 42'
        },
        done_reason: 'stop',
        eval_count: 40
      })
      .mockResolvedValueOnce({
        message: {
          content: '42',
          thinking: '17 + 25 = 42'
        },
        done_reason: 'stop',
        eval_count: 42
      })
      .mockResolvedValueOnce({
        message: { thinking: 'still enumerating seats' },
        done_reason: 'length',
        eval_count: 512
      })
      .mockResolvedValueOnce({
        message: {
          content: 'FINAL: 2',
          thinking: 'Ben is 4, Ada is 3, Eli is 1, so Cy is 2'
        },
        done_reason: 'stop',
        eval_count: 96
      });

    const profile = await profileThinkingBehavior('gemma4:26b', 'http://localhost:11434');

    expect(profile.supported).toBe(true);
    expect(profile.visibleFinalAnswerOk).toBe(true);
    expect(profile.runawayRisk).toBe(false);
    expect(profile.retryProbeCount).toBe(1);
    expect(profile.probeAttempts).toBe(5);
    expect(profile.maxProbeNumPredict).toBe(2048);
    expect(profile.probes.reasoning_stress).toMatchObject({
      retried: true,
      initialNumPredict: 512,
      numPredict: 2048,
      visibleFinalAnswerOk: true,
      finalAnswerContractOk: true
    });
    expect(profile.recommendedPolicy).toBe('metered');
    expect(profile.recommendationReason).toMatch(/expanded probe budget/);
    expect(chat).toHaveBeenCalledTimes(5);
  });

  it('recommends disallowed when think=true returns thinking only', async () => {
    chat
      .mockResolvedValueOnce({
        message: { content: 'FINAL: 42' },
        done_reason: 'stop',
        eval_count: 20
      })
      .mockResolvedValueOnce({
        message: { content: '<think>still thinking</think>' },
        done_reason: 'length',
        eval_count: 512
      })
      .mockResolvedValueOnce({
        message: { content: '<think>still thinking</think>' },
        done_reason: 'length',
        eval_count: 1024
      })
      .mockResolvedValueOnce({
        message: { content: '42' },
        done_reason: 'stop',
        eval_count: 20
      })
      .mockResolvedValueOnce({
        message: { content: 'FINAL: 2' },
        done_reason: 'stop',
        eval_count: 24
      });

    const profile = await profileThinkingBehavior('qwen3:8b', 'http://localhost:11434');

    expect(profile.supported).toBe(true);
    expect(profile.channel).toBe('visible_tags');
    expect(profile.thinkingOnlyResponse).toBe(true);
    expect(profile.runawayRisk).toBe(true);
    expect(profile.recommendedPolicy).toBe('disallowed');
  });

  it('recommends off when think=true has no observable effect', async () => {
    chat
      .mockResolvedValueOnce({
        message: { content: 'FINAL: 42' },
        done_reason: 'stop',
        eval_count: 20
      })
      .mockResolvedValueOnce({
        message: { content: 'FINAL: 42' },
        done_reason: 'stop',
        eval_count: 21
      })
      .mockResolvedValueOnce({
        message: { content: '42' },
        done_reason: 'stop',
        eval_count: 20
      })
      .mockResolvedValueOnce({
        message: { content: 'FINAL: 2' },
        done_reason: 'stop',
        eval_count: 22
      });

    const profile = await profileThinkingBehavior('llama3:8b', 'http://localhost:11434');

    expect(profile.supported).toBe(false);
    expect(profile.supportSignal).toBe('none');
    expect(profile.recommendedPolicy).toBe('off');
  });

  it('marks models as contract-sensitive when only the contracted probes produce visible answers', async () => {
    chat
      .mockResolvedValueOnce({
        message: { content: 'FINAL: 42' },
        done_reason: 'stop',
        eval_count: 20
      })
      .mockResolvedValueOnce({
        message: {
          content: 'FINAL: 42',
          thinking: '17 + 25 = 42'
        },
        done_reason: 'stop',
        eval_count: 40
      })
      .mockResolvedValueOnce({
        message: { thinking: '17 + 25 = 42' },
        done_reason: 'stop',
        eval_count: 40
      })
      .mockResolvedValueOnce({
        message: {
          content: 'FINAL: 2',
          thinking: 'Ben is 4, Ada is 3, Eli is 1, so Cy is 2'
        },
        done_reason: 'stop',
        eval_count: 60
      });

    const profile = await profileThinkingBehavior('qwen3:8b', 'http://localhost:11434');

    expect(profile.supported).toBe(true);
    expect(profile.contractSensitive).toBe(true);
    expect(profile.contractlessVisibleAnswerOk).toBe(false);
    expect(profile.visibleFinalAnswerOk).toBe(true);
    expect(profile.thinkingOnlyResponse).toBe(false);
    expect(profile.recommendedPolicy).toBe('metered');
    expect(profile.recommendationReason).toMatch(/visible-final-answer contract/);
  });

  it('disallows auto thinking when the reasoning stress probe runs away', async () => {
    chat
      .mockResolvedValueOnce({
        message: { content: 'FINAL: 42' },
        done_reason: 'stop',
        eval_count: 20
      })
      .mockResolvedValueOnce({
        message: {
          content: 'FINAL: 42',
          thinking: '17 + 25 = 42'
        },
        done_reason: 'stop',
        eval_count: 40
      })
      .mockResolvedValueOnce({
        message: {
          content: '42',
          thinking: '17 + 25 = 42'
        },
        done_reason: 'stop',
        eval_count: 42
      })
      .mockResolvedValueOnce({
        message: { content: '<think>still enumerating seats</think>' },
        done_reason: 'length',
        eval_count: 512
      })
      .mockResolvedValueOnce({
        message: { content: '<think>still enumerating seats</think>' },
        done_reason: 'length',
        eval_count: 2048
      });

    const profile = await profileThinkingBehavior('qwen3:8b', 'http://localhost:11434');

    expect(profile.supported).toBe(true);
    expect(profile.stressVisibleAnswerOk).toBe(false);
    expect(profile.runawayRisk).toBe(true);
    expect(profile.retryProbeCount).toBe(1);
    expect(profile.probeAttempts).toBe(5);
    expect(profile.recommendedPolicy).toBe('disallowed');
  });

  it('marks the profile unknown when a contracted stress probe errors', async () => {
    chat
      .mockResolvedValueOnce({
        message: { content: 'FINAL: 42' },
        done_reason: 'stop',
        eval_count: 20
      })
      .mockResolvedValueOnce({
        message: {
          content: 'FINAL: 42',
          thinking: '17 + 25 = 42'
        },
        done_reason: 'stop',
        eval_count: 40
      })
      .mockResolvedValueOnce({
        message: {
          content: '42',
          thinking: '17 + 25 = 42'
        },
        done_reason: 'stop',
        eval_count: 42
      })
      .mockRejectedValueOnce(new Error('ollama timeout'));

    const profile = await profileThinkingBehavior('qwen3:8b', 'http://localhost:11434');

    expect(profile.supported).toBe(true);
    expect(profile.visibleFinalAnswerOk).toBe(false);
    expect(profile.recommendedPolicy).toBe('unknown');
    expect(profile.recommendationReason).toMatch(/contracted think=true behavior probe failed/);
  });
});
