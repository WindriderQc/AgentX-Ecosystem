'use strict';

const {
  sameOriginUiAllowed,
  operatorUiAccessAllowed,
  operatorAccessAllowed,
  operatorRequestIdentity,
} = require('../../src/middleware/operatorAccess');

function request(headers = {}, overrides = {}) {
  const normalized = Object.fromEntries(Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]));
  return {
    ip: '192.0.2.12',
    protocol: 'http',
    get: (name) => normalized[String(name).toLowerCase()],
    ...overrides
  };
}

describe('operator UI access', () => {
  const originalToken = process.env.AGENTX_OPERATOR_TOKEN;

  afterEach(() => {
    if (originalToken === undefined) delete process.env.AGENTX_OPERATOR_TOKEN;
    else process.env.AGENTX_OPERATOR_TOKEN = originalToken;
  });

  it('accepts a browser request from the same UI origin', () => {
    const req = request({
      origin: 'http://192.0.2.99:3080',
      host: '192.0.2.99:3080',
      'sec-fetch-site': 'same-origin'
    });
    expect(sameOriginUiAllowed(req)).toBe(true);
    expect(operatorUiAccessAllowed(req)).toBe(true);
  });

  it('rejects cross-origin and headerless LAN requests without a token', () => {
    delete process.env.AGENTX_OPERATOR_TOKEN;
    expect(sameOriginUiAllowed(request({
      origin: 'http://evil.example',
      host: '192.0.2.99:3080',
      'sec-fetch-site': 'cross-site'
    }))).toBe(false);
    expect(operatorUiAccessAllowed(request({ host: '192.0.2.99:3080' }))).toBe(false);
  });

  it('rejects a cross-site browser request even when the connection is loopback', () => {
    delete process.env.AGENTX_OPERATOR_TOKEN;
    const req = request({
      origin: 'https://evil.example',
      host: '127.0.0.1:3080',
      'sec-fetch-site': 'cross-site',
    }, { ip: '127.0.0.1' });

    expect(operatorAccessAllowed(req)).toBe(false);
    expect(operatorUiAccessAllowed(req)).toBe(false);
  });

  it('keeps headerless CLI and same-origin browser access on loopback', () => {
    delete process.env.AGENTX_OPERATOR_TOKEN;
    expect(operatorAccessAllowed(request({}, { ip: '127.0.0.1' }))).toBe(true);

    const browserReq = request({
      origin: 'http://127.0.0.1:3080',
      host: '127.0.0.1:3080',
      'sec-fetch-site': 'same-origin',
    }, { ip: '127.0.0.1' });
    expect(operatorAccessAllowed(browserReq)).toBe(true);
  });

  it('does not let forwarded host metadata forge same-origin access', () => {
    const req = request({
      origin: 'https://evil.example',
      host: '127.0.0.1:3080',
      'x-forwarded-host': 'evil.example',
      'x-forwarded-proto': 'https',
      'sec-fetch-site': 'same-origin',
    });
    expect(sameOriginUiAllowed(req)).toBe(false);
  });

  it('retains the operator-token path for non-browser callers', () => {
    process.env.AGENTX_OPERATOR_TOKEN = 'test-operator-token';
    const req = request({
      host: '192.0.2.99:3080',
      'x-agentx-operator-token': 'test-operator-token'
    });
    expect(operatorUiAccessAllowed(req)).toBe(true);
    expect(operatorAccessAllowed(req)).toBe(true);
    expect(operatorRequestIdentity(req)).toBe('operator-token');
  });

  it('accepts same-origin UI reads that carry Referer instead of Origin', () => {
    const req = request({
      referer: 'http://192.0.2.99:3080/memory-review',
      host: '192.0.2.99:3080',
      'sec-fetch-site': 'same-origin',
    });
    expect(sameOriginUiAllowed(req)).toBe(true);
  });

  it('accepts exact same-origin Referer from embedded browsers without Fetch Metadata', () => {
    const req = request({
      referer: 'http://192.0.2.99:3080/memory-review',
      host: '192.0.2.99:3080',
    });
    expect(sameOriginUiAllowed(req)).toBe(true);
  });

  it('rejects an explicit cross-site hint even when Origin is forged to match', () => {
    const req = request({
      origin: 'http://192.0.2.99:3080',
      host: '192.0.2.99:3080',
      'sec-fetch-site': 'cross-site',
    });
    expect(sameOriginUiAllowed(req)).toBe(false);
  });

  it('does not treat same-origin browser identity as a caller-supplied name', () => {
    const req = request({
      origin: 'http://192.0.2.99:3080',
      host: '192.0.2.99:3080',
      'sec-fetch-site': 'same-origin',
      'x-agentx-operator-id': 'forged-name',
    });
    expect(operatorRequestIdentity(req)).toBe('same-origin-ui');
  });
});
