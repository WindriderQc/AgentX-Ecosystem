const { dataapi, DataApiError } = require('./dataapiClient');

// Minimal, explicit tool bridge (no surprise routing):
// Users can run DataAPI tooling from AgentX chat using slash commands.
async function tryHandleToolCommand(rawMessage) {
    const m = String(rawMessage || '').trim();
    if (!m.startsWith('/dataapi')) return null;

    const parts = m.split(/\s+/);
    // parts[0] == /dataapi
    const domain = parts[1];
    const action = parts[2];
    const rest = parts.slice(3).join(' ').trim();

    if (!domain || !action) {
        return {
            ok: false,
            responseText: 'Usage: /dataapi <files|storage|live> <action> [args]'
        };
    }

    try {
        // FILES
        if (domain === 'files' && action === 'search') {
            if (!rest) return { ok: false, responseText: 'Usage: /dataapi files search <query>' };
            const result = await dataapi.files.search({ q: rest, limit: 50, skip: 0 });
            const hits = result?.data?.results || [];
            const preview = hits.slice(0, 10).map(f => `- ${f.path} (${f.sizeFormatted || f.size || 'n/a'})`).join('\n');
            return {
                ok: true,
                responseText: `DataAPI files.search("${rest}")\n\nTop results:\n${preview || '(no matches)'}\n\nTotal: ${result?.data?.pagination?.total ?? 'n/a'}`,
                tool: { name: 'dataapi.files.search', args: { q: rest } },
                toolResult: result
            };
        }

        if (domain === 'files' && action === 'duplicates') {
            const result = await dataapi.files.duplicates();
            const groups = result?.data?.duplicates || [];
            const summary = result?.data?.summary;
            const preview = groups.slice(0, 5).map(g => `- ${g.filename} (${g.sizeFormatted}) x${g.count} wasted ${g.wastedSpaceFormatted}`).join('\n');
            return {
                ok: true,
                responseText: `DataAPI files.duplicates\n\n${preview || '(no duplicates found in top set)'}\n\nWasted: ${summary?.totalWastedSpaceFormatted || 'n/a'} in ${summary?.totalDuplicateGroups ?? 'n/a'} groups`,
                tool: { name: 'dataapi.files.duplicates', args: {} },
                toolResult: result
            };
        }

        if (domain === 'files' && action === 'export') {
            // /dataapi files export <type> [json|csv]
            const [type = 'summary', format = 'json'] = rest.split(/\s+/).filter(Boolean);
            const result = await dataapi.files.export({ type, format });
            return {
                ok: true,
                responseText: `DataAPI files.export(type=${type}, format=${format})\n\n${JSON.stringify(result?.data || result, null, 2)}`,
                tool: { name: 'dataapi.files.export', args: { type, format } },
                toolResult: result
            };
        }

        // STORAGE
        if (domain === 'storage' && action === 'scan') {
            if (!rest) return { ok: false, responseText: 'Usage: /dataapi storage scan <jsonBody>' };
            let payload;
            try {
                payload = JSON.parse(rest);
            } catch (e) {
                return { ok: false, responseText: `Invalid JSON: ${e.message}` };
            }
            const result = await dataapi.storage.scanStart(payload);
            return {
                ok: true,
                responseText: `DataAPI storage.scanStart\n\nScan started. scan_id=${result?.data?.scan_id || '(unknown)'}`,
                tool: { name: 'dataapi.storage.scanStart', args: payload },
                toolResult: result
            };
        }

        if (domain === 'storage' && action === 'status') {
            if (!rest) return { ok: false, responseText: 'Usage: /dataapi storage status <scan_id>' };
            const result = await dataapi.storage.scanStatus({ scan_id: rest });
            return {
                ok: true,
                responseText: `DataAPI storage.scanStatus(${rest})\n\n${JSON.stringify(result?.data || result, null, 2)}`,
                tool: { name: 'dataapi.storage.scanStatus', args: { scan_id: rest } },
                toolResult: result
            };
        }

        // LIVE
        if (domain === 'live' && action === 'iss') {
            const result = await dataapi.live.iss();
            const rows = Array.isArray(result?.data) ? result.data : [];
            return {
                ok: true,
                responseText: `DataAPI live.iss\n\nRecords: ${rows.length}`,
                tool: { name: 'dataapi.live.iss', args: {} },
                toolResult: result
            };
        }

        if (domain === 'live' && action === 'quakes') {
            const result = await dataapi.live.quakes();
            const rows = Array.isArray(result?.data) ? result.data : [];
            return {
                ok: true,
                responseText: `DataAPI live.quakes\n\nRecords: ${rows.length}`,
                tool: { name: 'dataapi.live.quakes', args: {} },
                toolResult: result
            };
        }

        return { ok: false, responseText: `Unknown command: /dataapi ${domain} ${action}` };
    } catch (err) {
        if (err instanceof DataApiError) {
            return { ok: false, responseText: `DataAPI error: ${err.message}${err.status ? ` (HTTP ${err.status})` : ''}` };
        }
        return { ok: false, responseText: `Tool error: ${err.message}` };
    }
}

module.exports = { tryHandleToolCommand };
