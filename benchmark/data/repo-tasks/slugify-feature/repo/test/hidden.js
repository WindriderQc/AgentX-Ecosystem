const slugify = require('../src/slugify');
if (slugify('---A  B__C---') !== 'a-b-c' || slugify(' !!! ') !== '') { console.error('hidden FAIL'); process.exit(1); }
process.exit(0);
