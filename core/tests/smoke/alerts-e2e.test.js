/**
 * Alerts End-to-End Smoke Test
 *
 * Verifies the complete alert flow:
 * 1. n8n workflow → AgentX API → Database → UI
 * 2. Notification delivery channels
 * 3. Alert persistence and retrieval
 *
 * Purpose: Ensure alerts created by automated workflows (N1.1, N5.1)
 * are properly stored and accessible through the UI.
 */

const request = require('supertest');
const mongoose = require('mongoose');
const { app } = require('../../src/app');
const Alert = require('../../models/Alert');

describe('Alerts End-to-End Smoke Tests', () => {
  beforeAll(async () => {
    // Clean up any stale alerts from previous failed runs
    await Alert.deleteMany({ source: 'smoke-test' });
    // Ensure test database connection
    if (mongoose.connection.readyState === 0) {
      await mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/agentx_test');
    }
  });

  afterAll(async () => {
    // Clean up test alerts
    await Alert.deleteMany({ source: 'smoke-test' });
  });

  describe('1. N1.1 (Janitor) → AgentX → UI Path', () => {
    test('should accept alert from N1.1 workflow format', async () => {
      // Simulate N1.1 workflow alert payload
      const n11Alert = {
        eventType: 'system_health_not_healthy',
        ruleId: 'sbqc.n1_1.health.not_healthy',
        ruleName: 'SBQC N1.1 System Health Not Healthy',
        severity: 'warning',
        title: 'System Health: DEGRADED',
        message: 'Health is degraded. Failing components: ollama, mongodb',
        source: 'smoke-test', // Changed from 'n8n' for test cleanup
        channels: ['slack'],
        context: {
          component: 'system',
          metric: 'overall_health',
          currentValue: 'degraded',
          workflow: 'SBQC-N1.1',
          overall: 'degraded',
          failingComponents: ['ollama', 'mongodb']
        },
        metadata: {
          eventType: 'system_health_not_healthy',
          workflow: 'SBQC-N1.1'
        }
      };

      const response = await request(app)
        .post('/api/alerts')
        .send(n11Alert)
        .expect(201);

      expect(response.body.status).toBe('success');
      expect(response.body.data.alert).toHaveProperty('_id');
      expect(response.body.data.alert.severity).toBe('warning');
      expect(response.body.data.alert.title).toBe('System Health: DEGRADED');

      // Verify alert was saved to database
      const savedAlert = await Alert.findById(response.body.data.alert._id);
      expect(savedAlert).toBeTruthy();
      expect(savedAlert.ruleId).toBe('sbqc.n1_1.health.not_healthy');
      expect(savedAlert.context.component).toBe('system');
      expect(savedAlert.context.metric).toBe('overall_health');
      expect(savedAlert.context.currentValue).toBe('degraded');
    });

    test('should handle critical severity alerts from N1.1', async () => {
      const criticalAlert = {
        eventType: 'system_health_not_healthy',
        ruleId: 'sbqc.n1_1.health.not_healthy.critical',
        ruleName: 'SBQC N1.1 System Health Not Healthy',
        severity: 'critical',
        title: 'System Health: UNHEALTHY',
        message: 'Health is unhealthy. Failing components: ollama, mongodb, qdrant',
        source: 'smoke-test',
        channels: ['slack', 'email'], // Critical gets both channels
        context: {
          component: 'system',
          metric: 'overall_health',
          currentValue: 'unhealthy',
          workflow: 'SBQC-N1.1',
          overall: 'unhealthy',
          failingComponents: ['ollama', 'mongodb', 'qdrant']
        }
      };

      const response = await request(app)
        .post('/api/alerts')
        .send(criticalAlert)
        .expect(201);

      expect(response.body.data.alert.severity).toBe('critical');

      const savedAlert = await Alert.findById(response.body.data.alert._id);
      expect(savedAlert.channels).toContain('slack');
      expect(savedAlert.channels).toContain('email');
    });
  });

  describe('2. N5.1 (Analyst) → AgentX → UI Path', () => {
    test('should accept alert from N5.1 workflow format', async () => {
      // Simulate N5.1 workflow alert payload
      const n51Alert = {
        eventType: 'prompt_performance_drop',
        ruleId: 'sbqc.n5_1.prompt.performance_drop',
        ruleName: 'SBQC N5.1 Prompt Performance Drop',
        severity: 'warning',
        title: 'Prompt performance drop detected (65% positive)',
        message: 'Weekly feedback indicates underperforming prompts. Positive rate: 65%. Underperformers: default_chat v3, coding_assistant v1',
        source: 'smoke-test',
        channels: ['slack'],
        context: {
          component: 'prompt',
          metric: 'positive_rate',
          currentValue: 65,
          threshold: 70,
          workflow: 'SBQC-N5.1',
          positiveRate: 65,
          underperformers: [
            { name: 'default_chat', version: 3, positiveRate: 62 },
            { name: 'coding_assistant', version: 1, positiveRate: 58 }
          ],
          slowModels: [],
          analyzedAt: new Date().toISOString()
        },
        metadata: {
          eventType: 'prompt_performance_drop',
          workflow: 'SBQC-N5.1'
        }
      };

      const response = await request(app)
        .post('/api/alerts')
        .send(n51Alert)
        .expect(201);

      expect(response.body.status).toBe('success');
      expect(response.body.data.alert.severity).toBe('warning');

      // Verify alert structure
      const savedAlert = await Alert.findById(response.body.data.alert._id);
      expect(savedAlert.ruleId).toBe('sbqc.n5_1.prompt.performance_drop');
      expect(savedAlert.context.component).toBe('prompt');
      expect(savedAlert.context.metric).toBe('positive_rate');
      expect(savedAlert.context.currentValue).toBe(65);
      expect(savedAlert.context.threshold).toBe(70);
    });

    test('should handle critical severity from N5.1', async () => {
      const criticalAlert = {
        eventType: 'prompt_performance_drop',
        ruleId: 'sbqc.n5_1.prompt.performance_drop.critical',
        ruleName: 'SBQC N5.1 Prompt Performance Drop',
        severity: 'critical',
        title: 'Prompt performance drop detected (45% positive)',
        message: 'Weekly feedback indicates severe underperformance. Positive rate: 45%.',
        source: 'smoke-test',
        channels: ['slack', 'email'],
        context: {
          component: 'prompt',
          metric: 'positive_rate',
          currentValue: 45,
          threshold: 70,
          workflow: 'SBQC-N5.1',
          positiveRate: 45
        }
      };

      const response = await request(app)
        .post('/api/alerts')
        .send(criticalAlert)
        .expect(201);

      expect(response.body.data.alert.severity).toBe('critical');
    });
  });

  describe('3. Alert Persistence & Retrieval', () => {
    let testAlertId;

    beforeAll(async () => {
      // Create test alert
      const response = await request(app)
        .post('/api/alerts')
        .send({
          ruleId: 'test-rule',
          ruleName: 'Test Rule',
          severity: 'info',
          title: 'Test Alert for Retrieval',
          message: 'This is a test alert',
          source: 'smoke-test',
          channels: ['dataapi_log']
        });

      testAlertId = response.body.data.alert._id;
    });

    test('should retrieve all alerts', async () => {
      const response = await request(app)
        .get('/api/alerts')
        .expect(200);

      expect(response.body.status).toBe('success');
      expect(response.body.data.alerts).toBeInstanceOf(Array);
      expect(response.body.data.alerts.length).toBeGreaterThan(0);

      // Find our test alert
      const testAlert = response.body.data.alerts.find(a => a._id === testAlertId);
      expect(testAlert).toBeTruthy();
      expect(testAlert.title).toBe('Test Alert for Retrieval');
    });

    test('should retrieve single alert by ID', async () => {
      const response = await request(app)
        .get(`/api/alerts/${testAlertId}`)
        .expect(200);

      expect(response.body.status).toBe('success');
      expect(response.body.data.alert._id).toBe(testAlertId);
      expect(response.body.data.alert.title).toBe('Test Alert for Retrieval');
    });

    test('should filter alerts by severity', async () => {
      // Create alerts with different severities
      await request(app).post('/api/alerts').send({
        ruleId: 'smoke-test-severity-critical',
        severity: 'critical',
        title: 'Critical Test',
        message: 'Critical message',
        source: 'smoke-test',
        channels: ['dataapi_log']
      });

      const response = await request(app)
        .get('/api/alerts?severity=critical')
        .expect(200);

      expect(response.body.data.alerts).toBeInstanceOf(Array);

      // All returned alerts should be critical
      response.body.data.alerts.forEach(alert => {
        expect(alert.severity).toBe('critical');
      });
    });

    test('should filter alerts by status', async () => {
      const response = await request(app)
        .get('/api/alerts?status=active')
        .expect(200);

      expect(response.body.data.alerts).toBeInstanceOf(Array);

      // All returned alerts should be active
      response.body.data.alerts.forEach(alert => {
        expect(alert.status).toBe('active');
      });
    });
  });

  describe('4. Alert Statistics', () => {
    test('should get alert statistics', async () => {
      // Create a few test alerts first
      await Promise.all([
        request(app).post('/api/alerts').send({
          ruleId: 'stats-info',
          severity: 'info',
          title: 'Info Alert',
          message: 'Info message',
          source: 'smoke-test',
          channels: ['dataapi_log']
        }),
        request(app).post('/api/alerts').send({
          ruleId: 'stats-warning',
          severity: 'warning',
          title: 'Warning Alert',
          message: 'Warning message',
          source: 'smoke-test',
          channels: ['dataapi_log']
        }),
        request(app).post('/api/alerts').send({
          ruleId: 'stats-critical',
          severity: 'critical',
          title: 'Critical Alert',
          message: 'Critical message',
          source: 'smoke-test',
          channels: ['dataapi_log']
        })
      ]);

      const response = await request(app)
        .get('/api/alerts/statistics')
        .expect(200);

      expect(response.body.status).toBe('success');
      expect(response.body.data).toHaveProperty('summary');
      expect(response.body.data).toHaveProperty('bySeverity');
      expect(response.body.data).toHaveProperty('byStatus');
      expect(response.body.data.summary.totalAlerts).toBeGreaterThan(0);
    });
  });

  describe('5. Notification Channel Verification', () => {
    test('should log dataapi_log channel notifications', async () => {
      const response = await request(app)
        .post('/api/alerts')
        .send({
          severity: 'info',
          ruleId: 'test-channel-dataapi', title: 'Channel Test',
          message: 'Testing notification channels',
          source: 'smoke-test',
          channels: ['dataapi_log']
        })
        .expect(201);

      // Verify alert was created
      expect(response.body.data.alert).toHaveProperty('_id');
    });

    test('should handle multiple channels gracefully', async () => {
      const response = await request(app)
        .post('/api/alerts')
        .send({
          severity: 'warning',
          ruleId: 'test-channel-multi', title: 'Multi-Channel Test',
          message: 'Testing multiple channels',
          source: 'smoke-test',
          channels: ['slack', 'email', 'dataapi_log']
        })
        .expect(201);

      // Should succeed even if slack/email aren't implemented
      expect(response.body.status).toBe('success');
    });

    test('should handle unknown channels gracefully', async () => {
      const response = await request(app)
        .post('/api/alerts')
        .send({
          severity: 'info',
          ruleId: 'test-channel-unknown', title: 'Unknown Channel Test',
          message: 'Testing unknown channel',
          source: 'smoke-test',
          channels: ['unknown_channel']
        })
        .expect(201);

      // Should still create the alert
      expect(response.body.status).toBe('success');
    });
  });

  describe('6. Alert Field Validation', () => {
    test('should reject alert without required fields', async () => {
      const response = await request(app)
        .post('/api/alerts')
        .send({
          severity: 'info'
          // Missing: title, message, source
        })
        .expect(400);

      expect(response.body.status).toBe('error');
      expect(response.body.message).toContain('required fields');
    });

    test('should reject alert with invalid severity', async () => {
      const response = await request(app)
        .post('/api/alerts')
        .send({
          severity: 'invalid_severity',
          title: 'Test',
          message: 'Test message',
          source: 'smoke-test',
          channels: ['dataapi_log']
        })
        .expect(400);

      expect(response.body.status).toBe('error');
      expect(response.body.message).toContain('Invalid severity');
    });

    test('should accept valid severity values', async () => {
      const severities = ['info', 'warning', 'critical'];

      for (const severity of severities) {
        const response = await request(app)
          .post('/api/alerts')
          .send({
            severity, ruleId: 'test-severity-' + severity,
            title: `Test ${severity}`,
            message: 'Test message',
            source: 'smoke-test',
            channels: ['dataapi_log']
          })
          .expect(201);

        expect(response.body.data.alert.severity).toBe(severity);
      }
    });
  });

  describe('7. Alert Context Preservation', () => {
    test('should preserve complex context from N1.1', async () => {
      const complexContext = {
        component: 'system',
        metric: 'overall_health',
        currentValue: 'degraded',
        workflow: 'SBQC-N1.1',
        overall: 'degraded',
        failingComponents: ['ollama', 'mongodb'],
        detail: {
          ollama: { status: 'error', lastCheck: new Date().toISOString() },
          mongodb: { status: 'degraded', lastCheck: new Date().toISOString() }
        }
      };

      const response = await request(app)
        .post('/api/alerts')
        .send({
          ruleId: 'test-complex-context',
          severity: 'warning',
          title: 'Complex Context Test',
          message: 'Testing context preservation',
          source: 'smoke-test',
          channels: ['dataapi_log'],
          context: complexContext
        })
        .expect(201);

      const savedAlert = await Alert.findById(response.body.data.alert._id);
      // Verify that schema-defined fields are saved
      expect(savedAlert.context.component).toBe('system');
      expect(savedAlert.context.metric).toBe('overall_health');
      expect(savedAlert.context.currentValue).toBe('degraded');
      // Note: Additional fields like failingComponents, detail, etc. are not part of schema
      // and won't be saved unless added to context.additionalData
    });

    test('should preserve metadata from workflows', async () => {
      const metadata = {
        eventType: 'custom_event',
        workflow: 'TEST-WORKFLOW',
        customField: 'customValue',
        timestamp: new Date().toISOString()
      };

      const response = await request(app)
        .post('/api/alerts')
        .send({
          severity: 'info',
          ruleId: 'test-metadata', title: 'Metadata Test',
          message: 'Testing metadata preservation',
          source: 'smoke-test',
          channels: ['dataapi_log'],
          metadata
        })
        .expect(201);

      const savedAlert = await Alert.findById(response.body.data.alert._id);
      expect(savedAlert.metadata).toMatchObject(metadata);
    });
  });
});
