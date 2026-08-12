const slugify = require('../src/slugify');
if (slugify(' Hello, World! ') !== 'hello-world') { console.error('public FAIL'); process.exit(1); }
process.exit(0);
