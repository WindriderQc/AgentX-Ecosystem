/**
 * Tests for Model Parameter Detection
 */

const {
  parseParameterCount,
  parseQuantization,
  bytesPerParam,
  detectOptimalNumCtx,
  inferVendor,
  generateDisplayName
} = require('../../src/services/modelSync/parameterDetection');

describe('parseParameterCount', () => {
  it('should parse direct "7B" format', () => {
    expect(parseParameterCount('7B')).toBe(7);
    expect(parseParameterCount('7b')).toBe(7);
    expect(parseParameterCount('70B')).toBe(70);
    expect(parseParameterCount('1.7b')).toBe(1.7);
    expect(parseParameterCount('32B')).toBe(32);
  });

  it('should parse from model name strings', () => {
    expect(parseParameterCount('qwen2.5:7b-instruct')).toBe(7);
    expect(parseParameterCount('llama3:70b-instruct-q4_K_M')).toBe(70);
    expect(parseParameterCount('smollm2:1.7b')).toBe(1.7);
    expect(parseParameterCount('qwen2.5:32b-instruct-q4_K_M')).toBe(32);
  });

  it('should return null for unparseable strings', () => {
    expect(parseParameterCount(null)).toBeNull();
    expect(parseParameterCount('')).toBeNull();
    expect(parseParameterCount('nomic-embed-text')).toBeNull();
    expect(parseParameterCount('mxbai-embed-large')).toBeNull();
  });
});

describe('parseQuantization', () => {
  it('should parse quantization from strings', () => {
    expect(parseQuantization('Q4_K_M')).toBe('Q4_K_M');
    expect(parseQuantization('q4_0')).toBe('Q4_0');
    expect(parseQuantization('Q5_K_M')).toBe('Q5_K_M');
    expect(parseQuantization('F16')).toBe('F16');
  });

  it('should extract from model names', () => {
    expect(parseQuantization('qwen2.5:32b-instruct-q4_K_M')).toBe('Q4_K_M');
    expect(parseQuantization('llama3:8b-q5_K_M')).toBe('Q5_K_M');
  });

  it('should return null when no quant found', () => {
    expect(parseQuantization(null)).toBeNull();
    expect(parseQuantization('nomic-embed-text')).toBeNull();
  });
});

describe('bytesPerParam', () => {
  it('should return correct byte sizes', () => {
    expect(bytesPerParam('Q4_0')).toBe(0.5625);
    expect(bytesPerParam('Q4_K_M')).toBe(0.5625);
    expect(bytesPerParam('Q5_K_M')).toBe(0.6875);
    expect(bytesPerParam('Q8_0')).toBe(1.0);
    expect(bytesPerParam('F16')).toBe(2.0);
  });

  it('should default to ~0.625 for unknown', () => {
    expect(bytesPerParam(null)).toBe(0.625);
    expect(bytesPerParam('unknown')).toBe(0.625);
  });
});

describe('detectOptimalNumCtx', () => {
  it('should calculate based on VRAM when available', () => {
    // 7B Q4 model on 24GB VRAM — should get generous context
    const result = detectOptimalNumCtx({
      parameterSize: '7B',
      quantization: 'Q4_K_M',
      modelSizeBytes: 4_000_000_000,
      hostVramMiB: 24576 // 24 GB
    });
    expect(result.num_ctx).toBeGreaterThanOrEqual(16384);
    expect(result.reason).toContain('7');
  });

  it('should limit context for large models on small VRAM', () => {
    // 32B Q4 model on 24GB VRAM — should be conservative
    const result = detectOptimalNumCtx({
      parameterSize: '32B',
      quantization: 'Q4_K_M',
      modelSizeBytes: 20_000_000_000,
      hostVramMiB: 24576
    });
    expect(result.num_ctx).toBeLessThanOrEqual(8192);
    expect(result.reason).toContain('32');
  });

  it('should use conservative lookup table when VRAM unknown', () => {
    const small = detectOptimalNumCtx({ parameterSize: '7B', quantization: null, modelSizeBytes: null, hostVramMiB: null });
    expect(small.num_ctx).toBe(8192);
    expect(small.reason).toContain('conservative');

    const large = detectOptimalNumCtx({ parameterSize: '70B', quantization: null, modelSizeBytes: null, hostVramMiB: null });
    expect(large.num_ctx).toBe(2048);

    const tiny = detectOptimalNumCtx({ parameterSize: '1.7B', quantization: null, modelSizeBytes: null, hostVramMiB: null });
    expect(tiny.num_ctx).toBe(8192);
  });

  it('should use model size bytes as last resort', () => {
    const result = detectOptimalNumCtx({ parameterSize: null, quantization: null, modelSizeBytes: 4_000_000_000, hostVramMiB: null });
    expect(result.num_ctx).toBe(16384);
    expect(result.reason).toContain('size-based');
  });

  it('should return system default when nothing known', () => {
    const result = detectOptimalNumCtx({ parameterSize: null, quantization: null, modelSizeBytes: null, hostVramMiB: null });
    expect(result.num_ctx).toBe(8192);
    expect(result.reason).toContain('system default');
  });
});

describe('inferVendor', () => {
  it('should detect common vendors', () => {
    expect(inferVendor('qwen2.5:7b', 'qwen2')).toBe('alibaba');
    expect(inferVendor('llama3.3:70b', null)).toBe('meta');
    expect(inferVendor('deepseek-r1:7b', null)).toBe('deepseek');
    expect(inferVendor('mistral:7b', null)).toBe('mistral');
    expect(inferVendor('gemma4:e4b', null)).toBe('google');
    expect(inferVendor('phi3:3b', null)).toBe('microsoft');
    expect(inferVendor('smollm2:1.7b', null)).toBe('community');
    expect(inferVendor('nomic-embed-text', null)).toBe('community');
  });

  it('should return unknown for unrecognized models', () => {
    expect(inferVendor('custom-model:latest', null)).toBe('unknown');
  });
});

describe('generateDisplayName', () => {
  it('should create readable display names', () => {
    const name = generateDisplayName('qwen2.5:32b-instruct-q4_K_M');
    expect(name).toContain('Qwen');
    expect(name).not.toContain(':');
    expect(name).not.toContain('-');
  });
});
