const {
    getJudgeReadiness,
    resolveReadyJudgeTarget,
    getExplicitGlobalJudgeSelection
} = require('../../src/services/benchmark/judgeReadiness');

const hosts = [
    { id: 'primary', name: 'Alpha', url: 'http://alpha:11434' },
    { id: 'secondary', name: 'Beta', url: 'http://beta:11434' }
];

function inventoryFetch(inventories) {
    return jest.fn(async (url) => {
        const host = url.replace(/\/api\/tags$/, '');
        const value = inventories[host];
        if (value instanceof Error) throw value;
        if (!value) return { ok: false, status: 503 };
        const payload = JSON.stringify({ models: value.map((name) => ({ name })) });
        return {
            ok: true,
            status: 200,
            body: {
                async *[Symbol.asyncIterator]() {
                    yield Buffer.from(payload);
                }
            }
        };
    });
}

describe('authoritative judge readiness', () => {
    test('does not treat product/default chat models as an implicit judge selection', async () => {
        const readiness = await getJudgeReadiness({
            hosts,
            defaults: {},
            config: null,
            env: {
                OLLAMA_HOST: hosts[0].url,
                AGENTX_DEFAULT_CHAT_MODEL: 'chat-default:8b'
            },
            fetchImpl: inventoryFetch({
                [hosts[0].url]: ['chat-default:8b', 'judge-a:7b'],
                [hosts[1].url]: ['judge-b:7b']
            })
        });

        expect(readiness).toMatchObject({
            ready: false,
            status: 'blocked',
            code: 'no_judge_selected',
            configured_host_count: 2,
            reachable_host_count: 2,
            selected_host_count: 0,
            ready_host_count: 0
        });
        expect(readiness.evidence_modes.deterministic.status).toBe('available');
        expect(readiness.evidence_modes.judge_scored.status).toBe('blocked');
        expect(readiness.setup.description).toMatch(/will not download or choose/i);
    });

    test('reports one selected installed judge as degraded but usable', async () => {
        const readiness = await getJudgeReadiness({
            hosts,
            defaults: { [hosts[0].url]: 'judge-a:7b' },
            globalSelection: null,
            fetchImpl: inventoryFetch({
                [hosts[0].url]: ['judge-a:7b', 'other:3b'],
                [hosts[1].url]: new Error('connection refused')
            })
        });

        expect(readiness).toMatchObject({
            ready: true,
            status: 'degraded',
            code: 'partially_ready',
            selected_host_count: 1,
            ready_host_count: 1,
            preferred_target: {
                host: hosts[0].url,
                model: 'judge-a:7b',
                source: 'host-default'
            }
        });
        expect(readiness.hosts[0]).toMatchObject({ ready: true, reason: 'ready' });
        expect(readiness.hosts[1]).toMatchObject({ ready: false, reason: 'host_unreachable' });
    });

    test('recognizes an explicitly saved setup selection', () => {
        expect(getExplicitGlobalJudgeSelection({
            config: { judge: { host: hosts[1].url, model: 'judge-b:7b' } },
            env: {}
        })).toEqual({ host: hosts[1].url, model: 'judge-b:7b', source: 'setup' });
    });

    test('allows an explicitly pinned installed target without silently selecting one', async () => {
        const common = {
            hosts,
            defaults: {},
            globalSelection: null,
            fetchImpl: inventoryFetch({
                [hosts[0].url]: ['judge-a:7b'],
                [hosts[1].url]: ['judge-b:7b']
            })
        };

        const explicit = await resolveReadyJudgeTarget({
            host: hosts[1].url,
            model: 'judge-b:7b'
        }, common);
        expect(explicit).toMatchObject({
            ready: true,
            target: { host: hosts[1].url, model: 'judge-b:7b', source: 'request' }
        });
        expect(common.fetchImpl).toHaveBeenCalled();
        for (const [, options] of common.fetchImpl.mock.calls) {
            expect(options).toMatchObject({ method: 'GET', redirect: 'manual' });
        }

        const incomplete = await resolveReadyJudgeTarget({ model: 'judge-b:7b' }, common);
        expect(incomplete).toMatchObject({
            ready: false,
            code: 'incomplete_judge_target',
            target: null
        });
    });

    test.each([
        ['credentials', 'http://operator:secret@alpha:11434', 'invalid_judge_target'],
        ['a path/fragment SSRF payload', 'http://alpha:11434/api/tags#http://169.254.169.254/latest/meta-data', 'invalid_judge_target'],
        ['a query-string payload', 'http://alpha:11434/?next=http://169.254.169.254/latest/meta-data', 'invalid_judge_target'],
        ['an arbitrary port', 'http://alpha:4312', 'invalid_judge_target'],
        ['an unconfigured host', 'http://attacker:11434', 'judge_host_not_configured']
    ])('rejects %s before any inventory fetch', async (_label, host, expectedCode) => {
        const fetchImpl = jest.fn();

        const check = await resolveReadyJudgeTarget({ host, model: 'judge-a:7b' }, {
            hosts,
            defaults: {},
            globalSelection: null,
            env: {},
            fetchImpl
        });

        expect(check).toMatchObject({
            ready: false,
            code: expectedCode,
            target: null,
            readiness: null
        });
        expect(fetchImpl).not.toHaveBeenCalled();
    });

    test('rejects an explicit model that is not installed on the configured host', async () => {
        const check = await resolveReadyJudgeTarget({
            host: hosts[0].url,
            model: 'missing:14b'
        }, {
            hosts,
            defaults: {},
            globalSelection: null,
            fetchImpl: inventoryFetch({
                [hosts[0].url]: ['judge-a:7b'],
                [hosts[1].url]: ['judge-b:7b']
            })
        });

        expect(check).toMatchObject({
            ready: false,
            code: 'judge_model_unavailable',
            target: null
        });
        expect(check.error).toMatch(/not installed/i);
    });
});
