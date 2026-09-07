'use strict';
require('../../shared/testing/runJest').run(require('path').resolve(__dirname, '..'))
  .then(code => { process.exitCode = code; })
  .catch(err => { console.error(err.message); process.exitCode = 1; });
