'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const messagingPath = path.resolve(__dirname, '../../public/js/chat/chat-messaging.js');
const mainPath = path.resolve(__dirname, '../../public/js/chat/chat-main.js');
const source = fs.readFileSync(messagingPath, 'utf8');
const mainSource = fs.readFileSync(mainPath, 'utf8');

function loadTurnHelpers() {
  const start = source.indexOf('function messageIdOf');
  const end = source.indexOf('\nfunction safeExternalUrl', start);
  if (start < 0 || end < 0) throw new Error('turn resolver source not found');

  const helperSource = source.slice(start, end).replace(/export function/g, 'function');
  const context = {};
  vm.createContext(context);
  vm.runInContext(
    `${helperSource}\nthis.userTurnForAssistant = userTurnForAssistant; this.turnActionForRequest = turnActionForRequest;`,
    context
  );
  return context;
}

describe('Playground exact turn actions', () => {
  const { userTurnForAssistant, turnActionForRequest } = loadTurnHelpers();

  test('an older assistant targets its paired user id when prompt text is duplicated later', () => {
    const history = [
      { role: 'user', content: 'Same prompt', id: 'u-older' },
      { role: 'assistant', content: 'Older answer', id: 'a-older' },
      { role: 'user', content: 'Same prompt', id: 'u-newer' },
      { role: 'assistant', content: 'Newer answer', id: 'a-newer' },
    ];

    expect(userTurnForAssistant(history, { role: 'assistant', id: 'a-older' }).id)
      .toBe('u-older');
    expect(userTurnForAssistant(history, { role: 'assistant', id: 'a-newer' }).id)
      .toBe('u-newer');
  });

  test('a failed attempt retries its explicit user id rather than any same-text turn', () => {
    const history = [
      { role: 'user', content: 'Same prompt', id: 'u-failed' },
      { role: 'user', content: 'Same prompt', id: 'u-later' },
    ];
    const failedAttempt = {
      role: 'assistant',
      content: 'Request failed',
      retryUserMessageId: 'u-failed'
    };

    expect(userTurnForAssistant(history, failedAttempt).id).toBe('u-failed');
  });

  test('fails closed when assistant identity cannot be tied to a user turn', () => {
    const history = [{ role: 'user', content: 'Question', id: 'u-1' }];
    expect(userTurnForAssistant(history, { role: 'assistant', id: 'a-missing' })).toBeNull();
  });

  test('labels persisted replies honestly as Ask again and ephemeral failures as Retry', () => {
    expect(source).toContain("const actionLabel = isRetry ? 'Retry' : 'Ask again';");
    expect(source).toContain("turnActionBtn.dataset.turnAction = isRetry ? 'retry' : 'ask-again';");
    expect(source).not.toContain("title = 'Regenerate'");
    expect(source).not.toMatch(/reverse\(\)\.find\([^)]*role === 'user'/);
  });

  test('Retry reuses its exact user turn while Ask again appends an honest new turn', () => {
    expect(source).toMatch(/const userMessage = isRetry\s*\? sourceUserMessage\s*:\s*\{ role: 'user'/);
    expect(source).toContain('if (!isRetry) helpers.appendMessage(userMessage);');
    expect(source).toContain('retryUserMessageId: currentUserMessageId');
    expect(source).toContain('sourceUserMessageId: currentUserMessageId');
  });

  test('turn actions bypass the composer and are forwarded as structured identity', () => {
    expect(source).toContain('sourceUserMessageId: userMessageId');
    expect(source).not.toContain('elements.messageInput.value = lastUserMsg.content');
    expect(mainSource).toContain(
      'sendMessage: (turnAction) => _sendMessage({ elements, state, defaults, helpers }, turnAction)'
    );
  });

  test('request payload carries exact source ids using the server contract shape', () => {
    const selected = {
      action: 'ask-again',
      sourceUserMessageId: 'u-older',
      sourceAssistantMessageId: 'a-older'
    };

    expect(turnActionForRequest(selected)).toEqual({
      kind: 'ask-again',
      sourceUserMessageId: 'u-older',
      sourceAssistantMessageId: 'a-older'
    });
    expect(turnActionForRequest({
      action: 'retry',
      sourceUserMessageId: 'u-ephemeral',
      sourceAssistantMessageId: null
    })).toEqual({
      kind: 'retry',
      sourceUserMessageId: 'u-ephemeral',
      sourceAssistantMessageId: null
    });
    expect(source).toContain('...(turnAction ? { turnAction } : {})');
    expect(source).toContain('currentUserMessageId, requestTurnAction');
  });
});
