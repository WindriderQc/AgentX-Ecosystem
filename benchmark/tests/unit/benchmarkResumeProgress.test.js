const fs = require('fs');
const path = require('path');
const vm = require('vm');

const source = fs.readFileSync(path.join(__dirname, '../../public/js/benchmark-v2/launch-summary.js'), 'utf8')
    .replace(/^import .*;\r?$/gm, '')
    .replace(/export function /g, 'function ');

function render(batch) {
    const context = { esc: String, document: { createElement: () => ({ querySelector: () => null }) } };
    vm.runInNewContext(source, context);
    const container = { querySelector: () => null, prepend: jest.fn() };
    context.renderResumeBanner(container, batch);
    return container.prepend.mock.calls[0][0].innerHTML;
}

describe('resume banner processed-result count', () => {
    it('uses the persisted count, not a percentage or an absent heavy result list', () => {
        expect(render({ total_tests: 336, completed: 329, progress: 98, results: [] }))
            .toContain('329/336 (98%)');
    });
    it('preserves an authoritative zero instead of falling back to stale progress', () => {
        expect(render({ total_tests: 10, completed: 0, progress: 50,
            results: [{ quality_score: 10 }] })).toContain('0/10 (0%)');
    });
    it('counts unscored failures in the historical result-list fallback', () => {
        expect(render({ total_tests: 3, results: [{ quality_score: 8 }, { quality_score: null }] }))
            .toContain('2/3 (67%)');
    });
});
