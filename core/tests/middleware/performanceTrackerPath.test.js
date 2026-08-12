'use strict';

const express = require('express');
const request = require('supertest');

const tracker = require('../../src/middleware/performanceTracker');

describe('performance tracker path capture', () => {
  describe('normalizePath', () => {
    test('collapses ids so by_endpoint stays bounded', () => {
      expect(tracker.normalizePath('/api/performance/baselines/6a3b6a182f52dd4a482498fe'))
        .toBe('/api/performance/baselines/:id');
      expect(tracker.normalizePath('/api/host-monitor/12345/tasks'))
        .toBe('/api/host-monitor/:id/tasks');
      expect(tracker.normalizePath('/api/x/3f1a2b4c-5d6e-4f70-8a9b-0c1d2e3f4a5b'))
        .toBe('/api/x/:id');
    });

    test('leaves real route segments alone', () => {
      expect(tracker.normalizePath('/api/analytics/inference/summary'))
        .toBe('/api/analytics/inference/summary');
      // A host id is a name, not an argument — it must survive.
      expect(tracker.normalizePath('/api/host-monitor/host-beta/tasks'))
        .toBe('/api/host-monitor/host-beta/tasks');
    });
  });

  describe('mounted routers', () => {
    // The defect: req.path is router-relative inside a mounted router, so every
    // router root collapsed into one "/" bucket and /api/host-monitor/report was
    // recorded as "/report".
    function appWithMountedRouter() {
      const app = express();
      const inner = express.Router();
      inner.get('/report', (_req, res) => res.json({ ok: true }));
      inner.get('/', (_req, res) => res.json({ ok: true }));
      const api = express.Router();
      api.use('/host-monitor', inner);
      app.use(tracker.trackRequest);
      app.use('/api', api);
      return app;
    }

    beforeEach(async () => { await tracker.flushToDatabase().catch(() => {}); });

    test('records the full path, not the router-relative one', async () => {
      const app = appWithMountedRouter();
      await request(app).get('/api/host-monitor/report');
      await request(app).get('/api/host-monitor/');

      const paths = tracker.peekBuffer().map((r) => r.path);
      expect(paths).toContain('/api/host-monitor/report');
      expect(paths).toContain('/api/host-monitor/');
      expect(paths).not.toContain('/report');
      expect(paths).not.toContain('/');
    });

    test('drops the query string', async () => {
      const app = appWithMountedRouter();
      await request(app).get('/api/host-monitor/report?window=7d&x=1');
      const paths = tracker.peekBuffer().map((r) => r.path);
      expect(paths).toContain('/api/host-monitor/report');
    });
  });
});
