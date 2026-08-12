/**
 * Test Fixtures for Export/Import E2E Tests
 *
 * Provides mock prompt data for testing export/import functionality.
 */

// Helper to generate mock ObjectIds
function generateMockId(index) {
  return `507f1f77bcf86cd79943901${index}`.padEnd(24, '0');
}

// Sample prompts for export testing
const mockPromptsForExport = {
  "test_prompt_1": [
    {
      _id: generateMockId(1),
      name: "test_prompt_1",
      version: 1,
      description: "Test prompt 1 for E2E testing",
      author: "e2e-test",
      tags: ["test", "tag1"],
      systemPrompt: "You are a test assistant 1. This is for E2E testing.",
      isActive: true,
      trafficWeight: 100,
      createdAt: new Date('2024-01-15T10:00:00Z').toISOString(),
      updatedAt: new Date('2024-01-15T10:00:00Z').toISOString()
    }
  ],
  "test_prompt_2": [
    {
      _id: generateMockId(2),
      name: "test_prompt_2",
      version: 1,
      description: "Test prompt 2 for E2E testing",
      author: "e2e-test",
      tags: ["test", "tag2"],
      systemPrompt: "You are a test assistant 2. This is for E2E testing.",
      isActive: false,
      trafficWeight: 100,
      createdAt: new Date('2024-01-16T10:00:00Z').toISOString(),
      updatedAt: new Date('2024-01-16T10:00:00Z').toISOString()
    }
  ],
  "test_prompt_3": [
    {
      _id: generateMockId(3),
      name: "test_prompt_3",
      version: 1,
      description: "Test prompt 3 for E2E testing",
      author: "e2e-test",
      tags: ["test", "tag3"],
      systemPrompt: "You are a test assistant 3. This is for E2E testing.",
      isActive: false,
      trafficWeight: 100,
      createdAt: new Date('2024-01-17T10:00:00Z').toISOString(),
      updatedAt: new Date('2024-01-17T10:00:00Z').toISOString()
    }
  ]
};

// Flatten for export array format
const mockPromptsArray = Object.values(mockPromptsForExport).flat();

// Valid export data (what would be in an exported JSON file)
const validExportData = mockPromptsArray.map(p => ({
  name: p.name,
  version: p.version,
  description: p.description,
  author: p.author,
  tags: p.tags,
  systemPrompt: p.systemPrompt,
  isActive: p.isActive,
  trafficWeight: p.trafficWeight,
  createdAt: p.createdAt,
  updatedAt: p.updatedAt
}));

// Invalid JSON content (malformed)
const invalidJsonContent = '{ "prompts": [ { "name": "test" } }'; // Missing closing brace

// Invalid format (not an array)
const invalidFormatData = {
  prompts: [{ name: "test" }]
};

// Invalid prompt data (missing required fields)
const invalidPromptData = [
  {
    name: "valid_prompt",
    version: 1,
    description: "Valid prompt",
    author: "test",
    tags: ["test"],
    systemPrompt: "Test",
    isActive: true,
    trafficWeight: 100
  },
  {
    // Missing required fields
    name: "invalid_prompt",
    description: "Missing version and systemPrompt"
  },
  {
    name: "another_valid",
    version: 1,
    description: "Another valid",
    author: "test",
    tags: [],
    systemPrompt: "Test 2",
    isActive: false,
    trafficWeight: 50
  }
];

// Prompts with duplicate names (for conflict testing)
const duplicatePromptData = [
  {
    name: "test_prompt_1", // Duplicate of existing
    version: 2,
    description: "Updated version",
    author: "e2e-test",
    tags: ["test", "updated"],
    systemPrompt: "Updated prompt",
    isActive: true,
    trafficWeight: 100
  },
  {
    name: "new_prompt",
    version: 1,
    description: "Brand new prompt",
    author: "e2e-test",
    tags: ["new"],
    systemPrompt: "New prompt",
    isActive: true,
    trafficWeight: 100
  }
];

// Prompts with special characters
const specialCharPromptData = [
  {
    name: "special_char_prompt",
    version: 1,
    description: "Test with special chars: <>&\"'",
    author: "test@example.com",
    tags: ["special", "chars"],
    systemPrompt: "System prompt with special chars: <script>alert('xss')</script>\n\nMultiline\tcontent",
    isActive: true,
    trafficWeight: 100
  }
];

// Empty export data
const emptyExportData = [];

/**
 * Helper to create API response format
 */
function createMockApiResponse(prompts = mockPromptsForExport) {
  return {
    status: 'success',
    data: prompts
  };
}

/**
 * Helper to create export blob
 */
function createExportBlob(data = validExportData) {
  return new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
}

module.exports = {
  mockPromptsForExport,
  mockPromptsArray,
  validExportData,
  invalidJsonContent,
  invalidFormatData,
  invalidPromptData,
  duplicatePromptData,
  specialCharPromptData,
  emptyExportData,
  createMockApiResponse,
  createExportBlob,
  generateMockId
};
