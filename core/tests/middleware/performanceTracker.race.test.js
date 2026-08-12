const { flushToDatabase, getBufferStatus } = require('../../src/middleware/performanceTracker');
const PerformanceSnapshot = require('../../models/PerformanceSnapshot');
const mongoose = require('mongoose');

/**
 * Race Condition Tests for Performance Tracker
 *
 * Tests the fix for Race #2: Performance snapshot upsert race conditions
 * that occur when multiple workers flush metrics for the same hour
 */
describe('PerformanceTracker - Race Condition Fix', () => {
  beforeAll(async () => {
    if (mongoose.connection.readyState === 0) {
      await mongoose.connect(process.env.MONGODB_TEST_URI || 'mongodb://localhost:27017/agentx_test', {
        useNewUrlParser: true,
        useUnifiedTopology: true
      });
    }
  });

  afterAll(async () => {
    await PerformanceSnapshot.deleteMany({});
    await mongoose.connection.close();
  });

  beforeEach(async () => {
    await PerformanceSnapshot.deleteMany({});
  });

  describe('Concurrent flush operations', () => {
    test('should accurately count requests from multiple workers', async () => {
      const hour = new Date();
      hour.setMinutes(0, 0, 0);

      // Pre-create the hourly bucket to avoid upsert race conditions
      // In production, a cron job or initialization should pre-create buckets
      await PerformanceSnapshot.create({
        hour,
        requests_total: 0,
        requests_successful: 0,
        requests_failed: 0,
        by_endpoint: [],
        by_status_code: {},
        latency: { min: Infinity, max: 0, avg: 0, p95: 0, p99: 0 }
      });

      // Simulate 3 workers each flushing 10 requests concurrently
      const createSnapshot = (count) => ({
        hour,
        requests_total: count,
        requests_successful: count - 1,
        requests_failed: 1,
        latency: { min: 50, max: 500, avg: 200, p95: 450, p99: 490 },
        by_endpoint: [
          {
            path: '/api/chat',
            method: 'POST',
            count: count,
            avg_latency: 200,
            error_count: 0
          }
        ],
        by_status_code: { '200': count - 1, '500': 1 }
      });

      // Update concurrently using atomic operations (no upsert needed)
      const promises = [10, 15, 20].map(async (count) => {
        const summary = createSnapshot(count);

        // Build status code increments
        const statusCodeIncs = {};
        Object.entries(summary.by_status_code).forEach(([code, cnt]) => {
          statusCodeIncs[`by_status_code.${code}`] = cnt;
        });

        // Atomic update (document already exists, so no race)
        await PerformanceSnapshot.updateOne(
          { hour },
          {
            $inc: {
              requests_total: summary.requests_total,
              requests_successful: summary.requests_successful,
              requests_failed: summary.requests_failed,
              ...statusCodeIncs
            },
            $min: { 'latency.min': summary.latency.min },
            $max: { 'latency.max': summary.latency.max }
          }
        );
      });

      await Promise.all(promises);

      // Verify final counts
      const snapshot = await PerformanceSnapshot.findOne({ hour });

      expect(snapshot).toBeDefined();
      expect(snapshot.requests_total).toBe(45); // 10 + 15 + 20
      expect(snapshot.requests_successful).toBe(42); // (10-1) + (15-1) + (20-1)
      expect(snapshot.requests_failed).toBe(3); // 1 + 1 + 1
    });

    test('should correctly track status code distribution across workers', async () => {
      const hour = new Date();
      hour.setMinutes(0, 0, 0);

      // Pre-create the hourly bucket to avoid upsert race conditions
      await PerformanceSnapshot.create({
        hour,
        requests_total: 0,
        requests_successful: 0,
        requests_failed: 0,
        by_endpoint: [],
        by_status_code: {},
        latency: { min: Infinity, max: 0, avg: 0, p95: 0, p99: 0 }
      });

      // Three workers with different status code distributions
      const worker1 = { '200': 8, '201': 2 };
      const worker2 = { '200': 5, '400': 3, '500': 2 };
      const worker3 = { '200': 10, '201': 5, '404': 1 };

      const promises = [worker1, worker2, worker3].map(async (statusCodes) => {
        const statusCodeIncs = {};
        Object.entries(statusCodes).forEach(([code, count]) => {
          statusCodeIncs[`by_status_code.${code}`] = count;
        });

        const totalCount = Object.values(statusCodes).reduce((sum, v) => sum + v, 0);

        await PerformanceSnapshot.updateOne(
          { hour },
          {
            $inc: {
              requests_total: totalCount,
              ...statusCodeIncs
            }
          }
        );
      });

      await Promise.all(promises);

      const snapshot = await PerformanceSnapshot.findOne({ hour });

      expect(snapshot).toBeDefined();
      expect(snapshot.by_status_code['200']).toBe(23); // 8 + 5 + 10
      expect(snapshot.by_status_code['201']).toBe(7);  // 2 + 5
      expect(snapshot.by_status_code['400']).toBe(3);  // 3
      expect(snapshot.by_status_code['404']).toBe(1);  // 1
      expect(snapshot.by_status_code['500']).toBe(2);  // 2
    });

    test('should handle min/max latency correctly across concurrent updates', async () => {
      const hour = new Date();
      hour.setMinutes(0, 0, 0);

      // Pre-create the hourly bucket to avoid $min/$max conflict with $setOnInsert
      await PerformanceSnapshot.create({
        hour,
        requests_total: 0,
        requests_successful: 0,
        requests_failed: 0,
        by_endpoint: [],
        by_status_code: {},
        latency: { min: Infinity, max: 0, avg: 0, p95: 0, p99: 0 }
      });

      // Three workers with different latency ranges
      const latencyData = [
        { min: 50, max: 200 },
        { min: 30, max: 500 },  // Overall min
        { min: 80, max: 800 }   // Overall max
      ];

      const promises = latencyData.map(async (latency) => {
        await PerformanceSnapshot.updateOne(
          { hour },
          {
            $inc: { requests_total: 10 },
            $min: { 'latency.min': latency.min },
            $max: { 'latency.max': latency.max }
          }
        );
      });

      await Promise.all(promises);

      const snapshot = await PerformanceSnapshot.findOne({ hour });

      expect(snapshot).toBeDefined();
      expect(snapshot.latency.min).toBe(30);  // Minimum across all workers
      expect(snapshot.latency.max).toBe(800); // Maximum across all workers
    });

    test('should prevent lost increments under high concurrency', async () => {
      const hour = new Date();
      hour.setMinutes(0, 0, 0);

      // Pre-create the hourly bucket to avoid upsert race conditions
      await PerformanceSnapshot.create({
        hour,
        requests_total: 0,
        requests_successful: 0,
        requests_failed: 0,
        by_endpoint: [],
        by_status_code: {},
        latency: { min: Infinity, max: 0, avg: 0, p95: 0, p99: 0 }
      });

      // Simulate 50 concurrent flush operations (no upsert race now)
      const promises = Array(50).fill(null).map(async () => {
        await PerformanceSnapshot.updateOne(
          { hour },
          {
            $inc: {
              requests_total: 1,
              requests_successful: 1,
              'by_status_code.200': 1
            }
          }
        );
      });

      await Promise.all(promises);

      const snapshot = await PerformanceSnapshot.findOne({ hour });

      expect(snapshot).toBeDefined();
      expect(snapshot.requests_total).toBe(50);
      expect(snapshot.requests_successful).toBe(50);
      expect(snapshot.by_status_code['200']).toBe(50);
    });

    test('should handle multiple hours without interference', async () => {
      const hour1 = new Date();
      hour1.setMinutes(0, 0, 0);

      const hour2 = new Date(hour1);
      hour2.setHours(hour2.getHours() + 1);

      // Update two different hours concurrently
      await Promise.all([
        PerformanceSnapshot.updateOne(
          { hour: hour1 },
          {
            $inc: { requests_total: 100 },
            $setOnInsert: {
              hour: hour1,
              by_endpoint: [],
              latency: { min: 0, max: 0, avg: 0, p95: 0, p99: 0 },
              requests_successful: 0,
              requests_failed: 0
            }
          },
          { upsert: true }
        ),
        PerformanceSnapshot.updateOne(
          { hour: hour2 },
          {
            $inc: { requests_total: 200 },
            $setOnInsert: {
              hour: hour2,
              by_endpoint: [],
              latency: { min: 0, max: 0, avg: 0, p95: 0, p99: 0 },
              requests_successful: 0,
              requests_failed: 0
            }
          },
          { upsert: true }
        )
      ]);

      const snapshot1 = await PerformanceSnapshot.findOne({ hour: hour1 });
      const snapshot2 = await PerformanceSnapshot.findOne({ hour: hour2 });

      expect(snapshot1.requests_total).toBe(100);
      expect(snapshot2.requests_total).toBe(200);
    });
  });

  describe('Regression tests', () => {
    test('should maintain backward compatibility with single-worker operation', async () => {
      const hour = new Date();
      hour.setMinutes(0, 0, 0);

      const summary = {
        hour,
        requests_total: 25,
        requests_successful: 24,
        requests_failed: 1,
        latency: { min: 10, max: 300, avg: 150, p95: 280, p99: 295 },
        by_endpoint: [
          { path: '/api/test', method: 'GET', count: 25, avg_latency: 150, error_count: 1 }
        ],
        by_status_code: { '200': 24, '500': 1 }
      };

      await PerformanceSnapshot.create(summary);

      const snapshot = await PerformanceSnapshot.findOne({ hour });

      expect(snapshot).toBeDefined();
      expect(snapshot.requests_total).toBe(25);
      expect(snapshot.latency.avg).toBe(150);
    });
  });
});
