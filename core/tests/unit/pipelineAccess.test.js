'use strict';

const {
  PIPELINE_TOKEN_HEADER,
  PIPELINE_AUTHORITY,
  pipelineWorkerTokenAllowed,
  pipelineRequestAuthority,
  pipelineMutationDecision,
} = require('../../src/helpers/pipelineAccess');

const ENV_KEYS = [
  'AGENTX_PIPELINE_TOKEN',
  'AGENTX_OPERATOR_TOKEN',
  'AGENTX_ADMIN_TOKEN',
  'AGENTX_TRUST_INTERNAL_SERVICE_HOSTS',
  'AGENTX_TRUST_LOOPBACK_PROXY_UI',
  'AGENTX_OPERATOR_UI_HOSTS',
  'AGENTX_TRUSTED_UI_HOSTS',
  'CORE_PUBLIC_URL',
];
const originalEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));

function request({ headers = {}, ip = '203.0.113.9', protocol = 'http' } = {}) {
  const normalized = Object.fromEntries(
    Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value])
  );
  return {
    ip,
    protocol,
    socket: { remoteAddress: ip },
    get(name) {
      return normalized[String(name).toLowerCase()];
    },
  };
}

describe('pipeline machine access', () => {
  beforeEach(() => {
    for (const key of ENV_KEYS) delete process.env[key];
  });

  afterAll(() => {
    for (const [key, value] of Object.entries(originalEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  test('accepts only the dedicated exact worker credential', () => {
    process.env.AGENTX_PIPELINE_TOKEN = 'pipeline-secret';

    expect(PIPELINE_TOKEN_HEADER).toBe('X-AgentX-Pipeline-Token');
    expect(pipelineWorkerTokenAllowed(request({
      headers: { 'x-agentx-pipeline-token': 'pipeline-secret' },
    }))).toBe(true);
    expect(pipelineWorkerTokenAllowed(request({
      headers: { 'x-agentx-pipeline-token': 'not-the-secret' },
    }))).toBe(false);
    expect(pipelineWorkerTokenAllowed(request({
      headers: { authorization: 'Bearer pipeline-secret' },
    }))).toBe(false);
  });

  test.each([
    ['unset token and no header', undefined, undefined],
    ['unset token and invented header', undefined, 'invented-secret'],
    ['configured token and no header', 'pipeline-secret', undefined],
    ['configured token and wrong header', 'pipeline-secret', 'wrong-secret'],
  ])('fails closed for an untrusted remote caller with %s', (_label, configured, presented) => {
    if (configured !== undefined) process.env.AGENTX_PIPELINE_TOKEN = configured;
    const headers = { host: 'remote-worker.example' };
    if (presented !== undefined) headers['x-agentx-pipeline-token'] = presented;

    expect(pipelineRequestAuthority(request({ headers }))).toBe(PIPELINE_AUTHORITY.NONE);
  });

  test('preserves same-origin UI, operator, and explicitly trusted internal authorities', () => {
    process.env.AGENTX_OPERATOR_TOKEN = 'operator-secret';
    process.env.AGENTX_TRUST_INTERNAL_SERVICE_HOSTS = 'true';

    expect(pipelineRequestAuthority(request({
      ip: '127.0.0.1',
      headers: {
        host: '127.0.0.1:3080',
        origin: 'http://127.0.0.1:3080',
        'sec-fetch-site': 'same-origin',
      },
    }))).toBe(PIPELINE_AUTHORITY.TRUSTED_CONTROL);
    expect(pipelineRequestAuthority(request({
      headers: {
        host: 'operator.example',
        'x-agentx-operator-token': 'operator-secret',
      },
    }))).toBe(PIPELINE_AUTHORITY.OPERATOR);
    expect(pipelineRequestAuthority(request({
      headers: { host: 'core:3080' },
    }))).toBe(PIPELINE_AUTHORITY.TRUSTED_CONTROL);
  });

  test('keeps an explicitly presented worker token worker-scoped on loopback transport', () => {
    process.env.AGENTX_PIPELINE_TOKEN = 'pipeline-secret';
    const loopbackWorker = request({
      ip: '127.0.0.1',
      headers: {
        host: 'agentx.example.test',
        'x-agentx-pipeline-token': 'pipeline-secret',
      },
    });

    expect(pipelineRequestAuthority(loopbackWorker)).toBe(PIPELINE_AUTHORITY.WORKER);
    expect(pipelineMutationDecision(loopbackWorker, { finalizesTask: true })).toMatchObject({
      allowed: false,
      code: 'PIPELINE_FINALIZE_REQUIRES_CONTROL_AUTHORITY',
    });
  });

  test('lets an operator token override worker scope while keeping worker feedback non-final', () => {
    process.env.AGENTX_PIPELINE_TOKEN = 'pipeline-secret';
    process.env.AGENTX_OPERATOR_TOKEN = 'operator-secret';
    const operator = request({
      headers: {
        'x-agentx-pipeline-token': 'pipeline-secret',
        'x-agentx-operator-token': 'operator-secret',
      },
    });
    const worker = request({
      headers: { 'x-agentx-pipeline-token': 'pipeline-secret' },
    });

    expect(pipelineMutationDecision(operator, { finalizesTask: true })).toMatchObject({
      allowed: true,
      authority: PIPELINE_AUTHORITY.OPERATOR,
    });
    expect(pipelineMutationDecision(worker, { finalizesTask: false })).toMatchObject({
      allowed: true,
      authority: PIPELINE_AUTHORITY.WORKER,
    });
  });
});
