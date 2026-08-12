/**
 * Playwright E2E Tests for Onboarding Wizard Component
 *
 * Tests the complete user journey through the onboarding wizard including:
 * - Auto-trigger on first visit
 * - Manual trigger
 * - Navigation through all steps
 * - Form validation
 * - Skip functionality
 * - Prompt creation
 * - localStorage persistence
 */

const { test, expect } = require('@playwright/test');

// Base URL for testing
const BASE_URL = process.env.BASE_URL || 'http://localhost:3080';

// Test data
const TEST_PROMPT = {
  name: 'test_onboarding_prompt',
  description: 'A test prompt created via onboarding wizard',
  systemPrompt: 'You are a helpful AI assistant for testing purposes. Be concise and friendly.'
};

/**
 * Helper function to clear localStorage and reset onboarding state
 */
async function resetOnboarding(page) {
  await page.evaluate(() => {
    localStorage.removeItem('agentx_onboarding_completed');
  });
}

/**
 * Helper function to check if onboarding is marked as completed
 */
async function isOnboardingCompleted(page) {
  return await page.evaluate(() => {
    return localStorage.getItem('agentx_onboarding_completed') === 'true';
  });
}

/**
 * Helper function to wait for onboarding modal to appear
 */
async function waitForOnboardingModal(page, timeout = 5000) {
  await page.waitForSelector('.onboarding-overlay', { timeout });
}

/**
 * Helper function to check if onboarding modal is visible
 */
async function isOnboardingVisible(page) {
  const modal = await page.$('.onboarding-overlay');
  return modal !== null;
}

test.describe('Onboarding Wizard E2E Tests', () => {

  test.beforeEach(async ({ page }) => {
    // Mock authentication to bypass login
    await page.route('**/api/auth/me', (route) => {
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          userId: 'test-user-123',
          username: 'testuser',
          email: 'test@example.com'
        })
      });
    });

    // Mock prompts API to return empty array (simulating first-time user)
    await page.route('**/api/prompts', (route) => {
      if (route.request().method() === 'GET') {
        route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            status: 'success',
            data: {} // Empty prompts object
          })
        });
      } else {
        route.continue();
      }
    });
  });

  test('Test 1: Auto-trigger on first visit (clear localStorage first)', async ({ page }) => {
    // Reset onboarding state
    await page.goto(`${BASE_URL}/prompts.html`);
    await resetOnboarding(page);

    // Verify localStorage is cleared
    const isCompleted = await isOnboardingCompleted(page);
    expect(isCompleted).toBe(false);

    // Reload page to trigger auto-onboarding
    await page.reload();

    // Wait for page to load and onboarding to appear
    await page.waitForLoadState('networkidle');

    // Wait for onboarding modal to appear (500ms delay + buffer)
    await waitForOnboardingModal(page, 2000);

    // Verify onboarding modal is visible
    const modalVisible = await isOnboardingVisible(page);
    expect(modalVisible).toBe(true);

    // Verify we're on step 1
    const stepNumber = await page.textContent('#currentStepNum');
    expect(stepNumber).toBe('1');

    // Verify welcome message
    await expect(page.locator('.step-welcome h3')).toContainText('Welcome to Prompt Management!');

    // Verify feature list is present
    await expect(page.locator('.feature-list')).toBeVisible();

    console.log('✓ Test 1 passed: Onboarding auto-triggered on first visit');
  });

  test('Test 2: Manual trigger via "Show Tutorial" button', async ({ page }) => {
    await page.goto(`${BASE_URL}/prompts.html`);

    // Mark onboarding as completed to prevent auto-trigger
    await page.evaluate(() => {
      localStorage.setItem('agentx_onboarding_completed', 'true');
    });

    await page.reload();
    await page.waitForLoadState('networkidle');

    // Verify onboarding doesn't auto-appear
    await page.waitForTimeout(1000);
    let modalVisible = await isOnboardingVisible(page);
    expect(modalVisible).toBe(false);

    // Click "Show Tutorial" button
    await page.click('#showOnboardingBtn');

    // Wait for modal to appear
    await waitForOnboardingModal(page);

    // Verify onboarding modal is now visible
    modalVisible = await isOnboardingVisible(page);
    expect(modalVisible).toBe(true);

    // Verify we start at step 1
    const stepNumber = await page.textContent('#currentStepNum');
    expect(stepNumber).toBe('1');

    console.log('✓ Test 2 passed: Manual trigger via Show Tutorial button works');
  });

  test('Test 3: All 5 steps navigation (Previous/Next buttons)', async ({ page }) => {
    await page.goto(`${BASE_URL}/prompts.html`);
    await resetOnboarding(page);
    await page.reload();
    await page.waitForLoadState('networkidle');
    await waitForOnboardingModal(page, 2000);

    // Step 1 - Welcome
    let stepNum = await page.textContent('#currentStepNum');
    expect(stepNum).toBe('1');
    await expect(page.locator('.step-welcome')).toBeVisible();

    // Previous button should not exist on step 1
    const prevBtnStep1 = await page.$('#onboardingPrev');
    expect(prevBtnStep1).toBeNull();

    // Click Next to go to step 2
    await page.click('#onboardingNext');

    // Step 2 - Create Prompt
    stepNum = await page.textContent('#currentStepNum');
    expect(stepNum).toBe('2');
    await expect(page.locator('.step-create')).toBeVisible();
    await expect(page.locator('#wizardPromptName')).toBeVisible();
    await expect(page.locator('#wizardSystemPrompt')).toBeVisible();

    // Fill in form fields (required for validation)
    await page.fill('#wizardPromptName', TEST_PROMPT.name);
    await page.fill('#wizardDescription', TEST_PROMPT.description);
    await page.fill('#wizardSystemPrompt', TEST_PROMPT.systemPrompt);

    // Click Next to go to step 3
    await page.click('#onboardingNext');

    // Step 3 - Variables
    stepNum = await page.textContent('#currentStepNum');
    expect(stepNum).toBe('3');
    await expect(page.locator('.step-variables')).toBeVisible();
    await expect(page.locator('.variables-examples')).toBeVisible();

    // Click Next to go to step 4
    await page.click('#onboardingNext');

    // Step 4 - Activation
    stepNum = await page.textContent('#currentStepNum');
    expect(stepNum).toBe('4');
    await expect(page.locator('.step-activation')).toBeVisible();
    await expect(page.locator('#wizardIsActive')).toBeVisible();
    await expect(page.locator('#wizardTrafficWeight')).toBeVisible();

    // Mock the prompt creation API for step 4 -> 5 transition
    await page.route('**/api/prompts', (route) => {
      if (route.request().method() === 'POST') {
        route.fulfill({
          status: 201,
          contentType: 'application/json',
          body: JSON.stringify({
            status: 'success',
            data: {
              _id: 'test-prompt-id',
              name: TEST_PROMPT.name,
              version: 1
            }
          })
        });
      } else {
        route.continue();
      }
    });

    // Click Next to create prompt and go to step 5
    await page.click('#onboardingNext');

    // Wait for API call and navigation
    await page.waitForTimeout(1000);

    // Step 5 - Complete
    stepNum = await page.textContent('#currentStepNum');
    expect(stepNum).toBe('5');
    await expect(page.locator('.step-complete')).toBeVisible();

    // Test Previous button - go back to step 4
    await page.click('#onboardingPrev');
    stepNum = await page.textContent('#currentStepNum');
    expect(stepNum).toBe('4');

    // Go back to step 3
    await page.click('#onboardingPrev');
    stepNum = await page.textContent('#currentStepNum');
    expect(stepNum).toBe('3');

    // Go back to step 2
    await page.click('#onboardingPrev');
    stepNum = await page.textContent('#currentStepNum');
    expect(stepNum).toBe('2');

    // Go back to step 1
    await page.click('#onboardingPrev');
    stepNum = await page.textContent('#currentStepNum');
    expect(stepNum).toBe('1');

    console.log('✓ Test 3 passed: Navigation through all 5 steps works correctly');
  });

  test('Test 4: Form validation on Step 2', async ({ page }) => {
    await page.goto(`${BASE_URL}/prompts.html`);
    await resetOnboarding(page);
    await page.reload();
    await page.waitForLoadState('networkidle');
    await waitForOnboardingModal(page, 2000);

    // Navigate to step 2
    await page.click('#onboardingNext');
    await expect(page.locator('.step-create')).toBeVisible();

    // Test 4a: Empty name validation
    await page.fill('#wizardPromptName', '');
    await page.fill('#wizardSystemPrompt', 'Some prompt text');
    await page.click('#onboardingNext');

    // Should show error and stay on step 2
    await expect(page.locator('#wizardError')).toBeVisible();
    let errorText = await page.textContent('#wizardErrorText');
    expect(errorText).toContain('name is required');

    let stepNum = await page.textContent('#currentStepNum');
    expect(stepNum).toBe('2');

    // Test 4b: Invalid name format (uppercase letters)
    await page.fill('#wizardPromptName', 'InvalidName');
    await page.click('#onboardingNext');

    await expect(page.locator('#wizardError')).toBeVisible();
    errorText = await page.textContent('#wizardErrorText');
    expect(errorText).toContain('lowercase with underscores');

    stepNum = await page.textContent('#currentStepNum');
    expect(stepNum).toBe('2');

    // Test 4c: Invalid name format (spaces)
    await page.fill('#wizardPromptName', 'invalid name');
    await page.click('#onboardingNext');

    await expect(page.locator('#wizardError')).toBeVisible();
    errorText = await page.textContent('#wizardErrorText');
    expect(errorText).toContain('lowercase with underscores');

    // Test 4d: Empty system prompt
    await page.fill('#wizardPromptName', 'valid_name');
    await page.fill('#wizardSystemPrompt', '');
    await page.click('#onboardingNext');

    await expect(page.locator('#wizardError')).toBeVisible();
    errorText = await page.textContent('#wizardErrorText');
    expect(errorText).toContain('System prompt is required');

    // Test 4e: System prompt too short
    await page.fill('#wizardSystemPrompt', 'Short');
    await page.click('#onboardingNext');

    await expect(page.locator('#wizardError')).toBeVisible();
    errorText = await page.textContent('#wizardErrorText');
    expect(errorText).toContain('at least 10 characters');

    // Test 4f: Valid form submission
    await page.fill('#wizardPromptName', TEST_PROMPT.name);
    await page.fill('#wizardSystemPrompt', TEST_PROMPT.systemPrompt);
    await page.click('#onboardingNext');

    // Should advance to step 3
    await page.waitForTimeout(500);
    stepNum = await page.textContent('#currentStepNum');
    expect(stepNum).toBe('3');

    console.log('✓ Test 4 passed: Form validation works correctly');
  });

  test('Test 5: Skip button with confirmation', async ({ page }) => {
    await page.goto(`${BASE_URL}/prompts.html`);
    await resetOnboarding(page);
    await page.reload();
    await page.waitForLoadState('networkidle');
    await waitForOnboardingModal(page, 2000);

    // Verify modal is visible
    let modalVisible = await isOnboardingVisible(page);
    expect(modalVisible).toBe(true);

    // Test 5a: Cancel skip confirmation
    page.on('dialog', async (dialog) => {
      expect(dialog.type()).toBe('confirm');
      expect(dialog.message()).toContain('skip the tutorial');
      await dialog.dismiss(); // Click Cancel
    });

    await page.click('#onboardingSkipBtn');
    await page.waitForTimeout(500);

    // Modal should still be visible after canceling
    modalVisible = await isOnboardingVisible(page);
    expect(modalVisible).toBe(true);

    // Test 5b: Confirm skip
    page.removeAllListeners('dialog');
    page.on('dialog', async (dialog) => {
      expect(dialog.type()).toBe('confirm');
      await dialog.accept(); // Click OK
    });

    await page.click('#onboardingSkipBtn');
    await page.waitForTimeout(500);

    // Modal should be closed after confirming
    modalVisible = await isOnboardingVisible(page);
    expect(modalVisible).toBe(false);

    // Test 5c: Skip from header close button
    // Reopen wizard
    await page.click('#showOnboardingBtn');
    await waitForOnboardingModal(page);

    page.removeAllListeners('dialog');
    page.on('dialog', async (dialog) => {
      await dialog.accept();
    });

    await page.click('#onboardingSkip');
    await page.waitForTimeout(500);

    modalVisible = await isOnboardingVisible(page);
    expect(modalVisible).toBe(false);

    console.log('✓ Test 5 passed: Skip button with confirmation works');
  });

  test('Test 6: Successful prompt creation', async ({ page }) => {
    await page.goto(`${BASE_URL}/prompts.html`);
    await resetOnboarding(page);

    // Mock the prompt creation API
    let promptCreated = false;
    await page.route('**/api/prompts', (route) => {
      if (route.request().method() === 'POST') {
        const postData = route.request().postDataJSON();

        // Verify the payload
        expect(postData.name).toBe(TEST_PROMPT.name);
        expect(postData.description).toBe(TEST_PROMPT.description);
        expect(postData.systemPrompt).toBe(TEST_PROMPT.systemPrompt);
        expect(typeof postData.isActive).toBe('boolean');
        expect(postData.trafficWeight).toBeGreaterThanOrEqual(1);
        expect(postData.trafficWeight).toBeLessThanOrEqual(100);

        promptCreated = true;

        route.fulfill({
          status: 201,
          contentType: 'application/json',
          body: JSON.stringify({
            status: 'success',
            data: {
              _id: 'test-prompt-id-123',
              name: postData.name,
              version: 1,
              description: postData.description,
              systemPrompt: postData.systemPrompt,
              isActive: postData.isActive,
              trafficWeight: postData.trafficWeight
            }
          })
        });
      } else {
        route.continue();
      }
    });

    await page.reload();
    await page.waitForLoadState('networkidle');
    await waitForOnboardingModal(page, 2000);

    // Navigate through wizard and fill form
    await page.click('#onboardingNext'); // Go to step 2

    await page.fill('#wizardPromptName', TEST_PROMPT.name);
    await page.fill('#wizardDescription', TEST_PROMPT.description);
    await page.fill('#wizardSystemPrompt', TEST_PROMPT.systemPrompt);

    await page.click('#onboardingNext'); // Go to step 3
    await page.click('#onboardingNext'); // Go to step 4

    // Configure activation settings
    await page.check('#wizardIsActive');
    await page.fill('#wizardTrafficWeightNum', '75');

    // Click Next to trigger prompt creation
    const nextButton = page.locator('#onboardingNext');
    await expect(nextButton).toBeVisible();

    await nextButton.click();

    // Wait for API call to complete
    await page.waitForTimeout(1500);

    // Verify prompt was created
    expect(promptCreated).toBe(true);

    // Should be on step 5 (completion)
    const stepNum = await page.textContent('#currentStepNum');
    expect(stepNum).toBe('5');

    // Verify completion message
    await expect(page.locator('.step-complete')).toBeVisible();
    await expect(page.locator('.step-complete h3')).toContainText("You're All Set!");

    // Verify next steps section is visible
    await expect(page.locator('.next-steps')).toBeVisible();

    console.log('✓ Test 6 passed: Prompt creation successful');
  });

  test('Test 7: localStorage persistence check', async ({ page }) => {
    await page.goto(`${BASE_URL}/prompts.html`);

    // Test 7a: Initial state - not completed
    await resetOnboarding(page);
    let isCompleted = await isOnboardingCompleted(page);
    expect(isCompleted).toBe(false);

    // Test 7b: Mark as completed
    await page.evaluate(() => {
      localStorage.setItem('agentx_onboarding_completed', 'true');
    });

    isCompleted = await isOnboardingCompleted(page);
    expect(isCompleted).toBe(true);

    // Test 7c: Persist across page reloads
    await page.reload();
    await page.waitForLoadState('networkidle');

    isCompleted = await isOnboardingCompleted(page);
    expect(isCompleted).toBe(true);

    // Test 7d: Verify onboarding doesn't auto-show when completed
    await page.waitForTimeout(1000);
    const modalVisible = await isOnboardingVisible(page);
    expect(modalVisible).toBe(false);

    // Test 7e: Reset functionality
    await resetOnboarding(page);
    isCompleted = await isOnboardingCompleted(page);
    expect(isCompleted).toBe(false);

    console.log('✓ Test 7 passed: localStorage persistence works correctly');
  });

  test('Test 8: "Don\'t show again" checkbox', async ({ page }) => {
    await page.goto(`${BASE_URL}/prompts.html`);
    await resetOnboarding(page);

    // Mock prompt creation API
    await page.route('**/api/prompts', (route) => {
      if (route.request().method() === 'POST') {
        route.fulfill({
          status: 201,
          contentType: 'application/json',
          body: JSON.stringify({
            status: 'success',
            data: { _id: 'test-id', name: TEST_PROMPT.name, version: 1 }
          })
        });
      } else {
        route.continue();
      }
    });

    await page.reload();
    await page.waitForLoadState('networkidle');
    await waitForOnboardingModal(page, 2000);

    // Navigate through all steps to completion
    await page.click('#onboardingNext'); // Step 2

    await page.fill('#wizardPromptName', TEST_PROMPT.name);
    await page.fill('#wizardSystemPrompt', TEST_PROMPT.systemPrompt);

    await page.click('#onboardingNext'); // Step 3
    await page.click('#onboardingNext'); // Step 4
    await page.click('#onboardingNext'); // Step 5 (creates prompt)

    await page.waitForTimeout(1000);

    // Should be on step 5
    const stepNum = await page.textContent('#currentStepNum');
    expect(stepNum).toBe('5');

    // Test 8a: Finish WITHOUT checking "don't show again"
    const dontShowCheckbox = page.locator('#wizardDontShowAgain');
    await expect(dontShowCheckbox).toBeVisible();

    // Verify it's not checked by default
    const isChecked = await dontShowCheckbox.isChecked();
    expect(isChecked).toBe(false);

    // Finish without checking
    await page.click('#onboardingFinish');
    await page.waitForTimeout(500);

    // Onboarding should NOT be marked as completed
    let isCompleted = await isOnboardingCompleted(page);
    expect(isCompleted).toBe(false);

    // Test 8b: Finish WITH "don't show again" checked
    // Reopen wizard
    await page.click('#showOnboardingBtn');
    await waitForOnboardingModal(page);

    // Navigate to step 5 quickly
    await page.click('#onboardingNext'); // Step 2
    await page.fill('#wizardPromptName', 'another_test');
    await page.fill('#wizardSystemPrompt', 'Another test prompt.');
    await page.click('#onboardingNext'); // Step 3
    await page.click('#onboardingNext'); // Step 4
    await page.click('#onboardingNext'); // Step 5
    await page.waitForTimeout(1000);

    // Check the "don't show again" checkbox
    await dontShowCheckbox.check();
    const isNowChecked = await dontShowCheckbox.isChecked();
    expect(isNowChecked).toBe(true);

    // Finish
    await page.click('#onboardingFinish');
    await page.waitForTimeout(500);

    // Onboarding should now be marked as completed
    isCompleted = await isOnboardingCompleted(page);
    expect(isCompleted).toBe(true);

    // Test 8c: Verify it doesn't auto-show after being marked complete
    await page.reload();
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(1000);

    const modalVisible = await isOnboardingVisible(page);
    expect(modalVisible).toBe(false);

    console.log('✓ Test 8 passed: "Don\'t show again" checkbox works correctly');
  });

  test('Test 9: Step 4 slider and number input synchronization', async ({ page }) => {
    await page.goto(`${BASE_URL}/prompts.html`);
    await resetOnboarding(page);
    await page.reload();
    await page.waitForLoadState('networkidle');
    await waitForOnboardingModal(page, 2000);

    // Navigate to step 4
    await page.click('#onboardingNext'); // Step 2
    await page.fill('#wizardPromptName', TEST_PROMPT.name);
    await page.fill('#wizardSystemPrompt', TEST_PROMPT.systemPrompt);
    await page.click('#onboardingNext'); // Step 3
    await page.click('#onboardingNext'); // Step 4

    // Test slider -> number input sync
    const slider = page.locator('#wizardTrafficWeight');
    const numberInput = page.locator('#wizardTrafficWeightNum');

    // Change slider value
    await slider.fill('50');
    await page.waitForTimeout(100);

    let numValue = await numberInput.inputValue();
    expect(numValue).toBe('50');

    // Change number input value
    await numberInput.fill('75');
    await page.waitForTimeout(100);

    let sliderValue = await slider.inputValue();
    expect(sliderValue).toBe('75');

    // Test boundary values
    await numberInput.fill('1');
    await page.waitForTimeout(100);
    sliderValue = await slider.inputValue();
    expect(sliderValue).toBe('1');

    await numberInput.fill('100');
    await page.waitForTimeout(100);
    sliderValue = await slider.inputValue();
    expect(sliderValue).toBe('100');

    console.log('✓ Test 9 passed: Slider and number input synchronization works');
  });

  test('Test 10: Progress bar visual update', async ({ page }) => {
    await page.goto(`${BASE_URL}/prompts.html`);
    await resetOnboarding(page);
    await page.reload();
    await page.waitForLoadState('networkidle');
    await waitForOnboardingModal(page, 2000);

    const progressBar = page.locator('#onboardingProgress');

    // Step 1 - 20% progress
    let width = await progressBar.evaluate(el => el.style.width);
    expect(width).toBe('20%');

    // Step 2 - 40% progress
    await page.click('#onboardingNext');
    await page.fill('#wizardPromptName', TEST_PROMPT.name);
    await page.fill('#wizardSystemPrompt', TEST_PROMPT.systemPrompt);
    width = await progressBar.evaluate(el => el.style.width);
    expect(width).toBe('40%');

    // Step 3 - 60% progress
    await page.click('#onboardingNext');
    width = await progressBar.evaluate(el => el.style.width);
    expect(width).toBe('60%');

    // Step 4 - 80% progress
    await page.click('#onboardingNext');
    width = await progressBar.evaluate(el => el.style.width);
    expect(width).toBe('80%');

    // Mock API for step 5
    await page.route('**/api/prompts', (route) => {
      if (route.request().method() === 'POST') {
        route.fulfill({
          status: 201,
          contentType: 'application/json',
          body: JSON.stringify({ status: 'success', data: { _id: 'test-id', name: TEST_PROMPT.name, version: 1 } })
        });
      } else {
        route.continue();
      }
    });

    // Step 5 - 100% progress
    await page.click('#onboardingNext');
    await page.waitForTimeout(1000);
    width = await progressBar.evaluate(el => el.style.width);
    expect(width).toBe('100%');

    console.log('✓ Test 10 passed: Progress bar updates correctly');
  });

});
