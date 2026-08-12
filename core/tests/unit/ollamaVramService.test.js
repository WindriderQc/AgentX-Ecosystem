/**
 * Tests for Ollama VRAM Service — static fallback chain
 */

const { parseHostVramMap } = require('../../src/services/ollamaVramService')._internal;

describe('parseHostVramMap', () => {
  const originalEnv = process.env.OLLAMA_HOST_VRAM_MAP;

  afterEach(() => {
    if (originalEnv !== undefined) {
      process.env.OLLAMA_HOST_VRAM_MAP = originalEnv;
    } else {
      delete process.env.OLLAMA_HOST_VRAM_MAP;
    }
  });

  it('should parse valid host=vram entries', () => {
    process.env.OLLAMA_HOST_VRAM_MAP = '192.0.2.12=14336,192.0.2.66=24576';
    const map = parseHostVramMap();
    expect(map.get('192.0.2.12')).toBe(14336);
    expect(map.get('192.0.2.66')).toBe(24576);
    expect(map.size).toBe(2);
  });

  it('should return empty map when env var is not set', () => {
    delete process.env.OLLAMA_HOST_VRAM_MAP;
    const map = parseHostVramMap();
    expect(map.size).toBe(0);
  });

  it('should return empty map for empty string', () => {
    process.env.OLLAMA_HOST_VRAM_MAP = '';
    const map = parseHostVramMap();
    expect(map.size).toBe(0);
  });

  it('should skip invalid entries', () => {
    process.env.OLLAMA_HOST_VRAM_MAP = '192.0.2.12=14336,bad,=100,host=-5';
    const map = parseHostVramMap();
    expect(map.size).toBe(1);
    expect(map.get('192.0.2.12')).toBe(14336);
  });

  it('should normalize hostnames to lowercase', () => {
    process.env.OLLAMA_HOST_VRAM_MAP = 'MyHost=8192';
    const map = parseHostVramMap();
    expect(map.get('myhost')).toBe(8192);
  });

  it('should handle whitespace in entries', () => {
    process.env.OLLAMA_HOST_VRAM_MAP = ' 192.0.2.12 = 14336 , 192.0.2.66 = 24576 ';
    const map = parseHostVramMap();
    expect(map.get('192.0.2.12')).toBe(14336);
    expect(map.get('192.0.2.66')).toBe(24576);
  });
});
