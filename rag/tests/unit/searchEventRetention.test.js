describe('SearchEvent retention', () => {
  const originalRetention = process.env.RAG_SEARCH_EVENT_RETENTION_DAYS;

  afterEach(() => {
    jest.resetModules();
    if (originalRetention === undefined) delete process.env.RAG_SEARCH_EVENT_RETENTION_DAYS;
    else process.env.RAG_SEARCH_EVENT_RETENTION_DAYS = originalRetention;
  });

  test('bounds metadata retention to 90 days by default', () => {
    delete process.env.RAG_SEARCH_EVENT_RETENTION_DAYS;
    const SearchEvent = require('../../models/SearchEvent');
    expect(SearchEvent.schema.indexes()).toContainEqual([
      { createdAt: 1 },
      expect.objectContaining({ expireAfterSeconds: 90 * 86400 }),
    ]);
  });

  test('accepts a positive operator-configured retention window', () => {
    process.env.RAG_SEARCH_EVENT_RETENTION_DAYS = '30';
    const SearchEvent = require('../../models/SearchEvent');
    expect(SearchEvent.schema.indexes()).toContainEqual([
      { createdAt: 1 },
      expect.objectContaining({ expireAfterSeconds: 30 * 86400 }),
    ]);
  });
});
