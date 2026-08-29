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
  const originalUiHosts = process.env.AGENTX_OPERATOR_UI_HOSTS;
  const originalCorePublicUrl = process.env.CORE_PUBLIC_URL;
  const originalLoopbackProxyTrust = process.env.AGENTX_TRUST_LOOPBACK_PROXY_UI;
  const originalTrustedProxyAddresses = process.env.AGENTX_TRUSTED_UI_PROXY_ADDRESSES;

  afterEach(() => {
    if (originalToken === undefined) delete process.env.AGENTX_OPERATOR_TOKEN;
    else process.env.AGENTX_OPERATOR_TOKEN = originalToken;
    if (originalUiHosts === undefined) delete process.env.AGENTX_OPERATOR_UI_HOSTS;
    else process.env.AGENTX_OPERATOR_UI_HOSTS = originalUiHosts;
    if (originalCorePublicUrl === undefined) delete process.env.CORE_PUBLIC_URL;
    else process.env.CORE_PUBLIC_URL = originalCorePublicUrl;
    if (originalLoopbackProxyTrust === undefined) delete process.env.AGENTX_TRUST_LOOPBACK_PROXY_UI;
    else process.env.AGENTX_TRUST_LOOPBACK_PROXY_UI = originalLoopbackProxyTrust;
    if (originalTrustedProxyAddresses === undefined) delete process.env.AGENTX_TRUSTED_UI_PROXY_ADDRESSES;
    else process.env.AGENTX_TRUSTED_UI_PROXY_ADDRESSES = originalTrustedProxyAddresses;
  });

  it('does not treat a remote same-origin header set as operator identity', () => {
    process.env.AGENTX_OPERATOR_UI_HOSTS = '192.0.2.99';
    const req = request({
      origin: 'http://192.0.2.99:3080',
      host: '192.0.2.99:3080',
      'sec-fetch-site': 'same-origin'
    });
    expect(sameOriginUiAllowed(req)).toBe(false);
    expect(operatorUiAccessAllowed(req)).toBe(false);
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
    expect(operatorAccessAllowed(request({
      'sec-fetch-mode': 'cors',
    }, { ip: '127.0.0.1' }))).toBe(true);

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

  it('rejects forged localhost same-origin headers from a remote connection', () => {
    delete process.env.AGENTX_TRUST_LOOPBACK_PROXY_UI;
    const req = request({
      origin: 'http://localhost:3080',
      host: 'localhost:3080',
      'sec-fetch-site': 'same-origin',
    }, { ip: '198.51.100.7' });

    expect(sameOriginUiAllowed(req)).toBe(false);
    expect(operatorUiAccessAllowed(req)).toBe(false);
  });

  it('accepts the loopback-published Compose UI only with explicit proxy trust', () => {
    process.env.AGENTX_TRUST_LOOPBACK_PROXY_UI = 'true';
    const req = request({
      origin: 'http://localhost:3180',
      host: 'localhost:3180',
      'sec-fetch-site': 'same-origin',
    }, { ip: '172.20.0.1' });

    expect(sameOriginUiAllowed(req)).toBe(true);
    expect(operatorUiAccessAllowed(req)).toBe(true);
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

  it('accepts local same-origin UI reads that carry Referer instead of Origin', () => {
    const req = request({
      referer: 'http://127.0.0.1:3080/memory-review',
      host: '127.0.0.1:3080',
      'sec-fetch-site': 'same-origin',
    }, { ip: '127.0.0.1' });
    expect(sameOriginUiAllowed(req)).toBe(true);
  });

  it('accepts exact local same-origin Referer from embedded browsers without Fetch Metadata', () => {
    const req = request({
      referer: 'http://127.0.0.1:3080/memory-review',
      host: '127.0.0.1:3080',
    }, { ip: '127.0.0.1' });
    expect(sameOriginUiAllowed(req)).toBe(true);
  });

  it('binds a deployment-owned remote UI host to its exact trusted proxy source', () => {
    process.env.AGENTX_OPERATOR_UI_HOSTS = '192.0.2.99';
    process.env.AGENTX_TRUSTED_UI_PROXY_ADDRESSES = '172.18.0.1';
    const sameOrigin = request({
      referer: 'http://192.0.2.99/dad',
      host: '192.0.2.99',
      'sec-fetch-site': 'same-origin',
    }, { ip: '::ffff:172.18.0.1', protocol: 'http' });
    const crossSite = request({
      origin: 'https://evil.example',
      host: '192.0.2.99',
      'sec-fetch-site': 'cross-site',
    }, { ip: '::ffff:172.18.0.1', protocol: 'http' });

    expect(sameOriginUiAllowed(sameOrigin)).toBe(true);
    expect(operatorUiAccessAllowed(sameOrigin)).toBe(true);
    expect(sameOriginUiAllowed(crossSite)).toBe(false);
    expect(operatorUiAccessAllowed(crossSite)).toBe(false);
  });

  it('rejects an explicit cross-site hint even when Origin is forged to match', () => {
    process.env.AGENTX_OPERATOR_UI_HOSTS = '192.0.2.99';
    const req = request({
      origin: 'http://192.0.2.99:3080',
      host: '192.0.2.99:3080',
      'sec-fetch-site': 'cross-site',
    });
    expect(sameOriginUiAllowed(req)).toBe(false);
  });

  it('does not treat same-origin browser identity as a caller-supplied name', () => {
    const req = request({
      origin: 'http://127.0.0.1:3080',
      host: '127.0.0.1:3080',
      'sec-fetch-site': 'same-origin',
      'x-agentx-operator-id': 'forged-name',
    }, { ip: '127.0.0.1' });
    expect(operatorRequestIdentity(req)).toBe('loopback-operator');
    expect(operatorRequestIdentity(req)).not.toBe('forged-name');
  });

  it('rejects a DNS-rebinding origin even when it matches Host on a loopback connection', () => {
    delete process.env.AGENTX_OPERATOR_UI_HOSTS;
    delete process.env.CORE_PUBLIC_URL;
    const req = request({
      origin: 'http://attacker.example:3080',
      host: 'attacker.example:3080',
      'sec-fetch-site': 'same-origin',
    }, { ip: '127.0.0.1' });

    expect(sameOriginUiAllowed(req)).toBe(false);
    expect(operatorUiAccessAllowed(req)).toBe(false);
  });
});
