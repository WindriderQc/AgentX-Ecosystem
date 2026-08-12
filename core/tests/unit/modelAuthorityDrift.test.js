const fs = require('fs');
const path = require('path');

/**
 * Regression guard for assessment issue #3 (front-door model authority).
 *
 * The Nestor / OpenClaw `main` model chain must live in ONE machine-readable home
 * — config/agent-registry.yml `agents.main.model` — with the live runtime
 * authoritative (runtime_state_wins). Prose role docs must POINT there, never
 * restate a concrete model id. Restating them is exactly what produced the
 * Sonnet-vs-nemotron-vs-gpt-5.5 drift the assessment flagged.
 *
 * This test fails CI if a concrete model id reappears in the front-door role
 * prose, so #3 cannot silently regress.
 */
const ROLES_DIR = path.join(__dirname, '../../../roles');
const GUARDED_DOCS = ['Nestor.md', 'Main.md'];

// Concrete provider/model id shapes that must not be hardcoded in prose.
// Bare vendor words ("Sonnet", "nemotron") used as historical context are fine;
// these patterns require the version/tag that makes it a pinned id.
const MODEL_ID_PATTERNS = [
  /claude-[a-z]+-\d/i,          // anthropic/claude-sonnet-4-6
  /nemotron[\w-]*-\d/i,         // nvidia/nemotron-3-super-120b-a12b
  /\bgemma\d[\w.]*:[\w.-]+/i,   // ax/gemma4:26b-a4b-it-qat
  /\bqwen[\d.][\w.-]*:[\w.-]+/i,// ax/qwen3-coder:30b, qwen2.5:7b-instruct...
  /\bgpt-\d/i,                  // openai/gpt-5.x
  /openrouter\/[\w./-]+/i,      // openrouter/<vendor>/<model>
];

describe('front-door model authority is single-sourced (issue #3 guard)', () => {
  for (const doc of GUARDED_DOCS) {
    it(`roles/${doc} points to the registry instead of hardcoding a model id`, () => {
      const text = fs.readFileSync(path.join(ROLES_DIR, doc), 'utf8');
      const offenders = [];
      text.split(/\r?\n/).forEach((line, i) => {
        for (const re of MODEL_ID_PATTERNS) {
          const m = line.match(re);
          if (m) offenders.push(`  L${i + 1}: "${m[0]}"  <-  ${line.trim().slice(0, 100)}`);
        }
      });
      if (offenders.length) {
        throw new Error(
          `roles/${doc} hardcodes model id(s). The front-door chain must live only in ` +
          `config/agent-registry.yml (agents.main.model), runtime_state_wins authoritative. ` +
          `Reference it, do not restate it.\nOffending lines:\n${offenders.join('\n')}`
        );
      }
      // The doc should still point readers at the single-source registry.
      expect(text).toMatch(/agent-registry\.yml/);
    });
  }
});
