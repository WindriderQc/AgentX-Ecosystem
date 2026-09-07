const fs = require('node:fs');
const path = require('node:path');
test('home keeps deployment mismatch and unknown identity visible', () => {
 const source = fs.readFileSync(path.resolve(__dirname, '../../public/js/home.js'), 'utf8');
 expect(source).toContain("consistency.status === 'degraded'");
 expect(source).toContain('Deployment mismatch');
 expect(source).toContain('Build identity unverified');
 const view = fs.readFileSync(path.resolve(__dirname, '../../views/pages/home.ejs'), 'utf8');
 expect(view).toContain('Core, Benchmark, and RAG HTTP contracts');
 expect(view).toContain('required dependency health');
});
