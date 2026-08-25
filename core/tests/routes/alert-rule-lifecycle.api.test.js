'use strict';

const express = require('express');
const request = require('supertest');
const AlertRule = require('../../models/AlertRule');

const IDS = ['lifecycle-active-test', 'lifecycle-disabled-test', 'capacity-host-critical'];

describe('alert detector lifecycle API', () => {
  let server;

  beforeAll((done) => {
    const app = express();
    app.use(express.json());
    app.use('/api/alerts', require('../../routes/alerts'));
    server = app.listen(0, '127.0.0.1', done);
  });

  beforeEach(async () => {
    await AlertRule.deleteMany({ ruleId: { $in: IDS } });
  });

  afterAll(async () => {
    await AlertRule.deleteMany({ ruleId: { $in: IDS } });
    await new Promise(resolve => server.close(resolve));
  });

  test('returns active, disabled, and retired-by-design as distinct coverage states', async () => {
    const base = {
      severity: 'warning',
      conditions: { all: [{ fact: 'metric', operator: 'equal', value: 'test' }] },
      channels: ['local_log'],
    };
    await AlertRule.create([
      { ...base, ruleId: IDS[0], name: 'Active', enabled: true, builtIn: true },
      { ...base, ruleId: IDS[1], name: 'Disabled', enabled: false, builtIn: true },
      { ...base, ruleId: IDS[2], name: 'Retired', enabled: false, builtIn: true },
    ]);

    const response = await request(server).get('/api/alerts/rules').expect(200);
    const byId = Object.fromEntries(response.body.data.rules.map(rule => [rule.ruleId, rule]));

    expect(byId[IDS[0]].detectorState).toBe('active');
    expect(byId[IDS[1]].detectorState).toBe('disabled');
    expect(byId[IDS[2]]).toEqual(expect.objectContaining({
      detectorState: 'retired_by_design',
      producerAvailable: false,
    }));
    expect(response.body.data.detectorCoverage).toEqual({
      total: 3,
      active: 1,
      disabled: 1,
      retired_by_design: 1,
    });
  });

  test('cannot re-enable a built-in whose producer was retired', async () => {
    await AlertRule.create({
      ruleId: IDS[2],
      name: 'Retired',
      enabled: false,
      builtIn: true,
      severity: 'warning',
      conditions: { all: [{ fact: 'metric', operator: 'equal', value: 'test' }] },
      channels: ['local_log'],
    });
    await request(server)
      .put('/api/alerts/rules/capacity-host-critical')
      .send({ enabled: true })
      .expect(409)
      .expect(response => {
        expect(response.body.code).toBe('DETECTOR_RETIRED');
      });
  });

  test('allows an operator-created rule with a colliding historical ID to be enabled', async () => {
    await AlertRule.create({
      ruleId: IDS[2],
      name: 'Operator detector',
      enabled: false,
      builtIn: false,
      severity: 'warning',
      conditions: { all: [{ fact: 'metric', operator: 'equal', value: 'test' }] },
      channels: ['local_log'],
    });

    const response = await request(server)
      .put('/api/alerts/rules/capacity-host-critical')
      .send({ enabled: true })
      .expect(200);

    expect(response.body.data.rule.enabled).toBe(true);
  });
});
