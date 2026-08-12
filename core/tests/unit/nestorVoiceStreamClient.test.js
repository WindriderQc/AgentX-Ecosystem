'use strict';

const {
  createParser,
  summarizeAudioEvents,
  streamNestorTurn,
  SentenceAudioQueue
} = require('../../public/js/nestor-voice-stream');

describe('Nestor voice streaming client', () => {
  const flush = () => new Promise((resolve) => setImmediate(resolve));

  test('parses split SSE frames and returns the done payload', async () => {
    const encoder = new TextEncoder();
    const chunks = [
      'event: meta\r\ndata: {"conversationId":"conv',
      '-1"}\r\n\r\nevent: delta\r\ndata: {"delta":"Bonjour"}\r\n\r\n',
      'event: done\r\ndata: {"reply":"Bonjour","conversationId":"conv-1"}\r\n\r\n'
    ].map((chunk) => encoder.encode(chunk));
    const fetchImpl = jest.fn().mockResolvedValue({
      ok: true,
      body: {
        getReader: () => ({
          read: async () => chunks.length
            ? { value: chunks.shift(), done: false }
            : { value: undefined, done: true },
          cancel: async () => {}
        })
      }
    });
    const seen = [];

    const result = await streamNestorTurn(
      { text: 'Allô?' },
      {
        meta: (data) => seen.push(['meta', data.conversationId]),
        delta: (data) => seen.push(['delta', data.delta])
      },
      { fetchImpl }
    );

    expect(result).toEqual({ reply: 'Bonjour', conversationId: 'conv-1' });
    expect(seen).toEqual([['meta', 'conv-1'], ['delta', 'Bonjour']]);
  });

  test('prefetches exactly one sentence while preserving playback order', async () => {
    const audio = new EventTarget();
    audio.style = {};
    audio.pause = jest.fn();
    audio.play = jest.fn(async () => {});
    const synthesize = jest.fn(async (text, options) => ({ text, signal: options.signal }));
    const firstAudio = jest.fn();
    const events = [];
    const createObjectURL = jest.fn((blob) => `blob:${blob.text}`);
    const revokeObjectURL = jest.fn();
    let resolveIdle;
    const idle = new Promise((resolve) => { resolveIdle = resolve; });
    let clock = 100;
    const queue = new SentenceAudioQueue({
      audio,
      synthesize,
      createObjectURL,
      revokeObjectURL,
      startedAt: 0,
      now: () => ++clock,
      onFirstAudio: firstAudio,
      onEvent: (event) => events.push(event),
      onIdle: resolveIdle
    });

    queue.enqueue('Première phrase.');
    queue.enqueue('Deuxième phrase.');
    queue.enqueue('Troisième phrase.');
    await flush();

    expect(audio.play).toHaveBeenCalledTimes(1);
    expect(synthesize.mock.calls.map(([text]) => text)).toEqual([
      'Première phrase.',
      'Deuxième phrase.'
    ]);

    audio.dispatchEvent(new Event('ended'));
    await flush();
    expect(audio.play).toHaveBeenCalledTimes(2);
    expect(synthesize.mock.calls.map(([text]) => text)).toEqual([
      'Première phrase.',
      'Deuxième phrase.',
      'Troisième phrase.'
    ]);

    audio.dispatchEvent(new Event('ended'));
    await flush();
    expect(audio.play).toHaveBeenCalledTimes(3);
    audio.dispatchEvent(new Event('ended'));
    await idle;

    expect(synthesize).toHaveBeenCalledTimes(3);
    expect(firstAudio).toHaveBeenCalledTimes(1);
    expect(createObjectURL.mock.calls.map(([blob]) => blob.text)).toEqual([
      'Première phrase.',
      'Deuxième phrase.',
      'Troisième phrase.'
    ]);
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:Première phrase.');
    expect(events.filter(({ type }) => type === 'playback_started')).toHaveLength(3);
    expect(events.filter(({ type }) => type === 'synthesis_started')).toHaveLength(3);
    await expect(queue.waitForIdle()).resolves.toEqual({ cancelled: false });
  });

  test('summarizes audio timings without inventing missing samples', () => {
    expect(summarizeAudioEvents([])).toEqual({
      sentenceCount: 0,
      firstAudioMs: null,
      ttsSynthesisMs: null,
      ttsPlaybackMs: null,
      ttsRtf: null,
      interSentenceGapMs: null
    });
    expect(summarizeAudioEvents([
      { type: 'synthesis_ended', synthesisMs: 120 },
      { type: 'playback_started', elapsedMs: 1000, gapMs: null },
      { type: 'playback_ended', playbackMs: 600 },
      { type: 'synthesis_ended', synthesisMs: 80 },
      { type: 'playback_started', elapsedMs: 1620, gapMs: 20 },
      { type: 'playback_ended', playbackMs: 400 }
    ])).toEqual({
      sentenceCount: 2,
      firstAudioMs: 1000,
      ttsSynthesisMs: 200,
      ttsPlaybackMs: 1000,
      ttsRtf: 0.2,
      interSentenceGapMs: 20
    });
  });

  test('cancel aborts a prefetched synthesis and revokes active audio', async () => {
    const audio = new EventTarget();
    audio.style = {};
    audio.pause = jest.fn();
    audio.removeAttribute = jest.fn();
    audio.load = jest.fn();
    audio.play = jest.fn(async () => {});
    const events = [];
    const synthesize = jest.fn(async (text, { signal }) => {
      if (text === 'Première phrase.') return { text };
      return new Promise((resolve, reject) => {
        signal.addEventListener('abort', () => {
          const error = new Error('aborted');
          error.name = 'AbortError';
          reject(error);
        }, { once: true });
      });
    });
    let resolveIdle;
    const idle = new Promise((resolve) => { resolveIdle = resolve; });
    const revokeObjectURL = jest.fn();
    const queue = new SentenceAudioQueue({
      audio,
      synthesize,
      createObjectURL: (blob) => `blob:${blob.text}`,
      revokeObjectURL,
      onEvent: (event) => events.push(event),
      onIdle: resolveIdle
    });

    queue.enqueue('Première phrase.');
    queue.enqueue('Deuxième phrase.');
    await flush();
    const prefetchSignal = synthesize.mock.calls[1][1].signal;

    queue.cancel('new-turn');
    await idle;

    expect(prefetchSignal.aborted).toBe(true);
    expect(audio.pause).toHaveBeenCalledTimes(1);
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:Première phrase.');
    expect(events).toContainEqual(expect.objectContaining({
      type: 'cancelled',
      reason: 'new-turn'
    }));
  });

  test('rejects additional sentences when bounded queue limits are reached', async () => {
    const audio = new EventTarget();
    audio.style = {};
    audio.pause = jest.fn();
    audio.play = jest.fn(async () => {});
    const errors = [];
    const synthesize = jest.fn((text, { signal }) => new Promise((resolve, reject) => {
      signal.addEventListener('abort', () => {
        const error = new Error('aborted');
        error.name = 'AbortError';
        reject(error);
      }, { once: true });
    }));
    let resolveIdle;
    const idle = new Promise((resolve) => { resolveIdle = resolve; });
    const queue = new SentenceAudioQueue({
      audio,
      synthesize,
      maxPendingSentences: 2,
      maxQueuedChars: 100,
      onError: (error) => errors.push(error),
      onIdle: resolveIdle
    });

    expect(queue.enqueue('Une.')).toBe(true);
    expect(queue.enqueue('Deux.')).toBe(true);
    expect(queue.enqueue('Trois.')).toBe(false);
    expect(errors).toHaveLength(1);
    expect(errors[0].code).toBe('VOICE_QUEUE_LIMIT');

    queue.cancel('test-finished');
    await idle;
  });

  test('retains an incomplete frame until the next parser chunk', () => {
    const frames = [];
    const parser = createParser((frame) => frames.push(frame));
    parser.push('event: delta\ndata: {"delta":"A', false);
    expect(frames).toEqual([]);
    parser.push('"}\n\n', false);
    expect(frames).toEqual([{ event: 'delta', data: { delta: 'A' } }]);
  });
});
