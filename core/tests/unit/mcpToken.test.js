'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const {
  mcpIngressAllowed,
  tokenAllowed,
  tokensMatch,
} = require('../../src/helpers/mcpToken');
const { planningAutomationAllowed } = require('../../src/helpers/planningAutomationAuth');

function request(headers = {}, overrides = {}) {
  const normalized = Object.fromEntries(
    Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value])
  );
  return {
    ip: '198.51.100.20',
    protocol: 'http',
    get: (name) => normalized[String(name).toLowerCase()],
    ...overrides,
  };
}

describe('MCP ingress authorization', () => {
  const saved = Object.fromEntries([
    'AGENTX_MCP_TOKEN',
    'AGENTX_OPERATOR_TOKEN',
    'AGENTX_ADMIN_TOKEN',
    'AGENTX_TRUST_LOOPBACK_PROXY_UI',
    'NODE_ENV',
  ].map((name) => [name, process.env[name]]));

  beforeEach(() => {
    delete process.env.AGENTX_MCP_TOKEN;
    delete process.env.AGENTX_OPERATOR_TOKEN;
    delete process.env.AGENTX_ADMIN_TOKEN;
    delete process.env.AGENTX_TRUST_LOOPBACK_PROXY_UI;
    process.env.NODE_ENV = 'test';
  });

  afterAll(() => {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });

  test('uses timing-safe equality for same-length non-empty token values', () => {
    const timingSafeEqual = jest.spyOn(crypto, 'timingSafeEqual');
    expect(tokensMatch('mcp-token', 'mcp-token')).toBe(true);
    expect(tokensMatch('mcp-token', 'mcp-tokem')).toBe(false);
    expect(tokensMatch('', '')).toBe(false);
    expect(timingSafeEqual).toHaveBeenCalledTimes(2);
    timingSafeEqual.mockRestore();
  });

  test('the purpose-scoped token gate fails closed when unset and rejects wrong values', () => {
    const remote = request({ host: 'agentx.example.test' });
    expect(tokenAllowed(remote)).toBe(false);
    expect(tokenAllowed(remote, { allowUnset: true })).toBe(true);

    process.env.AGENTX_MCP_TOKEN = 'mcp-token';
    expect(tokenAllowed(request({ host: 'agentx.example.test', authorization: 'Bearer wrong-token' }))).toBe(false);
    expect(tokenAllowed(request({ host: 'agentx.example.test', 'x-agentx-mcp-token': 'wrong-token' }))).toBe(false);
  });

  test('accepts Bearer and X-AgentX-MCP-Token independently', () => {
    process.env.AGENTX_MCP_TOKEN = 'mcp-token';
    expect(tokenAllowed(request({ authorization: 'Bearer mcp-token' }))).toBe(true);
    expect(tokenAllowed(request({ 'x-agentx-mcp-token': 'mcp-token' }))).toBe(true);
    expect(tokenAllowed(request({
      authorization: 'Bearer unrelated-token',
      'x-agentx-mcp-token': 'mcp-token',
    }))).toBe(true);
  });

  test('preserves loopback, loopback-published, and operator ingress while rejecting remote anonymous traffic', () => {
    expect(mcpIngressAllowed(request({ host: 'agentx.example.test' }))).toBe(false);
    expect(mcpIngressAllowed(request({ host: '127.0.0.1:3080' }, { ip: '127.0.0.1' }))).toBe(true);

    process.env.AGENTX_TRUST_LOOPBACK_PROXY_UI = 'true';
    expect(mcpIngressAllowed(request({ host: '127.0.0.1:3180' }, { ip: '172.20.0.1' }))).toBe(true);
    expect(mcpIngressAllowed(request({
      host: '127.0.0.1:3180',
      origin: 'https://evil.example',
      'sec-fetch-site': 'cross-site',
    }, { ip: '172.20.0.1' }))).toBe(false);

    process.env.AGENTX_OPERATOR_TOKEN = 'operator-token';
    expect(mcpIngressAllowed(request({
      host: 'agentx.example.test',
      'x-agentx-operator-token': 'operator-token',
    }))).toBe(true);
  });

  test('does not weaken the planning automation token contract', () => {
    const local = request({ host: '127.0.0.1:3080' }, { ip: '127.0.0.1' });
    process.env.NODE_ENV = 'production';
    expect(planningAutomationAllowed(local)).toMatchObject({
      allowed: false,
      status: 503,
      code: 'PLANNING_AUTOMATION_TOKEN_REQUIRED',
    });

    process.env.AGENTX_MCP_TOKEN = 'planning-token';
    expect(planningAutomationAllowed(local)).toMatchObject({
      allowed: false,
      status: 401,
      code: 'PLANNING_AUTOMATION_UNAUTHORIZED',
    });
    expect(planningAutomationAllowed(request({
      host: 'agentx.example.test',
      'x-agentx-mcp-token': 'planning-token',
    }))).toEqual({ allowed: true });

    delete process.env.AGENTX_MCP_TOKEN;
    process.env.NODE_ENV = 'test';
    expect(planningAutomationAllowed(local)).toEqual({ allowed: true });
  });

  test('keeps the Compose MCP token configurable without shipping a default secret', () => {
    const compose = fs.readFileSync(path.resolve(__dirname, '..', '..', '..', 'docker-compose.yml'), 'utf8');
    expect(compose).toContain('AGENTX_MCP_TOKEN: ${AGENTX_MCP_TOKEN:-}');
    expect(compose).not.toContain('AGENTX_MCP_TOKEN: ""');
  });
});
