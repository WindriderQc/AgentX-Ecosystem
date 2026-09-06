'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const source = fs.readFileSync(path.join(__dirname, '../../public/js/models-unified.js'), 'utf8');

/** Evaluate the pure capabilityEvidence method in isolation. */
function capabilityEvidence(model, category) {
  const start = source.indexOf('    capabilityEvidence(model, category) {');
  const end = source.indexOf('    capabilityTierBadge(model, category) {');
  const body = source.slice(start, end).replace('capabilityEvidence(model, category) {', 'function capabilityEvidence(model, category) {');
  const context = { escapeHtml: (v) => String(v) };
  vm.createContext(context);
  vm.runInContext(`${body}\nthis.capabilityEvidence = capabilityEvidence;`, context);
  return context.capabilityEvidence(model, category);
}

describe('Models capability taxonomy', () => {
  test('separates benchmark evidence, declared tags, blocked eligibility and unknown', () => {
    expect(capabilityEvidence({ categories: ['coding'] }, 'coding').tier).toBe('declared');
    expect(capabilityEvidence({ tags: ['Coding'] }, 'coding').tier).toBe('declared');
    expect(capabilityEvidence({ benchmarkStats: { totalTests: 12, bestCategory: 'coding' } }, 'coding')).toMatchObject({ tier: 'evidence', evidence: true });
    expect(capabilityEvidence({ benchmarkStats: { totalTests: 12, worstCategory: 'coding' }, categories: ['coding'] }, 'coding').tier).toBe('evidence');
    expect(capabilityEvidence({ benchmarkEligibility: { eligible: false, blockedReason: 'quantization unverified' } }, 'coding')).toMatchObject({ tier: 'not_eligible' });
    expect(capabilityEvidence({}, 'coding')).toMatchObject({ tier: 'unknown' });
  });

  test('a name containing coder proves nothing, and zero scored tests are not evidence', () => {
    expect(capabilityEvidence({ name: 'qwen3-coder:30b' }, 'coding').tier).toBe('unknown');
    expect(capabilityEvidence({ benchmarkStats: { totalTests: 0, bestCategory: 'coding' } }, 'coding').tier).toBe('unknown');
  });

  test('the filter keeps declared and evidenced models, discloses hidden unknowns, and can show them', () => {
    expect(source).toContain("if (tier === 'unknown' || tier === 'not_eligible') {");
    expect(source).toContain('if (!this.includeUnknownCapability) return false;');
    expect(source).toContain('capabilityDisclosureRow()');
    expect(source).toContain("unknown is not \"not capable\"");
    expect(source).toContain("id=\"capabilityUnknownToggle\"");
    expect(source).toContain('the rest are unknown, not excluded as incapable');
    expect(source).toContain('this.capabilityTierBadge(model, this.activeCategory)');
  });

  test('Trusted qualification is explicitly out of this catalog projection', () => {
    expect(source).toContain('Trusted per-category qualification belongs to');
    expect(source).not.toMatch(/tier = ['"]qualified['"]/);
  });
});
