const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.join(__dirname, '../..');
const controllerSource = fs.readFileSync(path.join(root, 'public/js/nerve-center.js'), 'utf8');
const routingSource = fs.readFileSync(path.join(root, 'public/js/nerve-center-routing.js'), 'utf8');
const viewSource = fs.readFileSync(path.join(root, 'views/pages/nerve-center.ejs'), 'utf8');

function loadShared(fetchImpl) {
  const context = {
    console: { error: jest.fn(), warn: jest.fn(), log: jest.fn() },
    Date,
    document: { addEventListener: jest.fn() },
    fetch: fetchImpl,
    Promise,
    setTimeout,
    clearTimeout,
    URL,
    URLSearchParams,
    window: {
      AgentXUtils: { escapeHtml: value => String(value) }
    }
  };
  vm.runInNewContext(controllerSource, context, { filename: 'nerve-center.js' });
  return context.window.NerveCenterShared;
}

function response(data, status = 'success') {
  return {
    ok: true,
    status: 200,
    json: async () => ({ status, data })
  };
}

describe('Nerve Center ecosystem-v2 UI authority', () => {
  it('shares one in-flight and short-lived ecosystem snapshot request', async () => {
    const fetchImpl = jest.fn(async () => response({ schemaVersion: 2, generatedAt: '2026-08-28T12:00:00.000Z' }));
    const shared = loadShared(fetchImpl);

    const [first, second] = await Promise.all([
      shared.getEcosystemSnapshot(),
      shared.getEcosystemSnapshot()
    ]);
    const cached = await shared.getEcosystemSnapshot();

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl).toHaveBeenCalledWith('/api/nerve-center/ecosystem', undefined);
    expect(first.schemaVersion).toBe(2);
    expect(second.generatedAt).toBe(first.generatedAt);
    expect(cached.generatedAt).toBe(first.generatedAt);

    shared.invalidateEcosystemSnapshot();
    await shared.getEcosystemSnapshot();
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('rejects unsupported snapshots instead of rendering guessed fields', async () => {
    const shared = loadShared(jest.fn(async () => response({ schemaVersion: 1 })));

    await expect(shared.getEcosystemSnapshot()).rejects.toThrow(
      'Unsupported ecosystem snapshot schema: 1'
    );
  });

  it('migrates summary and routing consumers off the intelligence endpoint', () => {
    expect(controllerSource).not.toContain("fetchJson('/api/nerve-center/intelligence')");
    expect(routingSource).not.toContain("shared.fetchJson('/api/nerve-center/intelligence')");
    expect(routingSource).not.toContain("shared.fetchJson('/api/nerve-center/routing/config')");
    expect(routingSource).toContain('shared.getEcosystemSnapshot()');
    expect(routingSource).toContain('snapshot?.routingConfig');
    expect(routingSource).toContain('snapshot?.routing');
  });

  it('shows explicit snapshot errors and observed service/build inconsistency', () => {
    const shared = loadShared(jest.fn());
    const buildState = shared.serviceBuildWidget({
      serviceHealth: { status: 'degraded', total: 3, healthy: 2, down: 0 },
      identityConsistency: {
        status: 'degraded',
        profiles: ['full', 'lite'],
        issues: ['Mixed runtime profiles: full, lite']
      }
    });

    expect(buildState.value).toBe('DEGRADED/MIXED');
    expect(buildState.state).toBe('attention');
    expect(buildState.title).toContain('2/3 services healthy');
    expect(buildState.title).toContain('Mixed runtime profiles: full, lite');
    expect(controllerSource).toContain('markEcosystemSummaryUnavailable');
    expect(controllerSource).toContain("value: 'ERROR', state: 'critical'");
    expect(controllerSource).toContain('snapshot?.identityConsistency');
    expect(controllerSource).toContain("parts.push('MIXED')");
    expect(controllerSource).toContain('consistency.issues');
    expect(routingSource).toContain('Failed to load routing data:');
    expect(viewSource).toContain('id="widgetServiceBuild"');
    expect(viewSource).toContain('Services / Build');
  });

  it('renders evidence integrity separately from operational health', () => {
    const shared = loadShared(jest.fn());
    const verified = shared.evidenceTrustWidget({
      status: 'verified',
      operationalStatus: 'degraded',
      contradictionBudget: { observed: 0 },
      freshness: { stale: 0 },
      coverage: { observedSources: 6, expectedSources: 6, missing: [] }
    });
    const conflict = shared.evidenceTrustWidget({
      status: 'contradictory',
      operationalStatus: 'ok',
      contradictionBudget: { observed: 1 },
      freshness: { stale: 0 },
      coverage: { observedSources: 6, expectedSources: 6, missing: [] }
    });

    expect(verified).toMatchObject({ value: 'VERIFIED', state: 'nominal' });
    expect(verified.title).toContain('Operational state: degraded');
    expect(conflict).toMatchObject({ value: 'CONFLICT', state: 'critical' });
    expect(conflict.title).toContain('1 contradictions (budget 0)');
    expect(viewSource).toContain('id="widgetEvidenceTrust"');
    expect(viewSource).toContain('Evidence Trust');
  });
});
