'use strict';

const DEFAULT_MIN_CHARS = 6;
const DEFAULT_MAX_CHARS = 220;

function punctuationBoundary(text, minimum) {
  const boundary = /[.!?…](?:["'»”)\]]{0,2})(?=\s|$)/g;
  let match;
  while ((match = boundary.exec(text)) !== null) {
    const end = match.index + match[0].length;
    if (end >= minimum) return end;
  }
  return -1;
}

function boundedBoundary(text, minimum, maximum) {
  if (text.length < maximum) return -1;
  const candidate = text.slice(0, maximum + 1);
  const whitespace = candidate.lastIndexOf(' ');
  return whitespace >= minimum ? whitespace : maximum;
}

/**
 * Turns arbitrary text deltas into speakable sentence-sized chunks.
 *
 * Natural punctuation is preferred. The maximum bound prevents a long,
 * punctuation-free answer from delaying first audio indefinitely.
 */
class NestorSentenceChunker {
  constructor(onSentence, options = {}) {
    this.onSentence = typeof onSentence === 'function' ? onSentence : () => {};
    this.transform = typeof options.transform === 'function' ? options.transform : (text) => text;
    this.minimum = Math.max(1, Number(options.minimum) || DEFAULT_MIN_CHARS);
    this.maximum = Math.max(this.minimum, Number(options.maximum) || DEFAULT_MAX_CHARS);
    this.buffer = '';
  }

  push(delta) {
    if (delta == null || delta === '') return;
    this.buffer += String(delta);
    this.drain(false);
  }

  finish() {
    this.drain(true);
  }

  drain(final) {
    while (this.buffer) {
      this.buffer = this.buffer.replace(/^\s+/, '');
      if (!this.buffer) return;

      const natural = punctuationBoundary(this.buffer, this.minimum);
      const bounded = natural === -1
        ? boundedBoundary(this.buffer, this.minimum, this.maximum)
        : -1;
      const boundary = natural !== -1 ? natural : bounded;

      if (boundary === -1) {
        if (final) {
          const remainder = this.buffer.trim();
          this.buffer = '';
          const speakable = this.transform(remainder);
          if (speakable) this.onSentence(speakable);
        }
        return;
      }

      const sentence = this.buffer.slice(0, boundary).trim();
      this.buffer = this.buffer.slice(boundary);
      const speakable = this.transform(sentence);
      if (speakable) this.onSentence(speakable);
    }
  }
}

module.exports = {
  NestorSentenceChunker,
  punctuationBoundary,
  boundedBoundary,
  DEFAULT_MIN_CHARS,
  DEFAULT_MAX_CHARS
};
