/**
 * Integration Tests for Alert API Routes
 * Track 1: Alerts & Notifications - T1.6
 *
 * Tests the REST API endpoints for alert management
 */

const request = require('supertest');
const express = require('express');
const Alert = require('../../models/Alert');
const alertService = require('../../src/services/alertService');

// Auth middleware was stripped from core; no mock needed. Alerts routes
// previously read res.locals.user?.userId for the 'source' field — that
// reference has been removed along with the middleware.

// Create test app
const app = express();
app.use(express.json());

// Mount alert routes
const alertRoutes = require('../../routes/alerts');
app.use('/api/alerts', alertRoutes);

describe('Alert API Routes', () => {
  beforeAll(() => {
    process.env.ALERT_TEST_MODE = 'true';
  });

  beforeEach(async () => {
    // Clear alerts before each test
    await Alert.deleteMany({});
    // Reset alertService rules
    alertService.rules = [];
  });

  afterAll(async () => {
    await Alert.deleteMany({});
    delete process.env.ALERT_TEST_MODE;
  });

  describe('POST /api/alerts', () => {
    it('should create a new alert manually', async () => {
      const alertData = {
        title: 'Test Alert',
        message: 'This is a test alert',
        severity: 'warning',
        source: 'manual-test',
        context: { test: true }
      };

      const response = await request(app)
        .post('/api/alerts')
        .send(alertData)
        .expect(201);

      expect(response.body.status).toBe('success');
      expect(response.body.data.alert).toHaveProperty('_id');
      expect(response.body.data.alert.title).toBe(alertData.title);
      expect(response.body.data.alert.status).toBe('active');
    });

    it('should reject alert with missing required fields', async () => {
      const response = await request(app)
        .post('/api/alerts')
        .send({ title: 'Incomplete Alert' })
        .expect(400);

      expect(response.body.status).toBe('error');
      expect(response.body.message).toContain('required fields');
    });

    it('should reject alert with invalid severity', async () => {
      const response = await request(app)
        .post('/api/alerts')
        .send({
          title: 'Test',
          message: 'Test',
          severity: 'invalid',
          source: 'agentx'
        })
        .expect(400);

      expect(response.body.status).toBe('error');
    });

    it('should reject embedded external channel configuration with an adapter response', async () => {
      const alertData = {
        title: 'Webhook alert',
        message: 'Delivery test',
        severity: 'warning',
        source: 'manual-test',
        channels: ['email', 'webhook'],
        channelConfig: {
          email: {
            recipients: ['ops@example.com', 'oncall@example.com'],
            subject: 'Alert {{title}}'
          },
          webhook: {
            url: 'https://hooks.example.com/alerts',
            method: 'POST',
            headers: { Authorization: 'Bearer test' },
            template: '{"alert":"{{title}}"}'
          }
        }
      };

      const response = await request(app)
        .post('/api/alerts')
        .send(alertData)
        .expect(410);

      expect(response.body.code).toBe('ADAPTER_REQUIRED');
      expect(await Alert.countDocuments({})).toBe(0);
    });
  });

  describe('POST /api/alerts/evaluate', () => {
    beforeEach(() => {
      // Load test rules
      alertService.rules = [{
        id: 'test-rule-1',
        enabled: true,
        name: 'High Error Rate',
        conditions: {
          all: [
            { fact: 'errorRate', operator: 'greaterThan', value: 0.1 }
          ]
        },
        event: {
          type: 'alert',
          params: {
            severity: 'critical',
            title: 'High Error Rate Detected',
            message: 'Error rate exceeded 10%'
          }
        }
      }];
    });

    it('should evaluate event and trigger alert when conditions match', async () => {
      const event = {
        source: 'test-component',
        data: {
          errorRate: 0.15,
          timestamp: new Date().toISOString()
        }
      };

      const response = await request(app)
        .post('/api/alerts/evaluate')
        .send(event)
        .expect(200);

      expect(response.body.status).toBe('success');
      expect(response.body.data.matched).toBe(true);
      expect(response.body.data.alert).toBeDefined();
      expect(response.body.data.alert.severity).toBe('critical');
    });

    it('should not trigger alert when conditions do not match', async () => {
      const event = {
        source: 'test-component',
        data: {
          errorRate: 0.05,
          timestamp: new Date().toISOString()
        }
      };

      const response = await request(app)
        .post('/api/alerts/evaluate')
        .send(event)
        .expect(200);

      expect(response.body.status).toBe('success');
      expect(response.body.data.matched).toBe(false);
      expect(response.body.data.alert).toBeNull();
    });

    it('should return evaluation results even when no rules loaded', async () => {
      alertService.rules = [];

      const event = {
        source: 'agentx',
        data: { value: 100 }
      };

      const response = await request(app)
        .post('/api/alerts/evaluate')
        .send(event)
        .expect(200);

      expect(response.body.status).toBe('success');
      expect(response.body.data.matched).toBe(false);
    });
  });

  describe('GET /api/alerts', () => {
    beforeEach(async () => {
      // Create test alerts
      await Alert.create([
        {
          title: 'Alert 1',
          message: 'First alert',
          severity: 'critical',
          status: 'active',
          source: 'agentx',
          fingerprint: 'test-1',
          ruleId: 'test-rule',
          ruleName: 'Test Rule'
        },
        {
          title: 'Alert 2',
          message: 'Second alert',
          severity: 'warning',
          status: 'acknowledged',
          source: 'agentx',
          fingerprint: 'test-2',
          ruleId: 'test-rule',
          ruleName: 'Test Rule'
        },
        {
          title: 'Alert 3',
          message: 'Third alert',
          severity: 'info',
          status: 'resolved',
          source: 'agentx',
          fingerprint: 'test-3',
          ruleId: 'test-rule',
          ruleName: 'Test Rule'
        }
      ]);
    });

    it('should list all alerts', async () => {
      const response = await request(app)
        .get('/api/alerts')
        .expect(200);

      expect(response.body.status).toBe('success');
      expect(response.body.data.alerts).toHaveLength(3);
      expect(response.body.data.total).toBe(3);
      expect(response.body.data.summary).toEqual(expect.objectContaining({
        total: 3,
        activeCount: 1,
        byStatus: { active: 1, acknowledged: 1, resolved: 1 }
      }));
      expect(response.body.data.summary.basis.activePredicate).toEqual({ status: 'active' });
    });

    it('should filter alerts by status', async () => {
      const response = await request(app)
        .get('/api/alerts')
        .query({ status: 'active' })
        .expect(200);

      expect(response.body.data.alerts).toHaveLength(1);
      expect(response.body.data.alerts[0].status).toBe('active');
    });

    it('should filter alerts by severity', async () => {
      const response = await request(app)
        .get('/api/alerts')
        .query({ severity: 'critical' })
        .expect(200);

      expect(response.body.data.alerts).toHaveLength(1);
      expect(response.body.data.alerts[0].severity).toBe('critical');
    });

    it('should support pagination', async () => {
      const response = await request(app)
        .get('/api/alerts')
        .query({ limit: 2, skip: 1 })
        .expect(200);

      expect(response.body.data.alerts).toHaveLength(2);
      expect(response.body.data.limit).toBe(2);
      expect(response.body.data.skip).toBe(1);
    });

    it('should sort alerts by severity (default)', async () => {
      const response = await request(app)
        .get('/api/alerts')
        .expect(200);

      const severities = response.body.data.alerts.map(a => a.severity);
      // Critical should come first (high priority)
      expect(severities[0]).toBe('critical');
    });

    it('normalizes legacy templates and returns full active counts with a limited page', async () => {
      await Alert.create({
        title: 'VRAM displacement — {{component}}',
        message: 'Displacement on {{component}}',
        severity: 'critical',
        status: 'active',
        source: 'agentx',
        fingerprint: 'legacy-template',
        ruleId: 'vram-displacement',
        ruleName: 'VRAM displacement',
        context: { component: 'scheduler' },
        lastOccurrence: new Date('2030-01-01T00:00:00Z')
      });

      const response = await request(app)
        .get('/api/alerts')
        .query({ status: 'active', limit: 1 })
        .expect(200);

      expect(response.body.data.alerts).toHaveLength(1);
      expect(response.body.data.total).toBe(2);
      expect(response.body.data.summary.activeCount).toBe(2);
      expect(response.body.data.summary.bySeverity.critical).toBe(2);
      expect(response.body.data.alerts[0].title).toBe('VRAM displacement — scheduler');
      expect(JSON.stringify(response.body.data.alerts[0])).not.toContain('{{component}}');
    });
  });

  describe('GET /api/alerts/:id', () => {
    let testAlert;

    beforeEach(async () => {
      testAlert = await Alert.create({
        title: 'Test Alert',
        message: 'Test message',
        severity: 'warning',
        status: 'active',
        source: 'agentx',
        fingerprint: 'test-alert'
      ,
        ruleId: 'test-rule',
        ruleName: 'Test Rule'});
    });

    it('should get alert by ID', async () => {
      const response = await request(app)
        .get(`/api/alerts/${testAlert._id}`)
        .expect(200);

      expect(response.body.status).toBe('success');
      expect(response.body.data.alert.title).toBe('Test Alert');
      expect(response.body.data.alert._id).toBe(testAlert._id.toString());
    });

    it('should return 404 for non-existent alert', async () => {
      const fakeId = '507f1f77bcf86cd799439011';
      const response = await request(app)
        .get(`/api/alerts/${fakeId}`)
        .expect(404);

      expect(response.body.status).toBe('error');
      expect(response.body.message).toContain('not found');
    });

    it('should return 400 for invalid alert ID', async () => {
      const response = await request(app)
        .get('/api/alerts/invalid-id')
        .expect(400);

      expect(response.body.status).toBe('error');
    });
  });

  describe('PUT /api/alerts/:id/acknowledge', () => {
    let testAlert;

    beforeEach(async () => {
      testAlert = await Alert.create({
        title: 'Test Alert',
        message: 'Test message',
        severity: 'warning',
        status: 'active',
        source: 'agentx',
        fingerprint: 'test-alert'
      ,
        ruleId: 'test-rule',
        ruleName: 'Test Rule'});
    });

    it('should acknowledge an active alert', async () => {
      const response = await request(app)
        .put(`/api/alerts/${testAlert._id}/acknowledge`)
        .send({ acknowledgedBy: 'test-user' })
        .expect(200);

      expect(response.body.status).toBe('success');
      expect(response.body.data.alert.status).toBe('acknowledged');
      expect(response.body.data.alert.acknowledgedBy).toBe('test-user');
      expect(response.body.data.alert.acknowledgedAt).toBeDefined();
    });

    it('should reject acknowledgment without acknowledgedBy', async () => {
      const response = await request(app)
        .put(`/api/alerts/${testAlert._id}/acknowledge`)
        .send({})
        .expect(400);

      expect(response.body.status).toBe('error');
    });
  });

  describe('PUT /api/alerts/:id/resolve', () => {
    let testAlert;

    beforeEach(async () => {
      testAlert = await Alert.create({
        title: 'Test Alert',
        message: 'Test message',
        severity: 'warning',
        status: 'acknowledged',
        source: 'agentx',
        fingerprint: 'test-alert',
        ruleId: 'test-rule',
        ruleName: 'Test Rule'
      });
    });

    it('should resolve an acknowledged alert', async () => {
      const response = await request(app)
        .put(`/api/alerts/${testAlert._id}/resolve`)
        .send({
          resolvedBy: 'test-user',
          resolution: 'Issue fixed'
        })
        .expect(200);

      expect(response.body.status).toBe('success');
      expect(response.body.data.alert.status).toBe('resolved');
      expect(response.body.data.alert.resolvedBy).toBe('test-user');
      expect(response.body.data.alert.resolution).toBe('Issue fixed');
    });

    it('should reject resolution without resolvedBy', async () => {
      const response = await request(app)
        .put(`/api/alerts/${testAlert._id}/resolve`)
        .send({ resolution: 'Fixed' })
        .expect(400);

      expect(response.body.status).toBe('error');
    });
  });

  describe('POST /api/alerts/:id/delivery-status', () => {
    let testAlert;

    beforeEach(async () => {
      testAlert = await Alert.create({
        title: 'Test Alert',
        message: 'Test message',
        severity: 'warning',
        status: 'active',
        source: 'agentx',
        fingerprint: 'test-alert',
        deliveryStatus: {
          email: { sent: true, sentAt: new Date() }
        }
      });
    });

    it('should update delivery status', async () => {
      const response = await request(app)
        .post(`/api/alerts/${testAlert._id}/delivery-status`)
        .send({
          channel: 'slack',
          status: 'sent',
          timestamp: new Date().toISOString()
        })
        .expect(200);

      expect(response.body.status).toBe('success');
      expect(response.body.data.alert.deliveryStatus.slack).toBeDefined();
      expect(response.body.data.alert.deliveryStatus.slack.sent).toBe(true);
    });

    it('should record delivery error', async () => {
      const response = await request(app)
        .post(`/api/alerts/${testAlert._id}/delivery-status`)
        .send({
          channel: 'webhook',
          status: 'error',
          error: 'Connection timeout',
          timestamp: new Date().toISOString()
        })
        .expect(200);

      expect(response.body.data.alert.deliveryStatus.webhook).toBeDefined();
      expect(response.body.data.alert.deliveryStatus.webhook.sent).toBe(false);
      expect(response.body.data.alert.deliveryStatus.webhook.error).toBe('Connection timeout');
    });
  });

  describe('GET /api/alerts/stats/summary', () => {
    beforeEach(async () => {
      await Alert.create([
        {
          title: 'Alert 1',
          message: 'Msg',
          severity: 'critical',
          status: 'active',
          source: 'agentx',
          fingerprint: 'f1',
          ruleId: 'test-rule',
          ruleName: 'Test Rule'
        },
        {
          title: 'Alert 2',
          message: 'Msg',
          severity: 'critical',
          status: 'active',
          source: 'agentx',
          fingerprint: 'f2',
          ruleId: 'test-rule',
          ruleName: 'Test Rule'
        },
        {
          title: 'Alert 3',
          message: 'Msg',
          severity: 'warning',
          status: 'acknowledged',
          source: 'agentx',
          fingerprint: 'f3',
          ruleId: 'test-rule',
          ruleName: 'Test Rule'
        },
        {
          title: 'Alert 4',
          message: 'Msg',
          severity: 'info',
          status: 'resolved',
          source: 'agentx',
          fingerprint: 'f4',
          ruleId: 'test-rule',
          ruleName: 'Test Rule'
        }
      ]);
    });

    it('should return alert statistics', async () => {
      const response = await request(app)
        .get('/api/alerts/stats/summary')
        .expect(200);

      expect(response.body.status).toBe('success');
      expect(response.body.data.statistics).toBeDefined();
      expect(response.body.data.statistics.total).toBe(4);
      expect(response.body.data.statistics.byStatus.active).toBe(2);
      expect(response.body.data.statistics.bySeverity.critical).toBe(2);
    });
  });

  describe('POST /api/alerts/rules/load', () => {
    it('should load custom rules from request body', async () => {
      const customRules = [{
        id: 'custom-rule',
        enabled: true,
        name: 'Custom Test Rule',
        conditions: {
          all: [
            { fact: 'value', operator: 'greaterThan', value: 100 }
          ]
        },
        event: {
          type: 'alert',
          params: {
            severity: 'warning',
            title: 'Custom Alert'
          }
        }
      }];

      const response = await request(app)
        .post('/api/alerts/rules/load')
        .send({ rules: customRules })
        .expect(200);

      expect(response.body.data.loadedCount).toBe(1);
      expect(response.body.data.enabledCount).toBe(1);
    });
  });

  describe('GET /api/alerts/test/config', () => {
    it('should return current alert configuration', async () => {
      const response = await request(app)
        .get('/api/alerts/test/config')
        .expect(200);

      expect(response.body.status).toBe('success');
      expect(response.body.data.config).toBeDefined();
      expect(response.body.data.config).toHaveProperty('rulesLoaded');
      expect(response.body.data.config).toHaveProperty('enabledChannels');
      expect(response.body.data.config).toHaveProperty('testMode');
    });
  });
});
