const Alert = require('../../models/Alert');
const mongoose = require('mongoose');

/**
 * Unit tests for Alert Model - Track 1: Alerts & Notifications
 */
describe('Alert Model', () => {
  beforeAll(async () => {
    // Connect to test database
    if (mongoose.connection.readyState === 0) {
      await mongoose.connect(process.env.MONGODB_TEST_URI || 'mongodb://localhost:27017/agentx_test', {
        useNewUrlParser: true,
        useUnifiedTopology: true
      });
    }
  });

  afterAll(async () => {
    await Alert.deleteMany({});
    await mongoose.connection.close();
  });

  afterEach(async () => {
    await Alert.deleteMany({});
  });

  describe('Alert Creation', () => {
    test('should create alert with required fields', async () => {
      const alertData = {
        ruleId: 'test_rule_1',
        ruleName: 'Test Rule',
        severity: 'warning',
        title: 'Test Alert',
        message: 'This is a test alert',
        fingerprint: 'test_fingerprint_123',
        channels: ['dataapi_log']
      };

      const alert = new Alert(alertData);
      const saved = await alert.save();

      expect(saved._id).toBeDefined();
      expect(saved.ruleId).toBe('test_rule_1');
      expect(saved.severity).toBe('warning');
      expect(saved.status).toBe('active'); // default
      expect(saved.occurrenceCount).toBe(1); // default
    });

    test('should validate severity enum', async () => {
      const alertData = {
        ruleId: 'test_rule_2',
        ruleName: 'Test Rule',
        severity: 'invalid_severity',
        title: 'Test Alert',
        message: 'Test message',
        fingerprint: 'test_fingerprint_456'
      };

      const alert = new Alert(alertData);

      await expect(alert.save()).rejects.toThrow();
    });

    test('should require mandatory fields', async () => {
      const alert = new Alert({});

      await expect(alert.save()).rejects.toThrow();
    });
  });

  describe('Alert Methods', () => {
    test('shouldDeduplicate should work correctly', async () => {
      const alert = new Alert({
        ruleId: 'test_rule_3',
        ruleName: 'Test Rule',
        severity: 'info',
        title: 'Test Alert',
        message: 'Test message',
        fingerprint: 'test_fingerprint_789',
        lastOccurrence: new Date(Date.now() - 60000) // 1 minute ago
      });

      await alert.save();

      // Should deduplicate within 5 minutes
      expect(alert.shouldDeduplicate(300000)).toBe(true);

      // Should not deduplicate after 30 seconds
      expect(alert.shouldDeduplicate(30000)).toBe(false);
    });

    test('acknowledge should update alert status', async () => {
      const alert = new Alert({
        ruleId: 'test_rule_4',
        ruleName: 'Test Rule',
        severity: 'error',
        title: 'Test Alert',
        message: 'Test message',
        fingerprint: 'test_fingerprint_abc'
      });

      await alert.save();

      await alert.acknowledge('user123', 'Investigating this issue');

      expect(alert.status).toBe('acknowledged');
      expect(alert.acknowledgment.acknowledged).toBe(true);
      expect(alert.acknowledgment.acknowledgedBy).toBe('user123');
      expect(alert.acknowledgment.comment).toBe('Investigating this issue');
    });

    test('resolve should update alert status', async () => {
      const alert = new Alert({
        ruleId: 'test_rule_5',
        ruleName: 'Test Rule',
        severity: 'critical',
        title: 'Test Alert',
        message: 'Test message',
        fingerprint: 'test_fingerprint_def'
      });

      await alert.save();

      await alert.resolve('user456', 'auto', 'Fixed by remediation');

      expect(alert.status).toBe('resolved');
      expect(alert.resolution.resolved).toBe(true);
      expect(alert.resolution.resolvedBy).toBe('user456');
      expect(alert.resolution.resolutionMethod).toBe('auto');
      expect(alert.resolution.comment).toBe('Fixed by remediation');
    });
  });

  describe('Static Methods', () => {
    beforeEach(async () => {
      // Create test alerts
      await Alert.create([
        {
          ruleId: 'rule_a',
          ruleName: 'Rule A',
          severity: 'warning',
          status: 'active',
          title: 'Alert 1',
          message: 'Message 1',
          fingerprint: 'fp_1'
        },
        {
          ruleId: 'rule_a',
          ruleName: 'Rule A',
          severity: 'error',
          status: 'resolved',
          title: 'Alert 2',
          message: 'Message 2',
          fingerprint: 'fp_2'
        },
        {
          ruleId: 'rule_b',
          ruleName: 'Rule B',
          severity: 'info',
          status: 'active',
          title: 'Alert 3',
          message: 'Message 3',
          fingerprint: 'fp_3'
        }
      ]);
    });

    test('findActiveByRule should return active alerts for a rule', async () => {
      const alerts = await Alert.findActiveByRule('rule_a');

      expect(alerts).toHaveLength(1);
      expect(alerts[0].status).toBe('active');
      expect(alerts[0].ruleId).toBe('rule_a');
    });

    test('findRecentByFingerprint should find recent alerts', async () => {
      // Create alert with recent timestamp
      await Alert.create({
        ruleId: 'rule_c',
        ruleName: 'Rule C',
        severity: 'warning',
        title: 'Recent Alert',
        message: 'Recent message',
        fingerprint: 'recent_fp',
        lastOccurrence: new Date()
      });

      const alert = await Alert.findRecentByFingerprint('recent_fp', 1);

      expect(alert).toBeDefined();
      expect(alert.fingerprint).toBe('recent_fp');
    });

    test('getStatistics should aggregate alert data', async () => {
      const stats = await Alert.getStatistics({
        from: new Date(Date.now() - 24 * 60 * 60 * 1000) // Last 24 hours
      });

      expect(stats).toBeDefined();
      expect(Array.isArray(stats)).toBe(true);
    });
  });

  describe('Indexes', () => {
    test('should have required indexes', async () => {
      const indexes = await Alert.collection.getIndexes();

      const indexNames = Object.keys(indexes);

      // Check for compound indexes
      expect(indexNames.some(name =>
        indexes[name].some(field => field[0] === 'status')
      )).toBe(true);

      expect(indexNames.some(name =>
        indexes[name].some(field => field[0] === 'fingerprint')
      )).toBe(true);
    });
  });

  describe('Context Data', () => {
    test('should store complex context data', async () => {
      const alert = new Alert({
        ruleId: 'context_test',
        ruleName: 'Context Test',
        severity: 'warning',
        title: 'Context Test Alert',
        message: 'Testing context storage',
        fingerprint: 'context_fp',
        context: {
          component: 'ollama-99',
          metric: 'response_time',
          currentValue: 5500,
          threshold: 5000,
          trend: 'degrading',
          additionalData: {
            model: 'qwen2.5:14b',
            requestId: 'req_123',
            timestamp: new Date()
          }
        }
      });

      const saved = await alert.save();

      expect(saved.context.component).toBe('ollama-99');
      expect(saved.context.currentValue).toBe(5500);
      expect(saved.context.additionalData.model).toBe('qwen2.5:14b');
    });
  });

  describe('Delivery Tracking', () => {
    test('should track multi-channel delivery', async () => {
      const alert = new Alert({
        ruleId: 'delivery_test',
        ruleName: 'Delivery Test',
        severity: 'error',
        title: 'Delivery Test Alert',
        message: 'Testing delivery tracking',
        fingerprint: 'delivery_fp',
        channels: ['email', 'slack', 'dataapi_log'],
        delivery: {
          email: {
            sent: true,
            sentAt: new Date(),
            recipients: ['admin@example.com']
          },
          slack: {
            sent: true,
            sentAt: new Date(),
            channelId: 'C123ABC',
            messageTs: '1234567890.123456'
          }
        }
      });

      const saved = await alert.save();

      expect(saved.delivery.email.sent).toBe(true);
      expect(saved.delivery.email.recipients).toContain('admin@example.com');
      expect(saved.delivery.slack.sent).toBe(true);
      expect(saved.delivery.slack.messageTs).toBe('1234567890.123456');
    });
  });
});
