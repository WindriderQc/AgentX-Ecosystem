const request = require('supertest');
const { app } = require('../../src/app');

// Mock mongoose models
// We define the mock functions here but they need to be accessed inside the factory or declared globally if using var
// However, jest.mock factory cannot access out-of-scope variables unless they are prefixed with 'mock' AND declared properly.
// The issue is initialization order. jest.mock is hoisted. const ... = jest.fn() is not hoisted.

// Move mock function definitions inside the mock factory or use a better pattern.
// Pattern: mock the module, then in the test get the mocked module and manipulate the mocks.

jest.mock('../../models/Conversation', () => {
  const mockFind = jest.fn();
  const mockFindById = jest.fn();
  const mockFindOne = jest.fn();
  const mockAggregate = jest.fn();
  const mockCountDocuments = jest.fn();

  // Make chainable
  const chainable = {
    sort: jest.fn().mockReturnThis(),
    limit: jest.fn().mockReturnThis(),
    select: jest.fn().mockReturnThis(),
    skip: jest.fn().mockReturnThis(),
  };

  mockFind.mockReturnValue(chainable);
  mockFindById.mockReturnValue(chainable);
  mockFindOne.mockReturnValue(chainable);

  return {
    find: mockFind,
    findById: mockFindById,
    findOne: mockFindOne,
    aggregate: mockAggregate,
    countDocuments: mockCountDocuments,
    create: jest.fn(),
    // Expose mocks for test assertion
    __mocks: {
      find: mockFind,
      findById: mockFindById,
      findOne: mockFindOne,
      aggregate: mockAggregate,
      countDocuments: mockCountDocuments
    }
  };
});

jest.mock('../../models/PromptConfig', () => {
  return {
    getActive: jest.fn(),
  };
});

const Conversation = require('../../models/Conversation');

describe('API Routes Integration', () => {

  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('GET /api/history', () => {
    it('should return a list of conversations', async () => {
      // Mock data
      const mockConversations = [
        {
          _id: { toHexString: () => '507f1f77bcf86cd799439011' },
          title: 'Test Conv 1',
          updatedAt: new Date('2026-08-20T02:00:00.000Z'),
          model: 'llama2',
          messages: [{ content: 'Hello' }]
        }
      ];

      // Setup chainable mock
      // We need to access the mock function from the required module now
      const mockFind = Conversation.__mocks.find;

      const mockSelect = jest.fn().mockResolvedValue(mockConversations);
      const mockLimit = jest.fn().mockReturnValue({ select: mockSelect });
      const mockSort = jest.fn().mockReturnValue({ limit: mockLimit });
      mockFind.mockReturnValue({ sort: mockSort });

      const res = await request(app)
        .get('/api/history');

      expect(res.statusCode).toBe(200);
      expect(res.body.status).toBe('success');
      expect(res.body.data).toHaveLength(1);
      expect(res.body.data[0].id).toBe('507f1f77bcf86cd799439011');
      expect(res.body.data[0].date).toBe('2026-08-20T02:00:00.000Z');
      expect(mockFind).toHaveBeenCalledWith({
        userId: 'default',
        'lifecycle.status': { $ne: 'archived' }
      });
    });

    it('should handle errors gracefully', async () => {
      const mockFind = Conversation.__mocks.find;
      mockFind.mockImplementation(() => {
        throw new Error('Database error');
      });

      const res = await request(app)
        .get('/api/history');

      expect(res.statusCode).toBe(500);
      expect(res.body.status).toBe('error');
    });
  });

  describe('GET /api/history/:id', () => {
    it('should return a single conversation', async () => {
      const mockConversation = {
        _id: { toHexString: () => '507f1f77bcf86cd799439011' },
        title: 'Test Conv 1',
        createdAt: new Date('2026-08-20T01:00:00.000Z'),
        updatedAt: new Date('2026-08-20T02:00:00.000Z'),
        messages: [{ _id: { toHexString: () => '507f1f77bcf86cd799439012' }, role: 'user', content: 'Hello', timestamp: new Date('2026-08-20T01:30:00.000Z') }]
      };
      const mockFindById = Conversation.__mocks.findOne;
      mockFindById.mockResolvedValue(mockConversation);

      const res = await request(app)
        .get('/api/history/507f1f77bcf86cd799439011');

      expect(res.statusCode).toBe(200);
      expect(res.body.data._id).toBe('507f1f77bcf86cd799439011');
      expect(res.body.data.updatedAt).toBe('2026-08-20T02:00:00.000Z');
      expect(res.body.data.messages[0]._id).toBe('507f1f77bcf86cd799439012');
      expect(res.body.data.messages[0].timestamp).toBe('2026-08-20T01:30:00.000Z');
    });

    it('should return 404 if not found', async () => {
      const mockFindById = Conversation.__mocks.findOne;
      mockFindById.mockResolvedValue(null);

      const res = await request(app)
        .get('/api/history/507f1f77bcf86cd799439011');

      expect(res.statusCode).toBe(404);
    });
  });

});
