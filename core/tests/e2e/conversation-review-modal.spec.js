/**
 * E2E Tests for ConversationReviewModal Component
 * Covers modal open, filtering, export, and LLM handoff
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

const buildMockConversations = () => {
  const now = new Date();
  const oldDate = new Date(now.getTime() - 40 * 24 * 60 * 60 * 1000);

  return {
    status: 'success',
    data: {
      conversations: [
        {
          _id: 'conv-1',
          createdAt: now.toISOString(),
          model: 'qwen2.5:7b',
          messages: [
            { role: 'user', content: 'Hello' },
            { role: 'assistant', content: 'Sorry, I cannot help.', feedback: { rating: -1, comment: 'Not helpful' } }
          ]
        },
        {
          _id: 'conv-2',
          createdAt: oldDate.toISOString(),
          model: 'qwen2.5:7b',
          messages: [
            { role: 'user', content: 'What is the weather?' },
            { role: 'assistant', content: 'I do not know.', feedback: { rating: -1 } }
          ]
        }
      ]
    }
  };
};

test.describe('ConversationReviewModal', () => {
  test.beforeEach(async ({ page }) => {
    await page.route('**/api/auth/me', (route) => {
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(mockAuth) });
    });

    await page.route('**/api/prompts', (route) => {
      if (route.request().method() === 'GET') {
        route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(mockPrompts) });
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

    await page.route('**/api/dataset/conversations*', (route) => {
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(buildMockConversations())
      });
    });

    await page.goto('http://localhost:3080/prompts.html');
    await page.waitForLoadState('networkidle');
  });

  test('opens modal and renders conversations', async ({ page }) => {
    await page.evaluate(() => {
      document.dispatchEvent(new CustomEvent('review-prompt-conversations', {
        detail: { promptName: 'default_chat', promptVersion: 1 }
      }));
    });

    const modal = page.locator('.conversation-review-modal');
    await expect(modal).toBeVisible();

    const cards = modal.locator('.conversation-card');
    await expect(cards).toHaveCount(2);
  });

  test('filters conversations by time range', async ({ page }) => {
    await page.evaluate(() => {
      document.dispatchEvent(new CustomEvent('review-prompt-conversations', {
        detail: { promptName: 'default_chat', promptVersion: 1 }
      }));
    });

    const modal = page.locator('.conversation-review-modal');
    await expect(modal).toBeVisible();

    const allTab = modal.locator('.filter-tab[data-filter="all"]');
    const weekTab = modal.locator('.filter-tab[data-filter="week"]');
    const monthTab = modal.locator('.filter-tab[data-filter="month"]');

    await expect(allTab).toHaveClass(/active/);

    await weekTab.click();
    await expect(weekTab).toHaveClass(/active/);

    const weekCards = modal.locator('.conversation-card');
    await expect(weekCards).toHaveCount(1);

    await monthTab.click();
    await expect(monthTab).toHaveClass(/active/);
  });

  test('exports conversations as JSON', async ({ page }) => {
    await page.evaluate(() => {
      document.dispatchEvent(new CustomEvent('review-prompt-conversations', {
        detail: { promptName: 'default_chat', promptVersion: 1 }
      }));
    });

    const downloadPromise = page.waitForEvent('download');
    await page.click('#exportConversationsBtn');
    const download = await downloadPromise;

    expect(download.suggestedFilename()).toContain('conversations-default_chat-v1');
  });

  test('dispatches improve-prompt event from Analyze button', async ({ page }) => {
    await page.evaluate(() => {
      window.__improveDetail = null;
      document.addEventListener('improve-prompt', (event) => {
        window.__improveDetail = event.detail;
      });
    });

    await page.evaluate(() => {
      document.dispatchEvent(new CustomEvent('review-prompt-conversations', {
        detail: { promptName: 'default_chat', promptVersion: 1 }
      }));
    });

    await page.click('#analyzeWithLlmBtn');

    const detail = await page.evaluate(() => window.__improveDetail);
    expect(detail).toBeTruthy();
    expect(detail.promptName).toBe('default_chat');
    expect(detail.promptVersion).toBe(1);
  });
});
