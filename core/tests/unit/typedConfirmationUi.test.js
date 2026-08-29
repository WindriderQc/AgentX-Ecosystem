'use strict';

const fs = require('fs');
const path = require('path');

const sourcePath = path.join(__dirname, '../../public/js/utils/typed-confirmation.js');

describe('shared typed-confirmation UI', () => {
  afterEach(() => {
    delete global.AgentXTypedConfirmation;
    jest.resetModules();
  });

  test('builds the same stable phrases and header as the Core API helper', () => {
    const confirmation = require(sourcePath);
    expect(confirmation.phrase('DELETE  MODEL', ' llama\n3:8b ')).toBe('DELETE MODEL llama 3:8b');
    expect(confirmation.headers('DELETE MODEL llama3:8b')).toEqual({
      'X-AgentX-Confirm': 'DELETE MODEL llama3:8b'
    });
  });

  test('ships an accessible exact-match modal contract', () => {
    const source = fs.readFileSync(sourcePath, 'utf8');
    expect(source).toContain("dialog.setAttribute('aria-labelledby', 'agentxConfirmTitle')");
    expect(source).toContain("dialog.setAttribute('aria-describedby', 'agentxConfirmDescription agentxConfirmInstruction')");
    expect(source).toContain("input.value === dialog.dataset.expected");
    expect(source).toContain("dialog.addEventListener('cancel'");
    expect(source).toContain('function resolveReturnFocus(activeElement)');
    expect(source).toContain("querySelector?.('[aria-haspopup=\"menu\"], .btn-actions')");
    expect(source).toContain('if (focusTarget?.isConnected !== false) focusTarget?.focus?.()');
    expect(source).not.toContain('innerHTML = config.');
  });
});
