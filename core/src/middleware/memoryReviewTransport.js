'use strict';

const express = require('express');

function requireMemoryReviewJsonEntity(req, res, next) {
  const hasEntity = Number(req.get('content-length') || 0) > 0
    || Boolean(req.get('transfer-encoding'));
  if (hasEntity && !req.is('application/json')) {
    return res.status(415).json({
      status: 'error',
      message: 'Memory Review request bodies must use application/json.',
      code: 'MEMORY_REVIEW_UNSUPPORTED_MEDIA_TYPE',
    });
  }
  return next();
}

const memoryReviewJsonParser = express.json({ limit: '1mb' });

module.exports = {
  memoryReviewJsonParser,
  requireMemoryReviewJsonEntity,
};
