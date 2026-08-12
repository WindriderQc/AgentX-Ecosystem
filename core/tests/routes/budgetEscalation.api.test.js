const request = require('supertest');
const { app } = require('../../src/app');

describe('GET /api/budget/escalation-recommendation', () => {
  test('returns allow for green budget health', async () => {
    const res = await request(app)
      .get('/api/budget/escalation-recommendation?budget_health=green')
      .set('x-test-client', 'budget-escalation-green');

    expect(res.status).toBe(200);
    expect(res.body.period).toBe('manual');
    expect(res.body.budget_health).toBe('green');
    expect(res.body.escalation.recommendation).toBe('allow');
    expect(res.body.escalation.cloud_allowed).toBe(true);
  });

  test('returns limited for yellow budget health', async () => {
    const res = await request(app)
      .get('/api/budget/escalation-recommendation?budget_health=yellow')
      .set('x-test-client', 'budget-escalation-yellow');

    expect(res.status).toBe(200);
    expect(res.body.budget_health).toBe('yellow');
    expect(res.body.escalation.recommendation).toBe('limited');
    expect(res.body.escalation.requires_complexity_justification).toBe(true);
  });

  test('returns deny for red budget health', async () => {
    const res = await request(app)
      .get('/api/budget/escalation-recommendation?budget_health=red')
      .set('x-test-client', 'budget-escalation-red');

    expect(res.status).toBe(200);
    expect(res.body.budget_health).toBe('red');
    expect(res.body.escalation.recommendation).toBe('deny');
    expect(res.body.escalation.cloud_allowed).toBe(false);
  });
});
