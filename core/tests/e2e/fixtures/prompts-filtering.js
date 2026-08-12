/**
 * Test Fixtures for Advanced Filtering E2E Tests
 *
 * Provides mock prompt data with varying attributes for testing filtering functionality.
 *
 * Each prompt has:
 * - name: Unique identifier
 * - description: Text description
 * - author: Creator name
 * - tags: Array of tag strings
 * - systemPrompt: The actual prompt text
 * - isActive: Boolean status
 * - createdAt: ISO date string
 * - version: Integer version number
 * - _id: Mock ObjectId
 */

// Helper to generate mock ObjectIds
function generateMockId(index) {
  return `507f1f77bcf86cd79943901${index}`.slice(0, 24);
}

// Date helpers for realistic test data
const today = new Date();
const yesterday = new Date(today);
yesterday.setDate(yesterday.getDate() - 1);
const lastWeek = new Date(today);
lastWeek.setDate(lastWeek.getDate() - 7);
const lastMonth = new Date(today);
lastMonth.setMonth(lastMonth.getMonth() - 1);

/**
 * Mock prompts grouped by name (matching API response format)
 * Format: { "prompt_name": [version1, version2, ...] }
 */
const mockPromptsGrouped = {
  "test_prompt_alpha": [
    {
      _id: generateMockId(1),
      name: "test_prompt_alpha",
      description: "Test prompt for alpha testing",
      author: "Alice Anderson",
      tags: ["testing", "alpha", "development"],
      systemPrompt: "You are a helpful alpha testing assistant.",
      isActive: true,
      version: 1,
      createdAt: today.toISOString(),
      updatedAt: today.toISOString()
    }
  ],
  "test_prompt_beta": [
    {
      _id: generateMockId(2),
      name: "test_prompt_beta",
      description: "Test prompt for beta testing",
      author: "Bob Builder",
      tags: ["testing", "beta", "qa"],
      systemPrompt: "You are a helpful beta testing assistant.",
      isActive: true,
      version: 1,
      createdAt: yesterday.toISOString(),
      updatedAt: yesterday.toISOString()
    }
  ],
  "test_prompt_gamma": [
    {
      _id: generateMockId(3),
      name: "test_prompt_gamma",
      description: "Test prompt for production use",
      author: "Charlie Chen",
      tags: ["production", "stable"],
      systemPrompt: "You are a helpful production assistant.",
      isActive: false,
      version: 1,
      createdAt: lastWeek.toISOString(),
      updatedAt: lastWeek.toISOString()
    }
  ],
  "test_prompt_delta": [
    {
      _id: generateMockId(4),
      name: "test_prompt_delta",
      description: "Advanced AI assistant for delta wave analysis",
      author: "Alice Anderson",
      tags: ["analytics", "advanced"],
      systemPrompt: "You are a specialized delta wave analysis assistant.",
      isActive: true,
      version: 1,
      createdAt: lastWeek.toISOString(),
      updatedAt: lastWeek.toISOString()
    }
  ],
  "test_prompt_epsilon": [
    {
      _id: generateMockId(5),
      name: "test_prompt_epsilon",
      description: "Customer service helper",
      author: "Eve Everson",
      tags: ["customer-service", "support"],
      systemPrompt: "You are a customer service assistant.",
      isActive: false,
      version: 1,
      createdAt: lastMonth.toISOString(),
      updatedAt: lastMonth.toISOString()
    }
  ],
  "test_prompt_zeta": [
    {
      _id: generateMockId(6),
      name: "test_prompt_zeta",
      description: "Production analytics dashboard helper",
      author: "Alice Anderson",
      tags: ["production", "analytics", "dashboard"],
      systemPrompt: "You are a dashboard analytics assistant.",
      isActive: true,
      version: 1,
      createdAt: yesterday.toISOString(),
      updatedAt: yesterday.toISOString()
    }
  ]
};

/**
 * Flat array of all prompts (for easier iteration in some tests)
 */
const mockPromptsArray = Object.values(mockPromptsGrouped).flat();

/**
 * Summary statistics about the mock data
 */
const mockDataStats = {
  totalPrompts: Object.keys(mockPromptsGrouped).length,
  totalVersions: mockPromptsArray.length,
  activeCount: mockPromptsArray.filter(p => p.isActive).length,
  inactiveCount: mockPromptsArray.filter(p => !p.isActive).length,
  uniqueAuthors: [...new Set(mockPromptsArray.map(p => p.author))],
  uniqueTags: [...new Set(mockPromptsArray.flatMap(p => p.tags))].sort(),
  byAuthor: {
    'Alice Anderson': mockPromptsArray.filter(p => p.author === 'Alice Anderson').length,
    'Bob Builder': mockPromptsArray.filter(p => p.author === 'Bob Builder').length,
    'Charlie Chen': mockPromptsArray.filter(p => p.author === 'Charlie Chen').length,
    'Eve Everson': mockPromptsArray.filter(p => p.author === 'Eve Everson').length
  },
  byTag: {
    'testing': mockPromptsArray.filter(p => p.tags.includes('testing')).length,
    'production': mockPromptsArray.filter(p => p.tags.includes('production')).length,
    'analytics': mockPromptsArray.filter(p => p.tags.includes('analytics')).length,
    'alpha': mockPromptsArray.filter(p => p.tags.includes('alpha')).length,
    'beta': mockPromptsArray.filter(p => p.tags.includes('beta')).length
  }
};

/**
 * Helper function to create API response format
 */
function createMockApiResponse(prompts = mockPromptsGrouped) {
  return {
    status: 'success',
    data: prompts
  };
}

/**
 * Helper function to filter prompts by criteria (for validation)
 */
function filterPrompts({ search, tags, author, dateFrom, dateTo, status }) {
  let filtered = Object.entries(mockPromptsGrouped);

  // Search filter
  if (search) {
    const searchLower = search.toLowerCase();
    filtered = filtered.filter(([name, versions]) => {
      if (name.toLowerCase().includes(searchLower)) return true;
      return versions.some(v =>
        (v.description && v.description.toLowerCase().includes(searchLower)) ||
        (v.author && v.author.toLowerCase().includes(searchLower))
      );
    });
  }

  // Status filter
  if (status && status !== 'all') {
    filtered = filtered.map(([name, versions]) => {
      const filteredVersions = versions.filter(v =>
        status === 'active' ? v.isActive : !v.isActive
      );
      return [name, filteredVersions];
    }).filter(([, versions]) => versions.length > 0);
  }

  // Tag filter
  if (tags && tags.length > 0) {
    filtered = filtered.filter(([name, versions]) => {
      return versions.some(v => {
        if (!v.tags || v.tags.length === 0) return false;
        return tags.some(tag => v.tags.includes(tag));
      });
    });
  }

  // Author filter
  if (author) {
    const authorLower = author.toLowerCase();
    filtered = filtered.filter(([name, versions]) => {
      return versions.some(v =>
        v.author && v.author.toLowerCase().includes(authorLower)
      );
    });
  }

  // Date range filter
  if (dateFrom || dateTo) {
    filtered = filtered.filter(([name, versions]) => {
      return versions.some(v => {
        if (!v.createdAt) return false;
        const createdDate = new Date(v.createdAt);

        if (dateFrom) {
          const fromDate = new Date(dateFrom);
          if (createdDate < fromDate) return false;
        }

        if (dateTo) {
          const toDate = new Date(dateTo);
          // Add one day to include the entire "to" date
          toDate.setDate(toDate.getDate() + 1);
          if (createdDate >= toDate) return false;
        }

        return true;
      });
    });
  }

  return Object.fromEntries(filtered);
}

module.exports = {
  mockPromptsGrouped,
  mockPromptsArray,
  mockDataStats,
  createMockApiResponse,
  filterPrompts,
  // Export date helpers for tests
  dates: {
    today: today.toISOString().split('T')[0],
    yesterday: yesterday.toISOString().split('T')[0],
    lastWeek: lastWeek.toISOString().split('T')[0],
    lastMonth: lastMonth.toISOString().split('T')[0],
    tomorrow: new Date(today.getTime() + 86400000).toISOString().split('T')[0]
  }
};
