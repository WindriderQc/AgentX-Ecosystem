'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const benchmarkRoot = path.resolve(__dirname, '..', '..');
const read = (...segments) => fs.readFileSync(path.join(benchmarkRoot, ...segments), 'utf8');

function loadApiModule(apiFetch) {
    const sourcePath = path.join(benchmarkRoot, 'public', 'js', 'benchmark-v2', 'api.js');
    let source = fs.readFileSync(sourcePath, 'utf8');
    source = source.replace(/^import .*?;\r?\n/m, '');
    source = source.replace(/export\s+(const|function|async function)\s+/g, '$1 ');
    source += '\nmodule.exports = { deleteTemplate };\n';

    const context = { module: { exports: {} }, exports: {}, apiFetch, URLSearchParams };
    context.global = context;
    context.globalThis = context;
    vm.runInNewContext(source, context, { filename: sourcePath });
    return context.module.exports;
}

function loadScoringReset(fetchMock) {
    const sourcePath = path.join(benchmarkRoot, 'public', 'js', 'benchmark', 'scoring-profile.js');
    let source = fs.readFileSync(sourcePath, 'utf8');
    source = source.replace(/^import .*?;\r?\n/m, '');
    source = source.replace(/export\s+async\s+function\s+/g, 'async function ');
    source += '\nmodule.exports = { resetProfile };\n';

    const context = {
        module: { exports: {} },
        exports: {},
        fetch: fetchMock,
        showToast: jest.fn(),
        document: {}
    };
    context.global = context;
    context.globalThis = context;
    vm.runInNewContext(source, context, { filename: sourcePath });
    return context.module.exports.resetProfile;
}

describe('Benchmark destructive confirmation UI wiring', () => {
    it('sends the target-bound template phrase in the DELETE request body', async () => {
        const apiFetch = jest.fn().mockResolvedValue({ status: 'success' });
        const { deleteTemplate } = loadApiModule(apiFetch);
        const id = '507f1f77bcf86cd799439011';
        const confirmation = `DELETE TEMPLATE ${id}`;

        await deleteTemplate(id, confirmation);

        expect(apiFetch).toHaveBeenCalledWith(`/api/benchmark/templates/${id}`, {
            method: 'DELETE',
            body: { confirm: confirmation }
        });

        const batchConfig = read('public', 'js', 'benchmark-v2', 'batch-config.js');
        expect(batchConfig).toContain('const expectedConfirmation = `DELETE TEMPLATE ${delBtn.dataset.id}`;');
        expect(batchConfig).toContain('const confirmation = window.prompt(');
        expect(batchConfig).toContain('await deleteTemplate(delBtn.dataset.id, confirmation);');
        expect(batchConfig).not.toContain('if (!confirm(`Delete template?`))');
    });

    it('requires typed, action-specific phrases for retention mutations', () => {
        const source = read('public', 'js', 'benchmark-v2', 'data-management.js');

        expect(source).toContain("const expectedConfirmation = 'PURGE DEAD MODEL RESULTS';");
        expect(source).toContain('const expectedConfirmation = `DELETE RESULTS OLDER THAN ${days} DAYS`;');
        expect(source).toContain('confirmation !== expectedConfirmation');
        expect(source.match(/confirm:\s*confirmation/g)).toHaveLength(2);
        expect(source).toContain("postAction('purge-dead', {");
        expect(source).toContain("postAction('archive', {");
    });

    it('sends the typed scoring-profile reset phrase as JSON', async () => {
        const fetchMock = jest.fn().mockResolvedValue({
            json: async () => ({ status: 'success', data: {} })
        });
        const resetProfile = loadScoringReset(fetchMock);

        await resetProfile('RESET SCORING PROFILE');

        expect(fetchMock).toHaveBeenCalledWith('/api/benchmark/scoring-profile/reset', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ confirm: 'RESET SCORING PROFILE' })
        });

        const source = read('public', 'js', 'benchmark', 'scoring-profile.js');
        expect(source).toContain("const SCORING_PROFILE_RESET_CONFIRMATION = 'RESET SCORING PROFILE';");
        expect(source).toContain('const confirmation = window.prompt(');
        expect(source).toContain('await resetProfile(confirmation);');
    });
});
