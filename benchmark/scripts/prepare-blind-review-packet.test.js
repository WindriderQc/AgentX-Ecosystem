'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {
  buildBenchmarkBlindReviewPackage,
} = require('../../shared/benchmarkBlindReviewPacket');
const { fingerprint } = require('../../shared/workerContract');
const {
  OUTPUT_FILES,
  parseArgs,
  writePackage,
} = require('./prepare-blind-review-packet');

function packageFixture() {
  const categories = [
    'coding', 'creative', 'instruction', 'knowledge', 'math', 'reasoning', 'translation',
  ];
  let sequence = 0;
  const items = [];
  for (const category of categories) {
    for (const difficulty of [1, 2, 3, 4, 5]) {
      for (const split of ['validation', 'validation', 'holdout', 'holdout', 'holdout']) {
        const response = `response-${sequence}`;
        items.push({
          reviewId: `review-${sequence}`,
          split,
          category,
          difficulty,
          prompt: `prompt-${sequence}`,
          expectedAnswer: `answer-${sequence}`,
          response,
          source: {
            sourceResultId: sequence.toString(16).padStart(24, '0'),
            sourceBatchId: `batch_${fingerprint(`batch-${sequence}`).slice(0, 32)}`,
            sourceResultFingerprint: fingerprint(`source-${sequence}`),
            promptFingerprint: fingerprint(`prompt-${sequence}`),
            responseFingerprint: fingerprint(response),
            category,
            judgeIdentityFingerprint: fingerprint('judge'),
            judgeScoreMicros: 5_000_000,
          },
        });
        sequence += 1;
      }
    }
  }
  return buildBenchmarkBlindReviewPackage({
    schema: 'agentx.benchmark-blind-review-source-bundle/v1',
    corpusId: 'corpus-175',
    reviewerId: 'human-reviewer-01',
    reviewProtocol: 'blind_independent',
    rubric: {
      rubricId: 'rubric-v1',
      rubricFingerprint: fingerprint('rubric'),
      dimensions: ['correctness'],
    },
    items,
  });
}

test('requires explicit input and a new output directory', () => {
  assert.throws(() => parseArgs([]), /--input is required/);
  assert.throws(() => parseArgs(['--input', 'source.json']), /--output-dir is required/);
  const options = parseArgs(['--input', 'source.json', '--output-dir', 'review-output']);
  assert.equal(options.inputPath, path.resolve('source.json'));
  assert.equal(options.outputDirectory, path.resolve('review-output'));
});

test('writes three separate artifacts once and refuses overwrite', (context) => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'agentx-blind-review-'));
  context.after(() => fs.rmSync(parent, { recursive: true, force: true }));
  const output = path.join(parent, 'packet');
  const files = writePackage(output, packageFixture());

  assert.deepEqual(Object.keys(files).sort(), Object.keys(OUTPUT_FILES).sort());
  for (const file of Object.values(files)) assert.equal(fs.existsSync(file), true);
  const packet = JSON.parse(fs.readFileSync(files.packet, 'utf8'));
  assert.equal(packet.items.length, 175);
  assert.doesNotMatch(JSON.stringify(packet), /validation|holdout|judgeScore/);
  assert.throws(() => writePackage(output, packageFixture()), /never overwrites/);
});

test('source contains no provider, campaign, network, key-generation, or signing primitive', () => {
  const source = fs.readFileSync(__filename.replace(/\.test\.js$/, '.js'), 'utf8');
  assert.doesNotMatch(source, /fetch\(|https?:\/\/|generateKeyPair|privateKey|crypto\.sign|campaign.*start/i);
});
