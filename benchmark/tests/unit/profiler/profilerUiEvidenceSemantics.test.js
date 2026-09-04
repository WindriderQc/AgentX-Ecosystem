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
    expect(profiling).toContain('95% CI');
    expect(profiling).toContain('coefficientOfVariation');
    expect(profiling).not.toMatch(/optimal ctx/i);
  });

  test('renders only aggregate streamed TTFT p50 instead of a representative throughput sample', () => {
    const render = publicSource('models-render.js');
    const profiling = publicSource('models-profiling.js');
    expect(render).toContain('p.ttftP50Ms');
    expect(render).toContain("p.ttftMeasurement === 'streamed_wall_clock'");
    expect(profiling).toContain('measurementQuality?.ttftP50Ms');
    expect(profiling).toContain('TTFT p50');
    expect(render).not.toContain('p.ttftMs');
  });

  test('renders an unqualified Full run as incomplete instead of successful', () => {
    const profiling = publicSource('models-profiling.js');
    expect(profiling).toContain("const unqualifiedFull = depth === 'full' && !benchmarkQualified");
    expect(profiling).toContain('Full profile incomplete — not qualified on');
    expect(profiling).toContain("unqualifiedFull ? 'Not qualified' : 'Profiled ✓'");
  });

  test('rebuilds persistent authority badges and masks non-authoritative recommendations on reload', () => {
    const models = publicSource('models.js');
    const helpers = publicSource('models-helpers.js');
    const render = publicSource('models-render.js');
    expect(models).toContain('classifyProfileEvidence(profile, evidence, selectedHostId)');
    expect(models).toContain('evidenceProfile.recommendedInteractiveContext = null');
    expect(models).toContain('evidenceProfile.recommendedDocumentContext = null');
    expect(helpers).toContain("status: stale ? 'stale' : qualified ? 'qualified'");
    expect(render).toContain("{ label: 'Qualified', tone: 'qualified' }");
    expect(render).toContain("{ label: 'Not qualified', tone: 'unqualified' }");
    expect(render).toContain("{ label: 'Stale', tone: 'stale' }");
    expect(render).toContain('recommendationsAuthoritative === true');
  });
});
