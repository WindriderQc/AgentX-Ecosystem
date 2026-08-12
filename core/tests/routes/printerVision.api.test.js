const express = require('express');
const request = require('supertest');

jest.mock('../../models/PrinterVisionStatus', () => ({
  findOneAndUpdate: jest.fn(),
  findOne: jest.fn()
}));

const PrinterVisionStatus = require('../../models/PrinterVisionStatus');
const printerVisionRoutes = require('../../routes/printer-vision');

const sample = {
  printerId: 'anet-a7',
  printerName: 'ANET A7',
  monitorState: 'ACTIVE',
  controlMode: 'ALERT ONLY',
  status: 'SAFE',
  confidence: 'MEDIUM',
  observations: 'Impression normale.',
  firstAnalysisAt: new Date('2026-07-19T05:00:00Z'),
  lastAnalysisAt: new Date('2026-07-19T05:00:30Z'),
  intervalSeconds: 30,
  model: 'ax/Qwen3.5:9b',
  imageBase64: Buffer.from('jpeg').toString('base64'),
  updatedAt: new Date('2026-07-19T05:00:30Z')
};

const payload = {
  ...sample,
  firstAnalysisAt: sample.firstAnalysisAt.toISOString(),
  lastAnalysisAt: sample.lastAnalysisAt.toISOString()
};

function createApp() {
  const app = express();
  app.use(express.json({ limit: '5mb' }));
  app.use('/api/printer-vision', printerVisionRoutes);
  app.use((error, _req, res, _next) => res.status(500).json({ status: 'error', message: error.message }));
  return app;
}

describe('printer vision API', () => {
  beforeEach(() => jest.clearAllMocks());

  test('rejects an invalid status payload', async () => {
    const response = await request(createApp()).post('/api/printer-vision/status').send({ printerId: 'ANET A7' });
    expect(response.status).toBe(400);
  });

  test('stores a valid status and returns an image endpoint', async () => {
    PrinterVisionStatus.findOneAndUpdate.mockResolvedValue(sample);

    const response = await request(createApp()).post('/api/printer-vision/status').send(payload);

    expect(response.status).toBe(201);
    expect(response.body.data.printer.imageUrl).toBe('/api/printer-vision/status/anet-a7/image');
    expect(PrinterVisionStatus.findOneAndUpdate).toHaveBeenCalledWith(
      { printerId: 'anet-a7' },
      expect.any(Object),
      expect.objectContaining({ new: true, upsert: true })
    );
  });

  test('returns the stored JPEG image', async () => {
    PrinterVisionStatus.findOne.mockReturnValue({ lean: jest.fn().mockResolvedValue(sample) });

    const response = await request(createApp()).get('/api/printer-vision/status/anet-a7/image');

    expect(response.status).toBe(200);
    expect(response.headers['content-type']).toMatch(/image\/jpeg/);
    expect(response.body.toString()).toBe('jpeg');
  });
});
