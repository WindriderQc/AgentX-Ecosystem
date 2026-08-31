'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const messagingPath = path.resolve(__dirname, '../../public/js/chat/chat-messaging.js');
const source = fs.readFileSync(messagingPath, 'utf8').replace(/\r\n/g, '\n');
const mainSource = fs.readFileSync(
  path.resolve(__dirname, '../../public/js/chat/chat-main.js'),
  'utf8'
).replace(/\r\n/g, '\n');

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

function loadSendButtonHelpers() {
  const start = source.indexOf('export function handleSendButtonAction');
  const end = source.indexOf('\n\n/**', start);
  if (start < 0 || end < 0) throw new Error('send button helpers source not found');
  const helperSource = source.slice(start, end).replace(/export function/g, 'function');
  const context = {};
  vm.createContext(context);
  vm.runInContext(
    `${helperSource}\nthis.handleSendButtonAction = handleSendButtonAction;\nthis.isUserRequestedStreamStop = isUserRequestedStreamStop;`,
    context
  );
  return context;
}

describe('Playground request history contract', () => {
  const historyBeforeCurrentTurn = loadHistoryHelper();
  const { handleSendButtonAction, isUserRequestedStreamStop } = loadSendButtonHelpers();

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

  test('uses one stable click handler for consecutive sends', () => {
    let sendCount = 0;
    const ctx = {
      elements: { sendBtn: {}, feedback: {} },
      state: { streamAbortController: null, streamStopRequestedController: null },
      helpers: {
        sendMessage: () => { sendCount += 1; },
        setFeedback: jest.fn()
      }
    };

    expect(handleSendButtonAction(ctx)).toBe('send');
    expect(handleSendButtonAction(ctx)).toBe('send');
    expect(sendCount).toBe(2);
    expect(mainSource).toContain("sendBtn.addEventListener('click', () => handleSendButtonAction");
    expect(source).not.toContain('sendBtn.onclick');
  });

  test('stops only the active stream and records explicit user intent', () => {
    const controller = { abort: jest.fn() };
    const ctx = {
      elements: { sendBtn: { disabled: false, textContent: 'Stop' } },
      state: { streamAbortController: controller, streamStopRequestedController: null },
      helpers: { sendMessage: jest.fn(), setFeedback: jest.fn() }
    };

    expect(handleSendButtonAction(ctx)).toBe('stop');
    expect(controller.abort).toHaveBeenCalledTimes(1);
    expect(ctx.helpers.sendMessage).not.toHaveBeenCalled();
    expect(ctx.state.streamStopRequestedController).toBe(controller);
    expect(ctx.elements.sendBtn.disabled).toBe(true);
  });

  test('does not mislabel an unrelated AbortError as a user stop', () => {
    const activeController = {};
    const unrelatedController = {};
    const abortError = { name: 'AbortError' };

    expect(isUserRequestedStreamStop(abortError, {
      streamStopRequestedController: activeController
    }, activeController)).toBe(true);
    expect(isUserRequestedStreamStop(abortError, {
      streamStopRequestedController: unrelatedController
    }, activeController)).toBe(false);
    expect(isUserRequestedStreamStop(new Error('network failure'), {
      streamStopRequestedController: activeController
    }, activeController)).toBe(false);
  });
});
