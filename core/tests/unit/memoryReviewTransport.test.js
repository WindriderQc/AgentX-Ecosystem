'use strict';

const express = require('express');
const request = require('supertest');
const {
  memoryReviewJsonParser,
  requireMemoryReviewJsonEntity,
} = require('../../src/middleware/memoryReviewTransport');

function appForTest() {
  const app = express();
  app.use('/api/memory-review', requireMemoryReviewJsonEntity, memoryReviewJsonParser);
  app.use(express.json({ limit: '50mb' }));
  app.post('/api/memory-review/echo', (req, res) => res.json({ ok: true, body: req.body }));
  return app;
}

describe('memory review transport boundary', () => {
  it('rejects a payload over 1 MiB before the broad parser can consume it', async () => {
    await request(appForTest())
      .post('/api/memory-review/echo')
      .send({ text: 'x'.repeat(1024 * 1024) })
      .expect(413);
  });

  it('requires JSON for request entities', async () => {
    const res = await request(appForTest())
      .post('/api/memory-review/echo')
      .type('text')
      .send('not json')
      .expect(415);
    expect(res.body.code).toBe('MEMORY_REVIEW_UNSUPPORTED_MEDIA_TYPE');
  });
});
