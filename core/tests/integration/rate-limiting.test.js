const {
  apiLimiter,
  automationControlLimiter,
  chatLimiter,
  isAutomationControlPath
} = require('../../src/middleware/rateLimiter');
const { handleChatRequest } = require('../../src/services/chatService');
const { runMiddlewareChain } = require('../helpers/runMiddleware');

jest.mock('../../src/services/chatService', () => ({
  handleChatRequest: jest.fn(async () => ({
    response: 'ok',
    model: 'test-model',
    target: 'test',
    routing: null,
    ragUsed: false,
    ragSources: []
  }))
}));

function getConversations(headers) {
  return runMiddlewareChain([
    apiLimiter,
    (req, res) => res.json({ status: 'success', data: [] })
  ], {
    method: 'GET',
    path: '/api/conversations',
    headers
  });
}

function postChat(headers) {
  return runMiddlewareChain([
    chatLimiter,
    async (req, res, next) => {
      try {
        const result = await handleChatRequest(req.body);
        res.json({ status: 'success', data: result });
      } catch (err) {
        next(err);
      }
    }
  ], {
    method: 'POST',
    path: '/api/chat',
    headers,
    body: { model: 'test-model', message: 'Test message' }
  });
}

function getAutomationPath(path, headers) {
  return runMiddlewareChain([
    automationControlLimiter,
    apiLimiter,
    (req, res) => res.json({ status: 'success', data: [] })
  ], {
    method: 'GET',
    path,
    headers
  });
}

describe('Rate Limiting Middleware', () => {
  it('includes rate limit headers in response', async () => {
    const res = await getConversations({ 'x-test-client': 'rl-headers' });

    expect(res.headers).toHaveProperty('ratelimit-limit');
    expect(res.headers).toHaveProperty('ratelimit-remaining');
    expect(res.headers).toHaveProperty('ratelimit-reset');
  });

  it('enforces chat rate limit', async () => {
    for (let i = 0; i < 20; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      const res = await postChat({ 'x-test-client': 'rl-chat' });
      expect(res.status).not.toBe(429);
    }

    const limited = await postChat({ 'x-test-client': 'rl-chat' });
    expect(limited.status).toBe(429);
  });

  it('enforces general API rate limit', async () => {
    // apiLimiter max is 500 - fire all 500 allowed requests in parallel batches
    const batchSize = 50;
    for (let batch = 0; batch < 500 / batchSize; batch += 1) {
      const promises = Array.from({ length: batchSize }, () =>
        getConversations({ 'x-test-client': 'rl-general' })
      );
      // eslint-disable-next-line no-await-in-loop
      const results = await Promise.all(promises);
      for (const res of results) {
        expect(res.status).not.toBe(429);
      }
    }

    const limited = await getConversations({ 'x-test-client': 'rl-general' });
    expect(limited.status).toBe(429);
  });

  it('classifies only the automation route prefixes and their subpaths', () => {
    const makeReq = (originalUrl) => ({ originalUrl });
    expect(isAutomationControlPath(makeReq('/api/pipeline'))).toBe(true);
    expect(isAutomationControlPath(makeReq('/api/pipeline/tasks?status=queued'))).toBe(true);
    expect(isAutomationControlPath(makeReq('/api/pipeline-evil'))).toBe(false);
    expect(isAutomationControlPath(makeReq('/api/conversations'))).toBe(false);
  });

  it('keeps all automation prefixes out of the general 500-request bucket', async () => {
    const paths = ['/api/pipeline/tasks'];

    for (const [index, path] of paths.entries()) {
      const batchSize = 50;
      for (let batch = 0; batch < 600 / batchSize; batch += 1) {
        const promises = Array.from({ length: batchSize }, () =>
          getAutomationPath(path, {
            'x-test-client': `rl-automation-${index}`
          })
        );
        // eslint-disable-next-line no-await-in-loop
        const results = await Promise.all(promises);
        for (const res of results) {
          expect(res.status).not.toBe(429);
        }
      }
    }
  });

  it('retains the finite 5000-request automation ceiling', async () => {
    const headers = { 'x-test-client': 'rl-automation-finite' };
    const batchSize = 100;
    for (let batch = 0; batch < 5000 / batchSize; batch += 1) {
      const promises = Array.from({ length: batchSize }, () =>
        getAutomationPath('/api/pipeline/tasks', headers)
      );
      // eslint-disable-next-line no-await-in-loop
      const results = await Promise.all(promises);
      for (const res of results) {
        expect(res.status).not.toBe(429);
      }
    }

    const limited = await getAutomationPath('/api/pipeline/tasks', headers);
    expect(limited.status).toBe(429);
  });
});
