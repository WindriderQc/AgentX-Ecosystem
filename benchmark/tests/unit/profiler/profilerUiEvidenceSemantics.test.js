'use strict';

const fs = require('node:fs');
const path = require('node:path');

function publicSource(file) {
  return fs.readFileSync(path.resolve(__dirname, '..', '..', '..', 'public', 'js', 'model-profiler', file), 'utf8');
}

describe('profiler UI evidence semantics', () => {
  test('renders capacity and workload recommendations as distinct fields', () => {
    const render = publicSource('models-render.js');
    expect(render).toContain('p.maxVerifiedContext');
    expect(render).toContain('p.recommendedInteractiveContext');
    expect(render).toContain('p.recommendedDocumentContext');
    expect(render).toContain('max verified');
    expect(render).not.toContain('p.optimalNumCtx');
    expect(render).not.toContain('p.recommendedContext');
    expect(render).not.toMatch(/optimal ctx/i);
  });

  test('keeps the Full prefill/decode matrix visible and unknown offload explicit', () => {
    const profiling = publicSource('models-profiling.js');
    expect(profiling).toContain('Prefill / Decode Matrix');
    expect(profiling).toContain('profile?.prefillDecodeMatrix');
    expect(profiling).toContain("? 'Unknown'");
    expect(profiling).not.toMatch(/optimal ctx/i);
  });
});
