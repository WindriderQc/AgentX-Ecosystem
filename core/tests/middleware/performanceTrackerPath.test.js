'use strict';

const express = require('express');
const request = require('supertest');

const tracker = require('../../src/middleware/performanceTracker');

describe('performance tracker path capture', () => {
  describe('normalizePath', () => {
    test('collapses ids so by_endpoint stays bounded', () => {
      expect(tracker.normalizePath('/api/performance/baselines/6a3b6a182f52dd4a482498fe'))
        .toBe('/api/performance/baselines/:id');
      expect(tracker.normalizePath('/api/widgets/12345/events'))
        .toBe('/api/widgets/:id/events');
      expect(tracker.normalizePath('/api/x/3f1a2b4c-5d6e-4f70-8a9b-0c1d2e3f4a5b'))
        .toBe('/api/x/:id');
    });

    test('leaves real route segments alone', () => {
      expect(tracker.normalizePath('/api/analytics/inference/summary'))
        .toBe('/api/analytics/inference/summary');
      // A semantic name is not an opaque id — it must survive.
      expect(tracker.normalizePath('/api/widgets/summary/events'))
        .toBe('/api/widgets/summary/events');
    });

    test('rolls nullish client interpolation into one visible invalid-id bucket', () => {
      expect(tracker.normalizePath('/api/family/room/undefined'))
        .toBe('/api/family/room/:invalid-id');
      expect(tracker.normalizePath('/api/family/room/null'))
        .toBe('/api/family/room/:invalid-id');
      expect(tracker.normalizePath('/api/family/room/undefined-room'))
        .toBe('/api/family/room/undefined-room');
    });
  });

  describe('mounted routers', () => {
    // The defect: req.path is router-relative inside a mounted router, so every
    // router root collapsed into one "/" bucket and /api/widgets/report was
    // recorded as "/report".
    function appWithMountedRouter() {
      const app = express();
      const inner = express.Router();
      inner.get('/report', (_req, res) => res.json({ ok: true }));
      inner.get('/', (_req, res) => res.json({ ok: true }));
      const api = express.Router();
      api.use('/widgets', inner);
      app.use(tracker.trackRequest);
      app.use('/api', api);
      return app;
    }

    beforeEach(async () => { await tracker.flushToDatabase().catch(() => {}); });

    test('records the full path, not the router-relative one', async () => {
      const app = appWithMountedRouter();
      await request(app).get('/api/widgets/report');
      await request(app).get('/api/widgets/');

      const paths = tracker.peekBuffer().map((r) => r.path);
      expect(paths).toContain('/api/widgets/report');
      expect(paths).toContain('/api/widgets/');
      expect(paths).not.toContain('/report');
      expect(paths).not.toContain('/');
    });

    test('drops the query string', async () => {
      const app = appWithMountedRouter();
      await request(app).get('/api/widgets/report?window=7d&x=1');
      const paths = tracker.peekBuffer().map((r) => r.path);
      expect(paths).toContain('/api/widgets/report');
    });
  });
});
