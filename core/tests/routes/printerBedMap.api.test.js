const express = require('express');
const request = require('supertest');

jest.mock('../../models/PrinterVisionStatus', () => ({ findOneAndUpdate: jest.fn(), findOne: jest.fn() }));
jest.mock('../../models/PrinterBedMap', () => ({ create: jest.fn(), find: jest.fn() }));

const PrinterBedMap = require('../../models/PrinterBedMap');
const routes = require('../../routes/printer-vision');
const points = ['back-left', 'back-center', 'back-right', 'center-left', 'center', 'center-right', 'front-left', 'front-center', 'front-right']
  .map((id, index) => ({ id, label: id, x: index % 3 - 1, y: 1 - Math.floor(index / 3), z: index === 4 ? 0 : .03 }));
const map = { _id: 'map-1', printerId: 'anet-a7', printerName: 'ANET A7', mode: 'MANUAL', note: 'test', points, createdAt: new Date('2026-07-19T06:00:00Z') };
const app = () => { const server = express(); server.use(express.json()); server.use('/api/printer-vision', routes); return server; };

describe('printer bed map API', () => {
  beforeEach(() => jest.clearAllMocks());
  test('rejects incomplete bed maps', async () => {
    const response = await request(app()).post('/api/printer-vision/bed-maps/anet-a7').send({ points: points.slice(0, 8) });
    expect(response.status).toBe(400);
  });
  test('stores a complete manual bed map', async () => {
    PrinterBedMap.create.mockResolvedValue(map);
    const response = await request(app()).post('/api/printer-vision/bed-maps/anet-a7').send({ printerName: 'ANET A7', points });
    expect(response.status).toBe(201); expect(response.body.data.map.id).toBe('map-1');
  });
  test('returns recent map history', async () => {
    PrinterBedMap.find.mockReturnValue({ sort: () => ({ limit: () => ({ lean: jest.fn().mockResolvedValue([map]) }) }) });
    const response = await request(app()).get('/api/printer-vision/bed-maps/anet-a7');
    expect(response.status).toBe(200); expect(response.body.data.maps).toHaveLength(1);
  });
});
