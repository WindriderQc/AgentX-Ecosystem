const fs = require('fs');
const path = require('path');
const vm = require('vm');

function loadModule(name, stubs) {
    const filename = path.resolve(__dirname, '../../public/js/benchmark-v2', name);
    const source = fs.readFileSync(filename, 'utf8')
        .replace(/^import .*;\r?\n/gm, '').replace(/export /g, '');
    const context = { ...stubs };
    vm.createContext(context);
    vm.runInContext(source, context, { filename });
    return context;
}

test.each(['completed', 'failed', 'stopped', 'interrupted'])(
    'shows the actual %s state and freezes diagnostics instead of advertising active work', status => {
        const liveLabel = {};
        const eta = {};
        const pipelineDetail = { style: {} };
        const actionZone = loadModule('action-zone.js', {
            document: {
                querySelector: () => liveLabel,
                getElementById: id => id === 'pipe-status' ? pipelineDetail : null,
            },
        });
        const batch = {
            status, completed: 1, total_tests: 3,
            started_at: '2026-09-11T20:00:00Z', completed_at: '2026-09-11T20:01:00Z',
            current_test: { stage: 'executing', phase: 'warmup' },
            judge_status: 'running', judge_total: 3, judge_completed: 1,
            failure_reason: status === 'failed' ? 'Model unavailable' : null,
        };
        actionZone.renderActionZoneLive({ querySelector: id => id === '#eta' ? eta : null }, batch);
        expect(liveLabel.textContent).toBe(status.toUpperCase());
        expect(eta.textContent).toBe('');
        expect(pipelineDetail.textContent).toBe('');

        const setInterval = jest.fn().mockReturnValue(42);
        const clearInterval = jest.fn();
        const detail = loadModule('live-detail.js', {
            setInterval, clearInterval,
            fmtNum: String, fmtMs: String, levelBadge: () => '',
            wireRawCuratedJudgePanes: jest.fn(),
        });
        const container = { innerHTML: '', addEventListener: jest.fn() };
        detail.renderLiveDetail(container, { ...batch, status: 'running' });
        expect(setInterval).toHaveBeenCalledTimes(1);
        detail.updateLiveDetail(container, batch);
        expect(clearInterval).toHaveBeenCalledWith(42);
        expect(setInterval).toHaveBeenCalledTimes(1);
        expect(container.innerHTML).toContain(status.charAt(0).toUpperCase() + status.slice(1));
        expect(container.innerHTML).not.toContain('Generating…');
        expect(container.innerHTML).not.toContain('waiting for generation');
        expect(container.innerHTML).not.toContain('ld-dashboard-active');
        expect(container.innerHTML).toContain('1m 0s');
    }
);
