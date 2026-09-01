'use strict';

const fs = require('fs');
const path = require('path');

describe('Models catalog Benchmark Trust language', () => {
  const source = fs.readFileSync(
    path.join(__dirname, '../../public/js/models-unified-popouts.js'),
    'utf8'
  );

  test('legacy scores remain observations and never receive a crown', () => {
    expect(source).toContain('Historical benchmark observations only');
    expect(source).toContain('do not identify a qualified winner or authorize routing');
    expect(source).toContain('Measured observations');
    expect(source).not.toContain('fa-crown');
    expect(source).not.toContain('Top Performers');
  });
});
