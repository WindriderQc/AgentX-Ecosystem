/**
 * E2E Tests for PromptImprovementWizard Component
 * Covers analysis load, step navigation, and prompt creation
 */

const { test, expect } = require('@playwright/test');

const mockAuth = {
  status: 'success',
  user: {
    _id: 'test-user',
    email: 'test@example.com',
    name: 'Test User',
    userId: 'testuser'
  }
};

const mockPrompts = {
  status: 'success',
  data: {
    default_chat: [
      {
        _id: 'prompt-1',
        version: 1,
        isActive: true,
        trafficWeight: 100,
        description: 'Default prompt',
        stats: { impressions: 10, positiveCount: 2, negativeCount: 8 },
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      }
    ]
  }
};

const mockAnalysis = {
  status: 'success',
  data: {
    prompt: {
      name: 'default_chat',
      version: 1,
      systemPrompt: 'You are a helpful assistant.'
    },
    conversations: 5,
    patternAnalysis: {
      patterns: [{ type: 'knowledge_gap', count: 2, examples: ['I am not sure.'] }],
      themes: [{ theme: 'accuracy', count: 3 }],
      stats: {
        totalConversations: 5,
        avgMessagesPerConversation: 4,
        mostCommonFailurePoints: [{ stage: 'mid', count: 3 }]
      }
    },
    llmAnalysis: {
      root_causes: ['Lack of domain constraints'],
      improvement_suggestions: [
        {
          category: 'clarity',
          suggestion: 'Provide explicit guidance on brevity.',
          rationale: 'Prevents long, unfocused responses.'
        }
      ],
      suggested_prompt: 'You are a concise assistant that answers with clarity.'
    }
  }
};

const mockMetrics = {
  status: 'success',
  data: {
    prompts: []
  }
};

const mockTrending = {
  status: 'success',
  data: {
    trending: []
  }
};

test.describe('PromptImprovementWizard', () => {
  test.beforeEach(async ({ page }) => {
    await page.route('**/api/auth/me', (route) => {
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(mockAuth) });
    });

    await page.route('**/api/prompts', (route) => {
      const method = route.request().method();
      if (method === 'GET') {
        route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(mockPrompts) });
        return;
      }
      if (method === 'POST') {
        route.fulfill({
          status: 201,
          contentType: 'application/json',
          body: JSON.stringify({
            status: 'success',
            data: {
              _id: 'prompt-2',
              name: 'default_chat',
              version: 2,
              isActive: false
            }
          })
        });
        return;
      }
      route.fallback();
    });

    await page.route('**/api/analytics/prompt-metrics*', (route) => {
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(mockMetrics) });
    });

    await page.route('**/api/analytics/trending*', (route) => {
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(mockTrending) });
    });

    await page.route('**/api/analytics/feedback/summary*', (route) => {
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ status: 'success', data: { lowPerformingPrompts: [] } })
      });
    });

    await page.route('**/api/prompts/default_chat/analyze-failures', (route) => {
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(mockAnalysis) });
    });

    await page.goto('http://localhost:3080/prompts.html');
    await page.waitForLoadState('networkidle');
  });

  test('opens wizard and shows analysis summary', async ({ page }) => {
    await page.evaluate(() => {
      document.dispatchEvent(new CustomEvent('improve-prompt', {
        detail: { promptName: 'default_chat', promptVersion: 1 }
      }));
    });

    const wizard = page.locator('.improvement-wizard-modal');
    await expect(wizard).toBeVisible();

    const summary = wizard.locator('.analysis-summary');
    await expect(summary).toBeVisible();
    await expect(summary).toContainText('Conversations Analyzed');
  });

  test('completes wizard flow and creates new version', async ({ page }) => {
    await page.evaluate(() => {
      window.__promptVersionChanged = false;
      document.addEventListener('prompt-version-changed', () => {
        window.__promptVersionChanged = true;
      });
    });

    await page.evaluate(() => {
      document.dispatchEvent(new CustomEvent('improve-prompt', {
        detail: { promptName: 'default_chat', promptVersion: 1 }
      }));
    });

    await page.click('#btnNext'); // Step 1 -> Step 2
    await page.click('#btnNext'); // Step 2 -> Step 3
    await page.fill('#customPromptText', 'You are a concise assistant.');
    await page.click('#btnNext'); // Step 3 -> Step 4
    await page.click('#btnNext'); // Step 4 -> Step 5

    const createResponse = page.waitForResponse((response) => {
      return response.url().endsWith('/api/prompts') && response.request().method() === 'POST';
    });
    await page.click('#btnCreate');
    await createResponse;

    const eventFired = await page.evaluate(() => window.__promptVersionChanged);
    expect(eventFired).toBe(true);

    await expect(page.locator('.improvement-wizard-modal')).toHaveCount(0);
  });
});
