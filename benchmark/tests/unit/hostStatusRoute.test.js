'use strict';

const express = require('express');
const request = require('supertest');

jest.mock('../../src/services/profiler/hostProfileService', () => ({
  getById: jest.fn(),
  checkStatus: jest.fn(),
  updateStatus: jest.fn(),
  upsert: jest.fn(),
}));

const hostProfileService = require('../../src/services/profiler/hostProfileService');
const router = require('../../routes/profiler/hosts');

const app = express();
app.use(express.json());
app.use('/api/profiler/hosts', router);

describe('Profiler host status read/refresh split', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    hostProfileService.getById.mockResolvedValue({
      hostId: 'primary',
      hostUrl: 'http://localhost:11434',
      status: 'online',
      lastSeenAt: new Date('2026-08-28T00:00:00.000Z'),
      dedicated: null,
    });
  });

  test('GET returns stored evidence without probing or writing', async () => {
    const response = await request(app).get('/api/profiler/hosts/primary/status');

    expect(response.status).toBe(200);
    expect(response.body.data.status).toBe('online');
    expect(hostProfileService.checkStatus).not.toHaveBeenCalled();
    expect(hostProfileService.updateStatus).not.toHaveBeenCalled();
    expect(hostProfileService.upsert).not.toHaveBeenCalled();
  });

  test('POST refresh owns the live probe and evidence update', async () => {
    hostProfileService.checkStatus.mockResolvedValue({ status: 'online', dedicated: null });
    hostProfileService.updateStatus.mockResolvedValue();
    hostProfileService.upsert.mockResolvedValue();

    const response = await request(app).post('/api/profiler/hosts/primary/status/refresh');

    expect(response.status).toBe(200);
    expect(hostProfileService.checkStatus).toHaveBeenCalledWith('http://localhost:11434');
    expect(hostProfileService.updateStatus).toHaveBeenCalledWith('primary', 'online');
    expect(hostProfileService.upsert).toHaveBeenCalled();
  });
});
