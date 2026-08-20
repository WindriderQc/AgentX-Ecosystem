'use strict';

const fs = require('fs');
const path = require('path');

describe('Core image runtime dependencies', () => {
  test('the single release image retains the bounded SSH client used by configured remote evidence collectors', () => {
    const dockerfile = path.resolve(__dirname, '../../../docker/core.Dockerfile');
    const source = fs.readFileSync(dockerfile, 'utf8');
    expect(source).toMatch(/apt-get install[^\n]*openssh-client|apt-get install[\s\S]*?openssh-client/);
  });
});
