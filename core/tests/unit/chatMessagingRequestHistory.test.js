'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const messagingPath = path.resolve(__dirname, '../../public/js/chat/chat-messaging.js');
const source = fs.readFileSync(messagingPath, 'utf8').replace(/\r\n/g, '\n');

function loadHistoryHelper() {
  const idStart = source.indexOf('function messageIdOf');
  const idEnd = source.indexOf('\n}\n\n/**', idStart);
  const start = source.indexOf('export function historyBeforeCurrentTurn');
  const end = source.indexOf('\n}\n\nfunction buildPayload', start);
  if (idStart < 0 || idEnd < 0 || start < 0 || end < 0) {
    throw new Error('historyBeforeCurrentTurn source not found');
  }
  const idSource = source.slice(idStart, idEnd + 2);
  const helperSource = source.slice(start, end + 2).replace('export function', 'function');
  const context = {};
  vm.createContext(context);
  vm.runInContext(`${idSource}\n${helperSource}\nthis.historyBeforeCurrentTurn = historyBeforeCurrentTurn;`, context);
  return context.historyBeforeCurrentTurn;
}

describe('Playground request history contract', () => {
  const historyBeforeCurrentTurn = loadHistoryHelper();

  test('excludes only the exact current user turn already persisted by the UI', () => {
    const history = [
      { role: 'user', content: 'Earlier question', id: 'u-1' },
      { role: 'assistant', content: 'Earlier answer', id: 'a-1' },
      { role: 'user', content: 'Current question', id: 'u-2' },
    ];

    expect(historyBeforeCurrentTurn(history, 'u-2')).toEqual(history.slice(0, -1));
    expect(history).toHaveLength(3);
  });

  test('preserves an intentional repeated prompt from an earlier turn', () => {
    const history = [
      { role: 'user', content: 'Try that again', id: 'u-1' },
      { role: 'assistant', content: 'First attempt', id: 'a-1' },
      { role: 'user', content: 'Try that again', id: 'u-2' },
    ];

    const requestHistory = historyBeforeCurrentTurn(history, 'u-2');
    expect(requestHistory).toHaveLength(2);
    expect(requestHistory[0]).toEqual(history[0]);
  });

  test('does not trim history without an exact current-turn identity', () => {
    const history = [{ role: 'user', content: 'Same text is not enough', id: 'u-1' }];

    expect(historyBeforeCurrentTurn(history, 'u-missing')).toBe(history);
    expect(historyBeforeCurrentTurn(history, null)).toBe(history);
  });

  test('cuts context at an exact older user id instead of matching repeated text', () => {
    const history = [
      { role: 'user', content: 'Repeat this', id: 'u-1' },
      { role: 'assistant', content: 'First answer', id: 'a-1' },
      { role: 'user', content: 'Repeat this', id: 'u-2' },
      { role: 'assistant', content: 'Second answer', id: 'a-2' },
    ];

    expect(historyBeforeCurrentTurn(history, 'u-2')).toEqual(history.slice(0, 2));
    expect(historyBeforeCurrentTurn(history, 'u-1')).toEqual([]);
  });

  test('threads the current-turn id through streaming and non-streaming dispatch', () => {
    expect(source).toContain('sendMessageStreamFetch(ctx, message, model, currentUserMessageId, requestTurnAction)');
    expect(source).toContain('currentUserMessageId,\n        requestTurnAction');
    expect(source).toContain('messages: historyBeforeCurrentTurn(state.history, currentUserMessageId)');
  });

  test('treats the SSE done receipt as success exactly once', () => {
    expect(source).toContain('await reader.cancel().catch(() => {});');
    expect(source).toMatch(/if \(!doneReceived\) \{[\s\S]*retryUserMessageId: currentUserMessageId/);
    expect(source).toContain("throw new Error('The response stream ended before completion.');");
    expect(source).not.toContain('if (doneReceived) { abortController.abort(); }');
  });

  test('keeps stream state owned by the active attempt until abort settles', () => {
    expect(source).toContain('const activeController = state.streamAbortController;');
    expect(source).toContain("elements.sendBtn.textContent = 'Stopping\\u2026';");
    expect(source).toContain('if (state.streamAbortController === requestAbortController)');
    expect(source).not.toMatch(/activeController\.abort\(\);[\s\S]{0,120}state\.sending = false/);
  });
});
