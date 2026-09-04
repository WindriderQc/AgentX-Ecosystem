'use strict';

const express = require('express');
const request = require('supertest');

jest.mock('../../../src/services/profiler/modelProfileService', () => ({
  getAll: jest.fn(),
  getByName: jest.fn(),
  updateMetadata: jest.fn()
}));
jest.mock('../../../src/services/profiler/modelPerformanceProfileService', () => ({
  getActiveProfile: jest.fn()
}));

const service = require('../../../src/services/profiler/modelProfileService');
const router = require('../../../routes/profiler/models');
const app = express();
app.use(express.json());
app.use('/api/profiler/models', router);

describe('ModelProfile write authority', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    service.updateMetadata.mockResolvedValue({ name: 'model:1', displayName: 'Model One' });
  });

  it.each(['readiness', 'profile', 'benchmarkStats', 'capabilities'])('rejects raw %s mutation', async field => {
    const response = await request(app)
      .put('/api/profiler/models/model%3A1')
      .send({ [field]: {} });
    expect(response.status).toBe(403);
    expect(response.body.code).toBe('PROFILE_AUTHORITY_FIELDS_FORBIDDEN');
    expect(service.updateMetadata).not.toHaveBeenCalled();
  });

  it('allows presentation metadata only', async () => {
    const response = await request(app)
      .put('/api/profiler/models/model%3A1')
      .send({ displayName: 'Model One', tags: ['local'] });
    expect(response.status).toBe(200);
    expect(response.body.authority).toBe('metadata_only');
    expect(service.updateMetadata).toHaveBeenCalledWith('model:1', {
      displayName: 'Model One', tags: ['local']
    });
  });
});
