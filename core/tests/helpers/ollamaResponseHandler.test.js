/**
 * Ollama Response Handler Tests
 * Tests for cleaning leaked template tags and response extraction
 */

const {
  cleanContent,
  extractResponse,
  normalizeOllamaResponse,
  buildOllamaPayload,
  buildOllamaStats,
  extractThinkingBlocks
} = require('../../src/helpers/ollamaResponseHandler');

describe('Ollama Response Handler', () => {
  describe('cleanContent', () => {
    it('should return content unchanged if no tags are present', () => {
      const content = 'This is a normal response without any tags.';
      expect(cleanContent(content)).toBe(content);
    });

    it('should remove properly formatted Llama 3 header tags', () => {
      const content = '<|start_header_id|>user<|end_header_id|>Hello, how are you?';
      const expected = 'Hello, how are you?';
      expect(cleanContent(content)).toBe(expected);
    });

    it('should remove multiple header tag pairs', () => {
      const content = '<|start_header_id|>user<|end_header_id|>Question<|start_header_id|>assistant<|end_header_id|>Answer';
      const expected = 'QuestionAnswer';
      expect(cleanContent(content)).toBe(expected);
    });

    it('should remove eot_id token', () => {
      const content = 'Response text<|eot_id|>';
      const expected = 'Response text';
      expect(cleanContent(content)).toBe(expected);
    });

    it('should remove begin_of_text token', () => {
      const content = '<|begin_of_text|>Response text';
      const expected = 'Response text';
      expect(cleanContent(content)).toBe(expected);
    });

    it('should remove end_of_text token', () => {
      const content = 'Response text<|end_of_text|>';
      const expected = 'Response text';
      expect(cleanContent(content)).toBe(expected);
    });

    it('should remove fin token', () => {
      const content = 'Response text<|fin|>';
      const expected = 'Response text';
      expect(cleanContent(content)).toBe(expected);
    });

    it('should remove all special tokens in combination', () => {
      const content = '<|begin_of_text|><|start_header_id|>user<|end_header_id|>Hello<|eot_id|>';
      const expected = 'Hello';
      expect(cleanContent(content)).toBe(expected);
    });

    it('should handle content with only tags (becomes empty)', () => {
      const content = '<|start_header_id|>system<|end_header_id|>';
      const expected = '';
      expect(cleanContent(content)).toBe(expected);
    });

    it('should handle empty string input', () => {
      expect(cleanContent('')).toBe('');
    });

    it('should handle null input', () => {
      expect(cleanContent(null)).toBe(null);
    });

    it('should handle undefined input', () => {
      expect(cleanContent(undefined)).toBe(undefined);
    });

    it('should trim whitespace after tag removal', () => {
      const content = '  <|start_header_id|>user<|end_header_id|>  Hello  ';
      const expected = 'Hello';
      expect(cleanContent(content)).toBe(expected);
    });

    it('should preserve legitimate content with pipe characters', () => {
      const content = 'Use the | operator in shell commands';
      expect(cleanContent(content)).toBe(content);
    });

    it('should preserve legitimate content with angle brackets', () => {
      const content = 'Array<string> is a TypeScript type';
      expect(cleanContent(content)).toBe(content);
    });

    it('should preserve content with partial tag-like patterns', () => {
      const content = 'The <start> tag and |end| marker';
      expect(cleanContent(content)).toBe(content);
    });

    it('should handle multiline content with tags', () => {
      const content = '<|start_header_id|>user<|end_header_id|>\nLine 1\nLine 2<|eot_id|>';
      const expected = 'Line 1\nLine 2';
      expect(cleanContent(content)).toBe(expected);
    });

    it('should handle tags with different role names', () => {
      const content = '<|start_header_id|>assistant<|end_header_id|>Response';
      const expected = 'Response';
      expect(cleanContent(content)).toBe(expected);
    });

    it('should handle tags in the middle of content', () => {
      const content = 'Start <|start_header_id|>system<|end_header_id|> End';
      const expected = 'Start  End';
      expect(cleanContent(content)).toBe(expected.trim());
    });
  });

  describe('extractResponse', () => {
    it('should extract content from message.content', () => {
      const data = {
        message: {
          content: 'Response from model'
        },
        done: true
      };
      const result = extractResponse(data, 'llama3');
      expect(result.content).toBe('Response from model');
      expect(result.thinking).toBe(null);
    });

    it('should extract content from response field (legacy format)', () => {
      const data = {
        response: 'Legacy response format',
        done: true
      };
      const result = extractResponse(data, 'llama3');
      expect(result.content).toBe('Legacy response format');
    });

    it('should clean leaked tags from response', () => {
      const data = {
        message: {
          content: '<|start_header_id|>assistant<|end_header_id|>Clean response<|eot_id|>'
        },
        done: true
      };
      const result = extractResponse(data, 'llama3');
      expect(result.content).toBe('Clean response');
    });

    it('should preserve thinking from direct response evidence when no contract is supplied', () => {
      const data = {
        message: {
          content: 'Final answer',
          thinking: 'Internal reasoning process'
        },
        done: true
      };
      const result = extractResponse(data, 'qwen2.5:7b');
      expect(result.content).toBe('Final answer');
      expect(result.thinking).toBe('Internal reasoning process');
    });

    it('should obey an explicit deployed-artifact capability instead of the model name', () => {
      const data = {
        message: {
          content: 'Final answer',
          thinking: 'Internal reasoning process'
        },
        done: true
      };
      const result = extractResponse(data, 'qwen3:8b', { thinkingSupported: false });
      expect(result.content).toBe('Final answer');
      expect(result.thinking).toBe(null);
    });

    it('should set warning for incomplete responses', () => {
      const data = {
        message: {
          content: 'Partial'
        },
        done: false
      };
      const result = extractResponse(data, 'llama3');
      expect(result.warning).toBe('Incomplete response - model may require streaming');
    });

    it('should set warning for empty responses', () => {
      const data = {
        done: true
      };
      const result = extractResponse(data, 'llama3');
      expect(result.warning).toBe('Empty response from Ollama');
    });

    it('should extract usage statistics when available', () => {
      const data = {
        message: {
          content: 'Response'
        },
        done: true,
        prompt_eval_count: 100,
        eval_count: 50,
        total_duration: 1000000000,
        load_duration: 100000000,
        eval_duration: 500000000
      };
      const result = extractResponse(data, 'llama3');
      expect(result.stats).toBeDefined();
      expect(result.stats.usage.promptTokens).toBe(100);
      expect(result.stats.usage.completionTokens).toBe(50);
      expect(result.stats.usage.totalTokens).toBe(150);
      expect(result.stats.performance.tokensPerSecond).toBeGreaterThan(0);
    });

    it('should not report tokens per second for empty final content', () => {
      const data = {
        message: {
          content: '<|start_header_id|>assistant<|end_header_id|>'
        },
        done: true,
        prompt_eval_count: 100,
        eval_count: 1,
        total_duration: 1000000,
        load_duration: 1000,
        eval_duration: 1000
      };
      const result = extractResponse(data, 'llama3');
      expect(result.content).toBe('');
      expect(result.warning).toBe('Empty response from Ollama');
      expect(result.stats.usage.completionTokens).toBe(1);
      expect(result.stats.performance.tokensPerSecond).toBeNull();
    });

    it('should build content-aware Ollama stats directly', () => {
      const stats = buildOllamaStats({
        done: true,
        done_reason: 'length',
        prompt_eval_count: 4,
        eval_count: 1,
        total_duration: 1000000,
        eval_duration: 1000
      }, '');

      expect(stats.usage.totalTokens).toBe(5);
      expect(stats.completion.reason).toBe('length');
      expect(stats.performance.tokensPerSecond).toBeNull();
    });

    it('should strip embedded thinking blocks from extracted content', () => {
      const data = {
        message: {
          content: '<think>hidden reasoning</think>Final answer'
        },
        done: true
      };
      const result = extractResponse(data, 'qwen3:8b');
      expect(result.content).toBe('Final answer');
      expect(result.thinking).toBe('hidden reasoning');
    });

    it('should not use structured thinking as final content when fallback is disabled', () => {
      const data = {
        message: {
          thinking: 'hidden reasoning only'
        },
        done: true
      };
      const result = extractResponse(data, 'qwen3:8b', { allowThinkingFallback: false });
      expect(result.content).toBe('');
      expect(result.thinking).toBe('hidden reasoning only');
      expect(result.warning).toBe('Empty response from Ollama');
    });
  });

  describe('normalizeOllamaResponse', () => {
    it('should remove structured thinking fields while preserving final content', () => {
      const data = {
        model: 'qwen3:8b',
        message: {
          role: 'assistant',
          content: 'Final answer',
          thinking: 'Internal reasoning process'
        },
        done: true,
        eval_count: 12,
        prompt_eval_count: 4
      };

      const result = normalizeOllamaResponse(data, 'qwen3:8b');

      expect(result.response).toBe('Final answer');
      expect(result.message.content).toBe('Final answer');
      expect(result.message.thinking).toBeUndefined();
      expect(result.thinking).toBeUndefined();
      expect(result.thinking_suppressed).toBeUndefined();
      expect(result.eval_count).toBe(12);
      expect(result.prompt_eval_count).toBe(4);
    });

    it('should strip embedded think tags from final content', () => {
      const data = {
        response: '<think>hidden reasoning</think>Final answer',
        done: true
      };

      const result = normalizeOllamaResponse(data, 'deepseek-r1:8b');

      expect(result.response).toBe('Final answer');
      expect(result.thinking).toBeUndefined();
      expect(result.thinking_suppressed).toBeUndefined();
    });

    it('should expose thinking only when explicitly requested', () => {
      const data = {
        message: {
          content: 'Final answer',
          thinking: 'Internal reasoning process'
        },
        done: true
      };

      const result = normalizeOllamaResponse(data, 'qwen3:8b', {
        suppressThinking: false,
        includeThinking: true
      });

      expect(result.response).toBe('Final answer');
      expect(result.message.thinking).toBeUndefined();
      expect(result.thinking).toBe('Internal reasoning process');
    });
  });

  describe('buildOllamaPayload', () => {
    it('should build basic payload', () => {
      const params = {
        model: 'llama3',
        messages: [{ role: 'user', content: 'Hello' }]
      };
      const payload = buildOllamaPayload(params);
      expect(payload.model).toBe('llama3');
      expect(payload.messages).toEqual(params.messages);
      expect(payload.stream).toBe(false);
      expect(payload.options.num_predict).toBe(-1);
    });

    it('should enable streaming when requested', () => {
      const params = {
        model: 'llama3',
        messages: [{ role: 'user', content: 'Hello' }],
        streamEnabled: true
      };
      const payload = buildOllamaPayload(params);
      expect(payload.stream).toBe(true);
      expect(payload.options.num_predict).toBe(-1);
    });

    it('should not inject default num_ctx (callers resolve it)', () => {
      const params = {
        model: 'qwen2.5:7b',
        messages: [{ role: 'user', content: 'Hello' }],
        streamEnabled: false
      };
      const payload = buildOllamaPayload(params);
      expect(payload.options.num_ctx).toBeUndefined();
    });

    it('should merge custom options', () => {
      const params = {
        model: 'llama3',
        messages: [{ role: 'user', content: 'Hello' }],
        options: {
          temperature: 0.7,
          top_p: 0.9
        }
      };
      const payload = buildOllamaPayload(params);
      expect(payload.options.temperature).toBe(0.7);
      expect(payload.options.top_p).toBe(0.9);
    });

    it('should preserve positive num_predict caps for non-stream calls', () => {
      const params = {
        model: 'llama3',
        messages: [{ role: 'user', content: 'Hello' }],
        options: {
          num_predict: 256
        },
        streamEnabled: false
      };

      const payload = buildOllamaPayload(params);

      expect(payload.stream).toBe(false);
      expect(payload.options.num_predict).toBe(256);
    });

    it('should hoist keep_alive to payload root (not inside options)', () => {
      const params = {
        model: 'llama3',
        messages: [{ role: 'user', content: 'Hello' }],
        options: {
          temperature: 0.7,
          keep_alive: '-1'
        }
      };
      const payload = buildOllamaPayload(params);
      expect(payload.keep_alive).toBe('-1');
      expect(payload.options.keep_alive).toBeUndefined();
      expect(payload.options.temperature).toBe(0.7);
    });

    it('should not include keep_alive when empty string', () => {
      const params = {
        model: 'llama3',
        messages: [{ role: 'user', content: 'Hello' }],
        options: { keep_alive: '' }
      };
      const payload = buildOllamaPayload(params);
      expect(payload.keep_alive).toBeUndefined();
    });

    it('should not include keep_alive when not provided', () => {
      const params = {
        model: 'llama3',
        messages: [{ role: 'user', content: 'Hello' }],
        options: {}
      };
      const payload = buildOllamaPayload(params);
      expect(payload.keep_alive).toBeUndefined();
    });
  });

  describe('extractThinkingBlocks', () => {
    it('should return content unchanged if no <think> tags present', () => {
      const content = 'This is a normal response without thinking tags.';
      const result = extractThinkingBlocks(content);
      expect(result.content).toBe(content);
      expect(result.thinking).toBe(null);
    });

    it('should extract a single <think> block', () => {
      const content = '<think>Internal reasoning here</think>The final answer is 42.';
      const result = extractThinkingBlocks(content);
      expect(result.content).toBe('The final answer is 42.');
      expect(result.thinking).toBe('Internal reasoning here');
    });

    it('should extract multiple <think> blocks', () => {
      const content = '<think>First thought</think>Some text<think>Second thought</think>Final answer.';
      const result = extractThinkingBlocks(content);
      expect(result.content).toBe('Some textFinal answer.');
      expect(result.thinking).toBe('First thought\n\nSecond thought');
    });

    it('should handle unclosed <think> tag (captures until end)', () => {
      const content = 'Answer: <think>Still thinking about this...';
      const result = extractThinkingBlocks(content);
      expect(result.content).toBe('Answer:');
      expect(result.thinking).toBe('Still thinking about this...');
    });

    it('should handle <think> block at the start', () => {
      const content = '<think>Let me analyze this problem</think>The solution is X.';
      const result = extractThinkingBlocks(content);
      expect(result.content).toBe('The solution is X.');
      expect(result.thinking).toBe('Let me analyze this problem');
    });

    it('should handle <think> block at the end', () => {
      const content = 'The answer is 5.<think>I verified this calculation</think>';
      const result = extractThinkingBlocks(content);
      expect(result.content).toBe('The answer is 5.');
      expect(result.thinking).toBe('I verified this calculation');
    });

    it('should handle multiline content inside <think> tags', () => {
      const content = '<think>Line 1\nLine 2\nLine 3</think>Final result.';
      const result = extractThinkingBlocks(content);
      expect(result.content).toBe('Final result.');
      expect(result.thinking).toBe('Line 1\nLine 2\nLine 3');
    });

    it('should combine with existing thinking (message.thinking)', () => {
      const content = '<think>Embedded thinking</think>Response text.';
      const existingThinking = 'Existing thinking from message.thinking';
      const result = extractThinkingBlocks(content, existingThinking);
      expect(result.content).toBe('Response text.');
      expect(result.thinking).toBe('Embedded thinking\n\nExisting thinking from message.thinking');
    });

    it('should preserve existing thinking when no embedded blocks', () => {
      const content = 'Just a normal response.';
      const existingThinking = 'Existing thinking content';
      const result = extractThinkingBlocks(content, existingThinking);
      expect(result.content).toBe('Just a normal response.');
      expect(result.thinking).toBe('Existing thinking content');
    });

    it('should handle empty content', () => {
      const result = extractThinkingBlocks('');
      expect(result.content).toBe('');
      expect(result.thinking).toBe(null);
    });

    it('should handle null content', () => {
      const result = extractThinkingBlocks(null);
      expect(result.content).toBe('');
      expect(result.thinking).toBe(null);
    });

    it('should handle undefined content', () => {
      const result = extractThinkingBlocks(undefined);
      expect(result.content).toBe('');
      expect(result.thinking).toBe(null);
    });

    it('should handle empty <think> tags', () => {
      const content = '<think></think>Actual content here.';
      const result = extractThinkingBlocks(content);
      expect(result.content).toBe('Actual content here.');
      expect(result.thinking).toBe(null); // Empty thinking is ignored
    });

    it('should be case insensitive for <think> tags', () => {
      const content = '<THINK>Uppercase thinking</THINK>Result.';
      const result = extractThinkingBlocks(content);
      expect(result.content).toBe('Result.');
      expect(result.thinking).toBe('Uppercase thinking');
    });

    it('should handle nested-looking content (not actual nesting)', () => {
      const content = '<think>I thought about <think> but decided against it</think>Answer.';
      const result = extractThinkingBlocks(content);
      expect(result.content).toBe('Answer.');
      expect(result.thinking).toContain('I thought about');
    });
  });
});
