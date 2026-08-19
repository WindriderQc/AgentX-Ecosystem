'use strict';

jest.mock('../../../models/ModelProfile');

const ModelProfile = require('../../../models/ModelProfile');

let originalFetch;

beforeEach(() => {
  jest.clearAllMocks();
  originalFetch = global.fetch;
  global.fetch = jest.fn();
});

afterEach(() => {
  global.fetch = originalFetch;
});

const service = require('../../../src/services/profiler/modelDiscoveryService');

describe('modelDiscoveryService', () => {
  describe('scanHost()', () => {
    it('fetches /api/tags and returns every exact artifact', async () => {
      const mockResponse = {
        models: [
          {
            name: 'llama3.2:3b',
            size: 2000000000,
            details: { parameter_size: '3B', family: 'llama', quantization_level: 'Q4_0' }
          },
          {
            name: 'mistral:7b',
            size: 4000000000,
            details: { parameter_size: '7B', family: 'mistral', quantization_level: 'Q4_K_M' }
          },
          {
            name: 'ax/llama3.2:3b',
            size: 2000000000,
            details: { parameter_size: '3B', family: 'llama', quantization_level: 'Q4_0' }
          }
        ]
      };

      global.fetch.mockResolvedValue({
        ok: true,
        json: jest.fn().mockResolvedValue(mockResponse)
      });

      const result = await service.scanHost('http://192.0.2.66:11434');

      expect(global.fetch).toHaveBeenCalledWith(
        'http://192.0.2.66:11434/api/tags',
        expect.objectContaining({ signal: expect.any(AbortSignal) })
      );

      expect(result).toHaveLength(3);
      expect(result[0]).toEqual({
        name: 'llama3.2:3b',
        size: 2000000000,
        parameters: '3B',
        family: 'llama',
        quantization: 'Q4_0'
      });
      expect(result[1]).toEqual({
        name: 'mistral:7b',
        size: 4000000000,
        parameters: '7B',
        family: 'mistral',
        quantization: 'Q4_K_M'
      });

      expect(result[2]).toEqual({
        name: 'ax/llama3.2:3b',
        size: 2000000000,
        parameters: '3B',
        family: 'llama',
        quantization: 'Q4_0'
      });
    });

    it('returns empty array on connection failure', async () => {
      global.fetch.mockRejectedValue(new Error('ECONNREFUSED'));

      const result = await service.scanHost('http://192.0.2.99:11434');

      expect(result).toEqual([]);
    });

    it('returns empty array when response is not ok', async () => {
      global.fetch.mockResolvedValue({ ok: false });

      const result = await service.scanHost('http://192.0.2.12:11434');

      expect(result).toEqual([]);
    });

    it('returns empty array when models list is missing from response', async () => {
      global.fetch.mockResolvedValue({
        ok: true,
        json: jest.fn().mockResolvedValue({})
      });

      const result = await service.scanHost('http://192.0.2.66:11434');

      expect(result).toEqual([]);
    });

    it('handles models with missing details gracefully', async () => {
      const mockResponse = {
        models: [
          { name: 'nodetails:latest', size: 0 }
        ]
      };

      global.fetch.mockResolvedValue({
        ok: true,
        json: jest.fn().mockResolvedValue(mockResponse)
      });

      const result = await service.scanHost('http://192.0.2.66:11434');

      expect(result).toHaveLength(1);
      expect(result[0]).toEqual({
        name: 'nodetails:latest',
        size: 0,
        parameters: '',
        family: '',
        quantization: ''
      });
    });
  });

  describe('syncHostModels()', () => {
    it('upserts ModelProfile for each discovered model with host availability', async () => {
      const mockResponse = {
        models: [
          {
            name: 'llama3.2:3b',
            size: 2000000000,
            details: { parameter_size: '3B', family: 'llama', quantization_level: 'Q4_0' }
          },
          {
            name: 'mistral:7b',
            size: 4000000000,
            details: { parameter_size: '7B', family: 'mistral', quantization_level: 'Q4_K_M' }
          }
        ]
      };

      global.fetch.mockResolvedValue({
        ok: true,
        json: jest.fn().mockResolvedValue(mockResponse)
      });

      ModelProfile.findOneAndUpdate.mockResolvedValue({});

      const result = await service.syncHostModels('http://192.0.2.66:11434', 'host-delta');

      expect(result.total).toBe(2);
      expect(result.synced).toBe(2);

      expect(ModelProfile.findOneAndUpdate).toHaveBeenCalledTimes(2);

      expect(ModelProfile.findOneAndUpdate).toHaveBeenCalledWith(
        { name: 'llama3.2:3b' },
        {
          $set: expect.objectContaining({
            'hosts.host-delta.available': true,
            'hosts.host-delta.lastSeen': expect.any(Date),
            family: 'llama',
            parameters: '3B',
            quantization: 'Q4_0'
          }),
          $setOnInsert: {
            name: 'llama3.2:3b',
            displayName: 'llama3.2',
            tags: []
          }
        },
        { upsert: true, new: true }
      );
    });

    it('counts partial failures correctly', async () => {
      const mockResponse = {
        models: [
          { name: 'llama3.2:3b', size: 0, details: {} },
          { name: 'mistral:7b', size: 0, details: {} }
        ]
      };

      global.fetch.mockResolvedValue({
        ok: true,
        json: jest.fn().mockResolvedValue(mockResponse)
      });

      ModelProfile.findOneAndUpdate
        .mockResolvedValueOnce({})
        .mockRejectedValueOnce(new Error('DB error'));

      const result = await service.syncHostModels('http://192.0.2.66:11434', 'host-delta');

      expect(result.total).toBe(2);
      expect(result.synced).toBe(1);
    });

    it('returns zero counts when scanHost returns empty', async () => {
      global.fetch.mockRejectedValue(new Error('ECONNREFUSED'));

      const result = await service.syncHostModels('http://192.0.2.99:11434', 'host-gamma');

      expect(result.total).toBe(0);
      expect(result.synced).toBe(0);
      expect(ModelProfile.findOneAndUpdate).not.toHaveBeenCalled();
    });
  });
});
