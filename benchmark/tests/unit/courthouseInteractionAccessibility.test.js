const fs = require('fs');
const path = require('path');

const benchmarkRoot = path.resolve(__dirname, '..', '..');
const read = (...segments) => fs.readFileSync(path.join(benchmarkRoot, ...segments), 'utf8');

function relativeLuminance(hex) {
    const channels = hex.replace('#', '').match(/../g).map(value => parseInt(value, 16) / 255);
    const linear = channels.map(value => value <= 0.04045
        ? value / 12.92
        : ((value + 0.055) / 1.055) ** 2.4);
    return 0.2126 * linear[0] + 0.7152 * linear[1] + 0.0722 * linear[2];
}

function contrastRatio(foreground, background) {
    const foregroundLuminance = relativeLuminance(foreground);
    const backgroundLuminance = relativeLuminance(background);
    return (Math.max(foregroundLuminance, backgroundLuminance) + 0.05)
        / (Math.min(foregroundLuminance, backgroundLuminance) + 0.05);
}

describe('Courthouse keyboard and text-contrast contracts', () => {
    test('review queue entries are native buttons with disclosure state', () => {
        const source = read('public', 'js', 'courthouse-v2', 'review-queue.js');

        expect(source).toContain('<button type="button" class="rq-item');
        expect(source).toContain('aria-expanded="false"');
        expect(source).toContain('aria-controls="courthouse-detail-panel"');
        expect(source).toContain("item.setAttribute('aria-expanded', 'true')");
        expect(source).toContain('class="rq-arrow" aria-hidden="true"');
    });

    test('every ledger row exposes a native open-details control', () => {
        const source = read('public', 'js', 'courthouse-v2', 'results-ledger.js');
        const index = read('public', 'js', 'courthouse-v2', 'index.js');

        expect(source).toContain('type="button" class="ledger-open"');
        expect(source).toContain('aria-controls="courthouse-detail-panel"');
        expect(source).toContain("row.querySelector('.ledger-open')?.setAttribute('aria-expanded', 'true')");
        expect(source).toContain("String(r._id || r.id || '') === id");
        expect(index).toContain("activateTab('review')");
        expect(index).toContain("document.addEventListener('courthouse-activate-tab'");
    });

    test('detail disclosures and close action use native buttons with synchronized state', () => {
        const source = read('public', 'js', 'courthouse-v2', 'detail-panel.js');

        expect(source).toContain('class="dp-card-head dp-toggle-head" aria-expanded="false"');
        expect(source).toContain('aria-controls="dp-judge-transparency-body"');
        expect(source).toContain('aria-controls="dp-model-reasoning-body"');
        expect(source).toContain('class="dp-collapse-body" hidden');
        expect(source).toContain("toggleHead.setAttribute('aria-expanded', isCollapsed ? 'true' : 'false')");
        expect(source).toContain('if (body) body.hidden = !isCollapsed');
        expect(source).toContain('aria-label="Close result details"');
        expect(source).toContain('focusDetailWhenSourceIsHidden');
        expect(source).toContain("detail: { name: 'ledger' }");
    });

    test('normal Courthouse text uses a token with at least 4.5:1 contrast on every dark surface', () => {
        const tokens = read('public', 'css', 'redesign-tokens.css');
        const layout = read('public', 'css', 'courthouse-v2-layout.css');
        const detail = read('public', 'css', 'courthouse-v2-detail.css');
        const scripts = [
            'index.js',
            'review-queue.js',
            'results-ledger.js',
            'discrimination.js',
            'detail-panel.js'
        ].map(file => read('public', 'js', 'courthouse-v2', file)).join('\n');
        const muted = tokens.match(/--r-text-muted:\s*(#[0-9a-f]{6})/i)?.[1];

        expect(muted).toBeTruthy();
        for (const surface of ['#080b12', '#0f1420', '#0a0f18']) {
            expect(contrastRatio(muted, surface)).toBeGreaterThanOrEqual(4.5);
        }
        expect(layout).toContain('.ch-muted-state');
        expect(layout).toContain('color: var(--r-text-muted)');
        expect(detail).toContain('.ledger-open:focus-visible');
        expect(`${layout}\n${detail}`).not.toMatch(/(?:^|[\s;{])color:\s*#(?:333|444|555|666|777)\b/im);
        expect(scripts).not.toMatch(/color\s*:\s*#(?:333|444|555|666|777)\b/i);
    });
});
