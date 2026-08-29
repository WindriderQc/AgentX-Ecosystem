'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const headline = require('../../public/js/cluster-schedule-headline.js');
const scheduleDate = require('../../public/js/cluster-schedule-date.js');
const upcoming = require('../../public/js/cluster-schedule-upcoming.js');

const root = path.resolve(__dirname, '../..');
const read = relative => fs.readFileSync(path.join(root, relative), 'utf8');

function ecosystemSnapshot(overrides = {}) {
  return {
    schemaVersion: 2,
    authority: 'agentx-product',
    readOnly: true,
    generatedAt: '2026-08-28T14:00:00.000Z',
    evidence: { snapshotObservedAt: '2026-08-28T14:00:00.000Z' },
    health: {
      status: 'degraded',
      configuredHosts: 3,
      onlineHosts: 2,
      offlineHosts: 1,
      observedModels: 18
    },
    ...overrides
  };
}

function loadControllerContext() {
  const elements = new Map();
  const document = {
    addEventListener: jest.fn(),
    querySelectorAll: jest.fn(() => []),
    querySelector: jest.fn(() => null),
    getElementById: jest.fn(id => {
      if (!elements.has(id)) {
        elements.set(id, {
          innerHTML: '',
          textContent: '',
          dataset: {},
          style: {},
          classList: { add: jest.fn(), remove: jest.fn(), toggle: jest.fn(), contains: jest.fn() }
        });
      }
      return elements.get(id);
    })
  };
  const window = {
    ClusterScheduleDate: scheduleDate,
    ClusterScheduleUpcoming: upcoming,
    ClusterScheduleHeadline: headline,
    AgentXUtils: { escapeHtml: value => String(value) },
    addEventListener: jest.fn(),
    innerWidth: 1280,
    innerHeight: 720
  };
  const context = vm.createContext({
    window,
    document,
    console,
    fetch: jest.fn(),
    setInterval: jest.fn(),
    clearInterval: jest.fn(),
    Promise
  });
  vm.runInContext(read('public/js/cluster-schedule.js'), context);
  return { context, elements };
}

describe('Cluster Schedule canonical headline evidence', () => {
  test('projects exact ecosystem counts and observation time without consulting live detail', () => {
    const projected = headline.projectEcosystemHeadline(ecosystemSnapshot());
    expect(projected).toEqual({
      authority: 'agentx-product',
      scope: 'ecosystem-host-and-model-inventory',
      observedAt: '2026-08-28T14:00:00.000Z',
      status: 'degraded',
      configuredHosts: 3,
      onlineHosts: 2,
      offlineHosts: 1,
      observedModels: 18
    });

    const contradictoryLiveDetail = {
      hosts: [{ id: 'primary', status: 'online', models: [] }],
      polledAt: '2026-08-28T14:00:02.000Z',
      evidence: {
        authority: 'agentx.cluster-schedule-live-detail',
        scope: 'loaded-model-and-vram-detail',
        observedAt: '2026-08-28T14:00:02.000Z',
        headlineAuthority: false
      }
    };
    expect(headline.projectLiveDetailEvidence(contradictoryLiveDetail)).toMatchObject({
      observedAt: '2026-08-28T14:00:02.000Z',
      headlineAuthority: false
    });
    expect(projected).toMatchObject({ configuredHosts: 3, observedModels: 18 });
  });

  test('fails closed on malformed or internally inconsistent canonical counts', () => {
    expect(() => headline.projectEcosystemHeadline(ecosystemSnapshot({ authority: 'other' })))
      .toThrow('authority is invalid');
    expect(() => headline.projectEcosystemHeadline(ecosystemSnapshot({
      health: {
        status: 'ok',
        configuredHosts: 3,
        onlineHosts: 1,
        offlineHosts: 1,
        observedModels: 9
      }
    }))).toThrow('host counts are inconsistent');
  });

  test('renders the canonical values even when a separate live-detail poll disagrees', () => {
    const { context, elements } = loadControllerContext();
    const renderHeadline = vm.runInContext('updateHeaderStatus', context);
    const updateDetail = vm.runInContext('updateLiveEvidence', context);
    const projected = headline.projectEcosystemHeadline(ecosystemSnapshot());

    updateDetail({
      hosts: [{ id: 'primary', status: 'online', models: [] }],
      evidence: {
        authority: 'agentx.cluster-schedule-live-detail',
        scope: 'loaded-model-and-vram-detail',
        observedAt: '2026-08-28T14:00:02.000Z',
        headlineAuthority: false
      }
    });
    renderHeadline(projected, [], { scheduleAvailable: true });

    const header = elements.get('headerStatus');
    expect(header.innerHTML).toContain('3 configured hosts');
    expect(header.innerHTML).toContain('2 online');
    expect(header.innerHTML).toContain('1 offline');
    expect(header.innerHTML).toContain('18 observed model tags');
    expect(header.innerHTML).not.toContain('1 configured hosts');
    expect(header.dataset).toMatchObject({
      authority: 'agentx-product',
      evidenceScope: 'ecosystem-host-and-model-inventory',
      observedAt: '2026-08-28T14:00:00.000Z'
    });

    const detail = elements.get('liveEvidence');
    expect(detail.textContent).toContain('separate runtime-detail poll');
    expect(detail.textContent).toContain('do not set the ecosystem headline counts');
    expect(detail.dataset).toMatchObject({
      authority: 'agentx.cluster-schedule-live-detail',
      evidenceScope: 'loaded-model-and-vram-detail',
      observedAt: '2026-08-28T14:00:02.000Z'
    });
  });

  test('loads the projection before the controller and fetches the canonical snapshot', () => {
    const app = read('src/app.js');
    const controller = read('public/js/cluster-schedule.js');
    const routeBlock = app.slice(
      app.indexOf("app.get('/cluster-schedule'"),
      app.indexOf("app.get('/memory-review'")
    );

    expect(routeBlock.indexOf('/js/cluster-schedule-headline.js'))
      .toBeLessThan(routeBlock.indexOf('/js/cluster-schedule.js'));
    expect(controller).toContain("fetchJSON('/api/nerve-center/ecosystem')");
    expect(controller).toContain('HEADLINE_PROJECTION.projectEcosystemHeadline');
    expect(controller).not.toContain('updateHeaderStatus(hosts, nextTasks)');
  });
});
