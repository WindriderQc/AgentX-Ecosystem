const alertService = require('../../src/services/alertService');
const Alert = require('../../models/Alert');
const InferenceLog = require('../../models/InferenceLog');
const mongoose = require('mongoose');

/**
 * Unit tests for AlertService - Track 1: Alerts & Notifications
 */
describe('AlertService', () => {
  beforeAll(async () => {
    if (mongoose.connection.readyState === 0) {
      await mongoose.connect(process.env.MONGODB_TEST_URI || 'mongodb://localhost:27017/agentx_test', {
        useNewUrlParser: true,
        useUnifiedTopology: true
      });
    }

    // Ensure unique partial index is created for race condition prevention
    await Alert.syncIndexes();

    // Enable test mode
    process.env.ALERT_TEST_MODE = 'true';
  });

  afterAll(async () => {
    await Promise.all([Alert.deleteMany({}), InferenceLog.deleteMany({ callerDetail: 'alert-rate-test' })]);
    await mongoose.connection.close();
  });

  afterEach(async () => {
    await Promise.all([Alert.deleteMany({}), InferenceLog.deleteMany({ callerDetail: 'alert-rate-test' })]);
  });

  describe('Alert correctness regressions', () => {
    test('missing template values render an explicit diagnostic instead of a truncated message', async () => {
      alertService.loadRules([{
        id: 'template-diagnostic',
        name: 'Template diagnostic',
        enabled: true,
        severity: 'critical',
        conditions: { all: [{ fact: 'metric', operator: 'equal', value: 'host_unreachable' }] },
        title: 'Host down — {{host}}',
        message: 'Ollama service {{detail}}',
        channels: ['local_log']
      }]);

      const [alert] = await alertService.evaluateEvent({
        component: 'ugbrutal',
        metric: 'host_unreachable',
        value: 1,
        additionalData: { host: 'ugbrutal' }
      });

      expect(alert.message).toContain('Ollama service [missing:detail]');
      expect(alert.message).toContain('template_error missing=detail');
      expect(alert.message).toContain('host_unreachable');
      expect(alert.message).not.toBe('Ollama service ');
    });

    test('an automatic resolve followed by refire is a flapping incident and escalates', async () => {
      alertService.loadRules([{
        id: 'flapping-host',
        name: 'Flapping host',
        enabled: true,
        severity: 'error',
        conditions: { all: [{ fact: 'metric', operator: 'equal', value: 'host_unreachable' }] },
        title: 'Host unreachable — {{host}}',
        message: '{{error}}',
        channels: ['local_log']
      }]);
      const event = {
        component: 'ugbrutal',
        metric: 'host_unreachable',
        additionalData: { host: 'ugbrutal', error: 'connection refused' }
      };

      const [first] = await alertService.evaluateEvent(event);
      await first.resolve('system', 'auto-recovery', 'Reachability restored');
      const [refired] = await alertService.evaluateEvent(event);
      const [ongoing] = await alertService.evaluateEvent(event);

      expect(refired.severity).toBe('critical');
      expect(refired.title).toContain('FLAPPING');
      expect(refired.title).toContain('2× in 6h');
      expect(refired.metadata.flapping).toEqual(expect.objectContaining({ detected: true, count: 2 }));
      expect(ongoing.title).toContain('FLAPPING');
      expect(ongoing.metadata.flapping.count).toBe(2);
    });

    test('materializes a one-hour inference error-rate fact with a minimum sample gate', async () => {
      const defaults = require('../../config/default-alert-rules.json');
      const rateRule = defaults.find(rule => rule.id === 'inference-error-rate');
      expect(rateRule).toBeTruthy();
      const rows = Array.from({ length: 20 }, (_, index) => ({
        host: 'http://test-ollama:11434',
        model: 'test-model:latest',
        caller: 'proxy',
        callerDetail: 'alert-rate-test',
        status: index < 2 ? 'error' : 'success',
        timestamp: new Date()
      }));
      await InferenceLog.create(rows);
      alertService.loadRules([rateRule]);

      const [alert] = await alertService.evaluateEvent({
        component: 'platform-inference',
        metric: 'inference_completed',
        source: 'test'
      });

      expect(alert.ruleId).toBe('inference-error-rate');
      expect(alert.message).toContain('2 of 20 calls failed (10%) over 1h');
      expect(alert.context.additionalData).toEqual(expect.objectContaining({
        errorRate: 10,
        errorRateNumerator: 2,
        errorRateTotal: 20,
        windowLabel: '1h'
      }));
    });

    test('ships re-notification for both per-event and sustained inference failures', () => {
      const defaults = require('../../config/default-alert-rules.json');
      for (const id of ['inference-error', 'inference-error-rate']) {
        expect(defaults.find(rule => rule.id === id)?.renotifyMs).toBeGreaterThan(0);
      }
    });
  });

  describe('Rule Loading', () => {
    test('should load rules from array', () => {
      const rules = [
        {
          id: 'test_rule_1',
          name: 'Test Rule 1',
          enabled: true,
          metric: 'response_time',
          threshold: 5000,
          comparison: 'greater_than',
          severity: 'warning',
          title: 'Slow Response Detected',
          message: 'Response time exceeded threshold'
        },
        {
          id: 'test_rule_2',
          name: 'Test Rule 2',
          enabled: false,
          metric: 'error_rate',
          threshold: 0.05,
          comparison: 'greater_than',
          severity: 'error',
          title: 'High Error Rate',
          message: 'Error rate is too high'
        }
      ];

      const count = alertService.loadRules(rules);

      expect(count).toBe(1); // Only enabled rules
    });

    test('should throw error for invalid rules format', () => {
      expect(() => alertService.loadRules('not an array')).toThrow();
    });
  });

  describe('Rule Evaluation', () => {
    beforeEach(() => {
      const rules = [
        {
          id: 'response_time_rule',
          name: 'Response Time Rule',
          enabled: true,
          metric: 'response_time',
          threshold: 5000,
          comparison: 'greater_than',
          severity: 'warning',
          title: 'Slow Response: {{component}}',
          message: 'Response time ({{value}}ms) exceeded threshold',
          channels: ['local_log']
        },
        {
          id: 'error_rate_rule',
          name: 'Error Rate Rule',
          enabled: true,
          metric: 'error_rate',
          threshold: 0.05,
          comparison: 'greater_than',
          severity: 'error',
          title: 'High Error Rate',
          message: 'Error rate is {{value}}',
          channels: ['local_log']
        }
      ];

      alertService.loadRules(rules);
    });

    test('should trigger alert when rule matches', async () => {
      const event = {
        component: 'ollama-99',
        metric: 'response_time',
        value: 6000,
        source: 'agentx'
      };

      const alerts = await alertService.evaluateEvent(event);

      expect(alerts).toHaveLength(1);
      expect(alerts[0].severity).toBe('warning');
      expect(alerts[0].title).toContain('ollama-99');
    });

    test('should not trigger alert when rule does not match', async () => {
      const event = {
        component: 'ollama-99',
        metric: 'response_time',
        value: 3000, // Below threshold
        source: 'agentx'
      };

      const alerts = await alertService.evaluateEvent(event);

      expect(alerts).toHaveLength(0);
    });

    test('should handle multiple matching rules', async () => {
      const rules = [
        {
          id: 'rule_1',
          name: 'Rule 1',
          enabled: true,
          componentPattern: 'ollama-*',
          threshold: 5000,
          comparison: 'greater_than',
          severity: 'warning',
          title: 'Alert 1',
          message: 'Message 1',
          channels: ['local_log']
        },
        {
          id: 'rule_2',
          name: 'Rule 2',
          enabled: true,
          componentPattern: 'ollama-99',
          threshold: 4000,
          comparison: 'greater_than',
          severity: 'error',
          title: 'Alert 2',
          message: 'Message 2',
          channels: ['local_log']
        }
      ];

      alertService.loadRules(rules);

      const event = {
        component: 'ollama-99',
        value: 6000,
        source: 'agentx'
      };

      const alerts = await alertService.evaluateEvent(event);

      expect(alerts.length).toBeGreaterThanOrEqual(1);
    });
  });

  describe('Alert Deduplication', () => {
    beforeEach(() => {
      const rules = [
        {
          id: 'dedup_test_rule',
          name: 'Deduplication Test',
          enabled: true,
          metric: 'test_metric',
          threshold: 100,
          comparison: 'greater_than',
          severity: 'info',
          title: 'Test Alert',
          message: 'Test message',
          channels: ['local_log']
        }
      ];

      alertService.loadRules(rules);
    });

    test('should deduplicate alerts within cooldown period', async () => {
      const event = {
        component: 'test-component',
        metric: 'test_metric',
        value: 150,
        source: 'test'
      };

      // First alert
      const alert1 = await alertService.evaluateEvent(event);
      expect(alert1).toHaveLength(1);
      expect(alert1[0].occurrenceCount).toBe(1);

      // Second alert (should be deduplicated)
      const alert2 = await alertService.evaluateEvent(event);
      expect(alert2).toHaveLength(1);
      expect(alert2[0].occurrenceCount).toBe(2);
      expect(alert2[0]._id.toString()).toBe(alert1[0]._id.toString());
    });
  });

  describe('Template Rendering', () => {
    beforeEach(() => {
      const rules = [
        {
          id: 'template_rule',
          name: 'Template Test',
          enabled: true,
          threshold: 100,
          comparison: 'greater_than',
          severity: 'info',
          title: 'Alert for {{component}} - {{metric}}',
          message: 'Value {{value}} exceeded threshold {{threshold}}',
          channels: ['local_log']
        }
      ];

      alertService.loadRules(rules);
    });

    test('should render templates with event data', async () => {
      const event = {
        component: 'test-service',
        metric: 'cpu_usage',
        value: 150,
        threshold: 100,
        source: 'test'
      };

      const alerts = await alertService.evaluateEvent(event);

      expect(alerts).toHaveLength(1);
      expect(alerts[0].title).toContain('test-service');
      expect(alerts[0].title).toContain('cpu_usage');
      expect(alerts[0].message).toContain('150');
    });
  });

  describe('Notification Channels', () => {
    test('should handle test mode for all channels', async () => {
      process.env.ALERT_TEST_MODE = 'true';

      const alert = new Alert({
        ruleId: 'notification_test',
        ruleName: 'Notification Test',
        severity: 'warning',
        title: 'Test Notification',
        message: 'Testing notifications',
        fingerprint: 'notif_test_fp',
        channels: ['email', 'slack', 'webhook', 'local_log']
      });

      await alert.save();

      const results = await alertService._sendNotifications(alert, alert.channels);

      // In test mode, all should succeed without actually sending
      expect(results.email?.sent || results.email?.error).toBeTruthy();
      expect(results.slack?.sent || results.slack?.error).toBeTruthy();
      expect(results.webhook?.sent || results.webhook?.error).toBeTruthy();
      expect(results.local_log?.sent || results.local_log?.error).toBeTruthy();
    });
  });

  describe('Alert Management', () => {
    test('should retrieve recent alerts', async () => {
      // Create test alerts
      await Alert.create([
        {
          ruleId: 'recent_1',
          ruleName: 'Recent 1',
          severity: 'info',
          title: 'Alert 1',
          message: 'Message 1',
          fingerprint: 'fp_recent_1'
        },
        {
          ruleId: 'recent_2',
          ruleName: 'Recent 2',
          severity: 'warning',
          title: 'Alert 2',
          message: 'Message 2',
          fingerprint: 'fp_recent_2'
        }
      ]);

      const alerts = await alertService.getRecentAlerts(10);

      expect(alerts.length).toBeGreaterThanOrEqual(2);
    });

    test('should filter alerts by severity', async () => {
      await Alert.create([
        {
          ruleId: 'filter_1',
          ruleName: 'Filter 1',
          severity: 'info',
          title: 'Info Alert',
          message: 'Info message',
          fingerprint: 'fp_filter_1'
        },
        {
          ruleId: 'filter_2',
          ruleName: 'Filter 2',
          severity: 'critical',
          title: 'Critical Alert',
          message: 'Critical message',
          fingerprint: 'fp_filter_2'
        }
      ]);

      const criticalAlerts = await alertService.getRecentAlerts(10, { severity: 'critical' });

      expect(criticalAlerts.every(a => a.severity === 'critical')).toBe(true);
    });

    test('should acknowledge alert', async () => {
      const alert = await Alert.create({
        ruleId: 'ack_test',
        ruleName: 'Ack Test',
        severity: 'warning',
        title: 'Test Alert',
        message: 'Test message',
        fingerprint: 'ack_fp'
      });

      await alertService.acknowledgeAlert(alert._id, 'test_user', 'Looking into it');

      const updated = await Alert.findById(alert._id);
      expect(updated.status).toBe('acknowledged');
      expect(updated.acknowledgment.acknowledgedBy).toBe('test_user');
    });

    test('should resolve alert', async () => {
      const alert = await Alert.create({
        ruleId: 'resolve_test',
        ruleName: 'Resolve Test',
        severity: 'error',
        title: 'Test Alert',
        message: 'Test message',
        fingerprint: 'resolve_fp'
      });

      await alertService.resolveAlert(alert._id, 'test_user', 'auto', 'Fixed automatically');

      const updated = await Alert.findById(alert._id);
      expect(updated.status).toBe('resolved');
      expect(updated.resolution.resolutionMethod).toBe('auto');
    });
  });

  describe('Statistics', () => {
    beforeEach(async () => {
      await Alert.create([
        {
          ruleId: 'stats_1',
          ruleName: 'Stats 1',
          severity: 'info',
          status: 'active',
          title: 'Alert 1',
          message: 'Message 1',
          fingerprint: 'stats_fp_1'
        },
        {
          ruleId: 'stats_2',
          ruleName: 'Stats 2',
          severity: 'warning',
          status: 'resolved',
          title: 'Alert 2',
          message: 'Message 2',
          fingerprint: 'stats_fp_2',
          resolution: {
            resolved: true,
            resolvedAt: new Date(),
            resolutionMethod: 'manual'
          }
        }
      ]);
    });

    test('should return alert statistics', async () => {
      const stats = await alertService.getStatistics();

      expect(stats).toBeDefined();
      expect(Array.isArray(stats)).toBe(true);
    });
  });

  describe('Race Condition Fix: Alert Deduplication', () => {
    beforeEach(async () => {
      await Alert.deleteMany({});
      const rules = [
        {
          id: 'race_test_rule',
          name: 'Race Test Rule',
          enabled: true,
          metric: 'concurrent_metric',
          threshold: 100,
          comparison: 'greater_than',
          severity: 'warning',
          title: 'Concurrent Alert',
          message: 'Testing race condition',
          channels: ['local_log']
        }
      ];
      alertService.loadRules(rules);
    });

    test('should prevent duplicate alerts under concurrent load', async () => {
      const event = {
        component: 'race-test-component',
        metric: 'concurrent_metric',
        value: 150,
        source: 'test'
      };

      // Simulate 10 concurrent requests for the same alert
      const promises = Array(10).fill(null).map(() =>
        alertService.evaluateEvent(event)
      );

      const results = await Promise.all(promises);

      // All results should return alerts
      expect(results.every(r => r.length === 1)).toBe(true);

      // But only ONE unique alert should exist in the database
      const allAlerts = await Alert.find({
        'context.component': 'race-test-component'
      });

      expect(allAlerts).toHaveLength(1);

      // Occurrence count should be 10 (atomic increments)
      expect(allAlerts[0].occurrenceCount).toBe(10);
    });

    test('should accurately track occurrence count under parallel updates', async () => {
      const event = {
        component: 'parallel-component',
        metric: 'concurrent_metric',
        value: 150,
        source: 'test'
      };

      // Create initial alert
      await alertService.evaluateEvent(event);

      // Wait a bit to ensure alert exists
      await new Promise(resolve => setTimeout(resolve, 50));

      // Now fire 5 more concurrent updates
      const promises = Array(5).fill(null).map(() =>
        alertService.evaluateEvent(event)
      );

      await Promise.all(promises);

      // Check final count
      const finalAlert = await Alert.findOne({
        'context.component': 'parallel-component'
      });

      expect(finalAlert).toBeDefined();
      expect(finalAlert.occurrenceCount).toBe(6); // 1 initial + 5 concurrent
    });

    test('should handle concurrent alerts with different fingerprints', async () => {
      const createEvent = (component) => ({
        component,
        metric: 'concurrent_metric',
        value: 150,
        source: 'test'
      });

      // Create 5 different alerts concurrently
      const components = ['comp-1', 'comp-2', 'comp-3', 'comp-4', 'comp-5'];
      const promises = components.map(comp =>
        alertService.evaluateEvent(createEvent(comp))
      );

      await Promise.all(promises);

      // Should have 5 distinct alerts
      const allAlerts = await Alert.find({
        'context.metric': 'concurrent_metric'
      });

      expect(allAlerts).toHaveLength(5);
      expect(allAlerts.every(a => a.occurrenceCount === 1)).toBe(true);
    });

    test('keeps one continuous incident outside the legacy cooldown window', async () => {
      // Override cooldown to 100ms for testing
      const originalCooldown = alertService.config.cooldownMs;
      alertService.config.cooldownMs = 100;

      const event = {
        component: 'cooldown-test',
        metric: 'concurrent_metric',
        value: 150,
        source: 'test'
      };

      // First alert
      await alertService.evaluateEvent(event);

      // Wait for cooldown to expire
      await new Promise(resolve => setTimeout(resolve, 150));

      // Recurrence stays on the same incident until verified recovery.
      await alertService.evaluateEvent(event);

      const alerts = await Alert.find({
        'context.component': 'cooldown-test'
      });

      expect(alerts).toHaveLength(1);
      expect(alerts[0].occurrenceCount).toBe(2);

      // Restore original cooldown
      alertService.config.cooldownMs = originalCooldown;
    });

    test('creates a new incident when recurrence follows verified recovery', async () => {
      const event = {
        component: 'recovered-component',
        metric: 'concurrent_metric',
        value: 150,
        source: 'test'
      };

      const [first] = await alertService.evaluateEvent(event);
      await first.resolve('system', 'verified-recovery', 'Recovered');
      await alertService.evaluateEvent(event);

      const alerts = await Alert.find({ 'context.component': 'recovered-component' });
      expect(alerts).toHaveLength(2);
      expect(alerts.map(alert => alert.status).sort()).toEqual(['active', 'resolved']);
    });
  });

  describe('resolveStaleAlerts (0361 auto-resolve)', () => {
    test('resolves active alerts past the window, keeps fresh ones', async () => {
      const stale = new Date(Date.now() - 60 * 60 * 1000);
      const fresh = new Date();
      await Alert.create({ ruleId: 'r', ruleName: 'R', severity: 'critical', title: 'stale', message: 'm', fingerprint: 'fp-stale', status: 'active', channels: ['local_log'], lastOccurrence: stale });
      await Alert.create({ ruleId: 'r', ruleName: 'R', severity: 'critical', title: 'fresh', message: 'm', fingerprint: 'fp-fresh', status: 'active', channels: ['local_log'], lastOccurrence: fresh });

      const n = await alertService.resolveStaleAlerts(15 * 60 * 1000);

      expect(n).toBe(1);
      const staleDoc = await Alert.findOne({ fingerprint: 'fp-stale' });
      const freshDoc = await Alert.findOne({ fingerprint: 'fp-fresh' });
      expect(staleDoc.status).toBe('resolved');
      expect(staleDoc.resolution.resolutionMethod).toBe('auto-stale');
      expect(staleDoc.resolution.resolved).toBe(true);
      expect(freshDoc.status).toBe('active');
    });
  });

  describe('resolveRecoveredInferenceAlerts', () => {
    test('resolves matching host/error/healthy-latency alerts only', async () => {
      const common = {
        ruleName: 'Inference rule',
        severity: 'warning',
        title: 'incident',
        message: 'incident',
        status: 'active',
        channels: ['local_log'],
        lastOccurrence: new Date()
      };
      await Alert.create([
        {
          ...common,
          ruleId: 'host-unreachable',
          fingerprint: 'recover-host',
          context: { component: 'primary', additionalData: { host: 'http://primary:11434', model: 'ax/model:1' } }
        },
        {
          ...common,
          ruleId: 'inference-error',
          fingerprint: 'recover-error',
          context: { component: 'primary', additionalData: { host: 'http://primary:11434', model: 'model:1' } }
        },
        {
          ...common,
          ruleId: 'latency-spike',
          fingerprint: 'recover-latency',
          context: { component: 'primary', additionalData: { host: 'http://primary:11434', model: 'model:1' } }
        },
        {
          ...common,
          ruleId: 'host-unreachable',
          fingerprint: 'other-host',
          context: { component: 'secondary', additionalData: { host: 'http://secondary:11434', model: 'model:1' } }
        }
      ]);

      const count = await alertService.resolveRecoveredInferenceAlerts({
        host: 'http://primary:11434',
        hostKey: 'primary',
        model: 'model:1',
        latencyMs: 250
      });

      expect(count).toBe(2);
      const resolved = await Alert.find({ status: 'resolved' });
      expect(resolved).toHaveLength(2);
      expect(resolved.every(alert => alert.resolution.resolutionMethod === 'auto-recovery')).toBe(true);
      expect(await Alert.countDocuments({ fingerprint: 'recover-host', status: 'active' })).toBe(1);
      expect(await Alert.countDocuments({ fingerprint: 'other-host', status: 'active' })).toBe(1);
    });

    test('keeps a latency incident active while the successful request is still slow', async () => {
      await Alert.create({
        ruleId: 'latency-spike',
        ruleName: 'Latency',
        severity: 'warning',
        title: 'slow',
        message: 'slow',
        fingerprint: 'still-slow',
        status: 'active',
        channels: ['local_log'],
        context: { component: 'primary', additionalData: { host: 'http://primary:11434', model: 'model:1' } }
      });

      const count = await alertService.resolveRecoveredInferenceAlerts({
        host: 'http://primary:11434',
        hostKey: 'primary',
        model: 'model:1',
        latencyMs: 15000
      });

      expect(count).toBe(0);
      expect(await Alert.countDocuments({ fingerprint: 'still-slow', status: 'active' })).toBe(1);
    });
  });

});
