(function (root, factory) {
  const api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.NestorVoiceStream = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, function (root) {
  'use strict';

  function parseFrame(frame) {
    let event = 'message';
    const lines = [];
    String(frame || '').split('\n').forEach((line) => {
      if (!line || line.startsWith(':')) return;
      if (line.startsWith('event:')) event = line.slice(6).trim() || 'message';
      else if (line.startsWith('data:')) lines.push(line.slice(5).trimStart());
    });
    const raw = lines.join('\n');
    if (!raw) return { event, data: null };
    try {
      return { event, data: JSON.parse(raw) };
    } catch {
      return { event, data: raw };
    }
  }

  function createParser(onFrame) {
    let buffer = '';
    return {
      push(chunk, final) {
        buffer += String(chunk || '');
        buffer = buffer.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
        let boundary;
        while ((boundary = buffer.indexOf('\n\n')) !== -1) {
          const frame = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 2);
          if (frame.trim()) onFrame(parseFrame(frame));
        }
        if (final && buffer.trim()) {
          onFrame(parseFrame(buffer));
          buffer = '';
        }
      }
    };
  }

  function percentile(values, fraction) {
    const sorted = values.filter(Number.isFinite).sort((left, right) => left - right);
    if (!sorted.length) return null;
    return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)];
  }

  function summarizeAudioEvents(events) {
    const rows = Array.isArray(events) ? events : [];
    const synthesis = rows.filter((event) => event?.type === 'synthesis_ended');
    const playback = rows.filter((event) => event?.type === 'playback_ended');
    const starts = rows.filter((event) => event?.type === 'playback_started');
    const synthesisMs = synthesis.reduce((sum, event) => sum + (Number(event.synthesisMs) || 0), 0);
    const playbackMs = playback.reduce((sum, event) => sum + (Number(event.playbackMs) || 0), 0);
    const gaps = starts.map((event) => event.gapMs).filter(Number.isFinite);
    return {
      sentenceCount: playback.length,
      firstAudioMs: starts.length && Number.isFinite(Number(starts[0].elapsedMs))
        ? Number(starts[0].elapsedMs)
        : null,
      ttsSynthesisMs: synthesis.length ? synthesisMs : null,
      ttsPlaybackMs: playback.length ? playbackMs : null,
      ttsRtf: playbackMs > 0 ? synthesisMs / playbackMs : null,
      interSentenceGapMs: percentile(gaps, 0.95)
    };
  }

  async function streamNestorTurn(body, handlers = {}, options = {}) {
    const fetchImpl = options.fetchImpl || root.fetch;
    const response = await fetchImpl('/api/nestor/turn/stream', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: options.signal
    });
    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      throw new Error(detail || `Nestor stream failed (${response.status})`);
    }
    if (!response.body?.getReader) throw new Error('Streaming is unavailable in this browser.');

    let completed = null;
    let streamError = null;
    const parser = createParser(({ event, data }) => {
      if (event === 'error') {
        const error = new Error(data?.message || 'Nestor stream failed.');
        error.code = data?.code;
        streamError = error;
        return;
      }
      if (event === 'done') completed = data;
      handlers[event]?.(data);
    });
    const reader = response.body.getReader();
    const decoder = new TextDecoder('utf-8');
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      parser.push(decoder.decode(value, { stream: true }), false);
      if (streamError) {
        await reader.cancel().catch(() => {});
        break;
      }
    }
    parser.push(decoder.decode(), true);
    if (streamError) throw streamError;
    if (!completed) throw new Error('Nestor stream ended before the completion event.');
    return completed;
  }

  class SentenceAudioQueue {
    constructor(options = {}) {
      this.audio = options.audio;
      this.synthesize = options.synthesize;
      this.createObjectURL = options.createObjectURL || ((blob) => root.URL.createObjectURL(blob));
      this.revokeObjectURL = options.revokeObjectURL || ((url) => root.URL.revokeObjectURL(url));
      this.now = options.now || (() => root.performance.now());
      this.startedAt = options.startedAt == null ? this.now() : options.startedAt;
      this.maxPendingSentences = options.maxPendingSentences || 8;
      this.maxQueuedChars = options.maxQueuedChars || 1600;
      this.onFirstAudio = options.onFirstAudio || (() => {});
      this.onError = options.onError || (() => {});
      this.onIdle = options.onIdle || (() => {});
      this.onEvent = options.onEvent || (() => {});
      this.items = [];
      this.bufferedChars = 0;
      this.nextIndex = 0;
      this.running = false;
      this.cancelled = false;
      this.isPlaying = false;
      this.currentItem = null;
      this.currentUrl = '';
      this.currentStop = null;
      this.activeSynthesis = null;
      this.prefetch = null;
      this.lastPlaybackEndedAt = null;
      this.firstAudioReported = false;
      this.idleWaiters = [];
    }

    queueDepth() {
      return this.items.length + (this.currentItem ? 1 : 0);
    }

    emit(type, details = {}) {
      this.onEvent({
        type,
        elapsedMs: this.now() - this.startedAt,
        queueDepth: this.queueDepth(),
        queuedChars: this.bufferedChars,
        ...details
      });
    }

    enqueue(text) {
      const sentence = String(text || '').trim();
      if (!sentence || this.cancelled) return false;
      if (this.queueDepth() >= this.maxPendingSentences
        || this.bufferedChars + sentence.length > this.maxQueuedChars) {
        const error = new Error('Nestor audio queue limit reached.');
        error.code = 'VOICE_QUEUE_LIMIT';
        this.emit('overflow', { rejectedChars: sentence.length });
        this.onError(error);
        return false;
      }

      const item = { text: sentence, index: this.nextIndex++ };
      this.items.push(item);
      this.bufferedChars += sentence.length;
      this.emit('enqueued', { index: item.index });
      if (!this.running) void this.drain();
      else this.startPrefetch();
      return true;
    }

    async prepare(item) {
      const controller = new AbortController();
      const synthesisStartedAt = this.now();
      this.activeSynthesis = { item, controller };
      this.emit('synthesis_started', { index: item.index });
      try {
        const blob = await this.synthesize(item.text, {
          signal: controller.signal,
          index: item.index
        });
        const synthesisMs = this.now() - synthesisStartedAt;
        this.emit('synthesis_ended', { index: item.index, synthesisMs });
        return { blob, synthesisMs };
      } finally {
        if (this.activeSynthesis?.item === item) this.activeSynthesis = null;
      }
    }

    startPrefetch() {
      if (this.cancelled || !this.isPlaying || this.prefetch || this.activeSynthesis) return;
      const item = this.items[0];
      if (!item) return;
      const result = this.prepare(item).then(
        (value) => ({ value }),
        (error) => ({ error })
      );
      this.prefetch = { item, result };
    }

    async takePrepared(item) {
      if (this.prefetch?.item === item) {
        const { result } = this.prefetch;
        this.prefetch = null;
        const prepared = await result;
        if (prepared.error) throw prepared.error;
        return prepared.value;
      }
      return this.prepare(item);
    }

    revokeCurrentUrl() {
      if (!this.currentUrl) return;
      this.revokeObjectURL(this.currentUrl);
      this.currentUrl = '';
    }

    async playPrepared(item, prepared) {
      if (this.cancelled) return;
      this.revokeCurrentUrl();
      this.currentUrl = this.createObjectURL(prepared.blob);
      this.audio.src = this.currentUrl;
      if (this.audio.style) this.audio.style.display = 'block';

      let settled = false;
      let resolvePlayback;
      let rejectPlayback;
      const ended = new Promise((resolve, reject) => {
        resolvePlayback = resolve;
        rejectPlayback = reject;
      });
      const cleanupListeners = () => {
        this.audio.removeEventListener('ended', handleEnded);
        this.audio.removeEventListener('error', handleError);
      };
      const settle = (error) => {
        if (settled) return;
        settled = true;
        cleanupListeners();
        this.currentStop = null;
        if (error) rejectPlayback(error);
        else resolvePlayback();
      };
      const handleEnded = () => settle();
      const handleError = () => settle(new Error('Audio playback failed.'));
      this.currentStop = () => settle();
      this.audio.addEventListener('ended', handleEnded, { once: true });
      this.audio.addEventListener('error', handleError, { once: true });

      const playbackStartedAt = this.now();
      try {
        await Promise.resolve(this.audio.play());
      } catch (error) {
        settle(error);
        await ended.catch(() => {});
        throw error;
      }
      if (this.cancelled) {
        settle();
        return;
      }

      const gapMs = this.lastPlaybackEndedAt == null
        ? null
        : Math.max(0, playbackStartedAt - this.lastPlaybackEndedAt);
      this.isPlaying = !settled;
      this.emit('playback_started', { index: item.index, gapMs });
      if (!this.firstAudioReported) {
        this.firstAudioReported = true;
        this.onFirstAudio({
          elapsedMs: this.now() - this.startedAt,
          synthesisMs: prepared.synthesisMs
        });
      }
      this.startPrefetch();
      await ended;
      this.isPlaying = false;
      this.lastPlaybackEndedAt = this.now();
      this.emit('playback_ended', {
        index: item.index,
        playbackMs: this.lastPlaybackEndedAt - playbackStartedAt
      });
    }

    clearBuffered() {
      this.items = [];
      this.bufferedChars = 0;
      this.prefetch = null;
    }

    async drain() {
      if (this.running || this.cancelled) return;
      this.running = true;
      try {
        while (this.items.length && !this.cancelled) {
          const item = this.items.shift();
          this.currentItem = item;
          const prepared = await this.takePrepared(item);
          if (this.cancelled) break;
          await this.playPrepared(item, prepared);
          this.bufferedChars = Math.max(0, this.bufferedChars - item.text.length);
          this.currentItem = null;
        }
      } catch (error) {
        if (!this.cancelled && error?.name !== 'AbortError') {
          this.emit('error', { code: error?.code || 'VOICE_QUEUE_ERROR' });
          this.onError(error);
        }
        this.activeSynthesis?.controller.abort();
        this.currentStop?.();
        this.clearBuffered();
      } finally {
        this.currentItem = null;
        this.isPlaying = false;
        if (this.cancelled) this.clearBuffered();
        this.running = false;
        this.emit('idle', { cancelled: this.cancelled });
        this.onIdle({ cancelled: this.cancelled });
        this.idleWaiters.splice(0).forEach((resolve) => resolve({ cancelled: this.cancelled }));
      }
    }

    waitForIdle() {
      if (!this.running && !this.currentItem && !this.items.length && !this.activeSynthesis && !this.prefetch) {
        return Promise.resolve({ cancelled: this.cancelled });
      }
      return new Promise((resolve) => this.idleWaiters.push(resolve));
    }

    cancel(reason = 'cancelled') {
      if (this.cancelled) return;
      this.cancelled = true;
      this.emit('cancelled', { reason });
      this.activeSynthesis?.controller.abort(reason);
      this.currentStop?.();
      this.clearBuffered();
      this.audio?.pause?.();
      this.revokeCurrentUrl();
      this.audio?.removeAttribute?.('src');
      this.audio?.load?.();
    }
  }

  return {
    parseFrame,
    createParser,
    summarizeAudioEvents,
    streamNestorTurn,
    SentenceAudioQueue
  };
}));
