(function () {
    'use strict';

    const shared = window.NerveCenterShared;

    function extractIpFromUrl(url) {
        if (!url) return '';
        try {
            return new URL(url).hostname || '';
        } catch {
            const match = String(url).match(/^(?:https?:\/\/)?([^/:?#]+)/i);
            return match ? match[1] : '';
        }
    }

    // One-line GPU summary for the host card header. Multi-GPU hosts get a
    // ×count suffix when the cards are identical (e.g. "NVIDIA GeForce RTX
    // 3090 ×2") so the name isn't silently truncated to gpus[0] next to a
    // *summed* VRAM total — otherwise "RTX 3090 | 48.0GB" reads as one 48GB
    // card. Mixed GPUs are joined with " + ".
    function summarizeGpuNames(gpus) {
        const names = (gpus || []).map(g => (g && g.name) || '').filter(Boolean);
        if (names.length === 0) return '';
        if (names.length === 1) return names[0];
        return names.every(n => n === names[0])
            ? `${names[0]} ×${names.length}`
            : names.join(' + ');
    }

    function normalizePinnedEntries(pref) {
        const entries = Array.isArray(pref?.pinnedModels) ? pref.pinnedModels : [];
        return entries
            .filter(e => e && e.model)
            .map(e => ({
                model: e.model,
                keepAlive: typeof e.keepAlive === 'number' ? e.keepAlive : -1,
                contextSize: typeof e.contextSize === 'number' ? e.contextSize : 0,
                autoRestore: e.autoRestore !== false
            }));
    }

    function mergeHostData(ollama, doc, cfg, mem, pref) {
        const hostname = ollama.hostname || doc.hostname || cfg.name || '--';
        const configuredIp = extractIpFromUrl(cfg.url || pref?.hostUrl || ollama.ollamaUrl || doc.ollamaUrl || '');
        const ip = configuredIp;
        const hostKey = ollama.ollamaHostKey || cfg.id || '';

        const ollamaStatus = ollama.ollamaStatus || mem.status || '';
        const docStatus = doc.status || 'offline';
        let status = 'offline';
        if (ollamaStatus === 'online' && docStatus === 'online') status = 'online';
        else if (ollamaStatus === 'online' || docStatus === 'online') status = 'online';
        else if (docStatus === 'degraded') status = 'degraded';

        const gpus = doc.gpus || [];
        const gpuName = summarizeGpuNames(gpus);
        const gpuTemp = gpus.length > 0 ? gpus[0].temperature : null;
        const gpuUtil = gpus.length > 0 ? gpus[0].utilization : null;

        const preferenceRunningModels = Array.isArray(pref?.live?.runningModels)
            ? pref.live.runningModels
            : [];
        const ollamaRunningModels = Array.isArray(ollama.ollamaRunningModels)
            ? ollama.ollamaRunningModels
            : [];
        const memoryRunningModels = Array.isArray(mem.runningModels) ? mem.runningModels : [];
        const runningModels = ollamaRunningModels.length > 0
            ? ollamaRunningModels
            : (preferenceRunningModels.length > 0 ? preferenceRunningModels : memoryRunningModels);

        const loadedModelVramMiB = Math.round(runningModels.reduce((sum, model) => {
            const bytes = Number(model?.sizeVram ?? model?.size_vram ?? 0);
            return sum + (Number.isFinite(bytes) && bytes > 0 ? bytes : 0);
        }, 0) / (1024 * 1024));

        const ollamaVram = ollama.ollamaVram || doc.ollamaVram || {};
        let vramTotalMiB = Number(ollamaVram.totalMiB)
            || Number(pref?.vramTotalMiB)
            || Number(pref?.gpu?.vramTotalMiB)
            || 0;
        let vramUsedMiB = Number(ollamaVram.usedMiB) || loadedModelVramMiB;
        if (vramTotalMiB === 0 && gpus.length > 0) {
            vramTotalMiB = gpus.reduce((sum, gpu) => sum + (gpu.vramTotal || 0), 0);
            vramUsedMiB = gpus.reduce((sum, gpu) => sum + (gpu.vramUsed || 0), 0);
        }

        return {
            hostKey,
            hostname,
            ip,
            configuredIp,
            status,
            gpuName,
            gpuTemp,
            gpuUtil,
            gpus,
            vramTotalMiB,
            vramUsedMiB,
            runningModels,
            availableModels: ollama.ollamaModels || mem.models || [],
            cpuUsage: doc.cpu?.usage ?? null,
            memUsage: doc.memory?.usagePercent ?? null,
            memTotal: doc.memory?.total || 0,
            memUsed: doc.memory?.used || 0,
            ollamaVersion: ollama.ollamaVersion || mem.version || '',
            ollamaLatency: ollama.ollamaLatencyMs ?? mem.latencyMs ?? null,
            ollamaStatus,
            lastChecked: ollama.ollamaLastChecked || pref?.live?.observedAt || null,
            lastSeen: doc.lastSeen || null,
            uptime: doc.uptime || 0,
            disks: doc.disks || [],
            nvidia: doc?.nvidia || null,
            swap: doc?.swap || null,
            ollamaService: doc?.ollamaService || null,
            // Host preference fields — canonical post-0158 shape uses
            // `pinnedEntries` (array of {model,keepAlive,contextSize,autoRestore}).
            // `primaryPin` is the first entry for single-pin UI semantics.
            pinnedEntries: normalizePinnedEntries(pref),
            maxConcurrentModels: pref?.maxConcurrentModels || 1,
            driftModels: pref?.driftModels || [],
            hostUrl: pref?.hostUrl || '',
            prefDisplayName: pref?.displayName || '',
            prefGpuModel: pref?.gpu?.model || '',
            prefLive: pref?.live || {},
            pinStatus: pref?.status || 'idle',
            pinLive: pref?.live?.pinnedLoaded ?? null,
        };
    }

    function buildMiniBar(label, percent) {
        const rounded = Math.round(percent);
        const color = rounded > 85 ? 'var(--danger)' : rounded > 60 ? '#f59e0b' : 'var(--success)';
        return `
            <div style="flex:1;min-width:0;">
                <div style="display:flex;justify-content:space-between;font-size:10px;color:var(--muted);margin-bottom:2px;">
                    <span>${label}</span><span>${rounded}%</span>
                </div>
                <div style="width:100%;height:4px;background:rgba(255,255,255,0.06);border-radius:2px;overflow:hidden;">
                    <div style="width:${rounded}%;height:100%;background:${color};border-radius:2px;transition:width 0.5s ease;"></div>
                </div>
            </div>`;
    }

    function buildHostDetail(host) {
        let html = '';

        if (host.gpus.length > 0) {
            html += '<div class="nc-fs-11b">GPUs</div>';
            html += '<table style="width:100%;font-size:11px;border-collapse:collapse;margin-bottom:10px;">';
            host.gpus.forEach((gpu, index) => {
                const totalGb = (gpu.vramTotal / 1024).toFixed(1);
                const usedGb = (gpu.vramUsed / 1024).toFixed(1);
                const percent = gpu.vramTotal > 0 ? Math.round((gpu.vramUsed / gpu.vramTotal) * 100) : 0;
                html += `
                    <tr style="border-bottom:1px solid rgba(255,255,255,0.04);">
                        <td style="padding:4px 0;color:var(--muted);">GPU ${gpu.index != null ? gpu.index : index}</td>
                        <td style="padding:4px 6px;">${shared.escapeHtml(gpu.name || '--')}</td>
                        <td class="nc-td-right-sm">${usedGb} / ${totalGb} GB (${percent}%)</td>
                        ${gpu.temperature != null ? `<td class="nc-td-right-sm">${gpu.temperature}&deg;C</td>` : '<td></td>'}
                        ${gpu.utilization != null ? `<td class="nc-td-right-sm">${gpu.utilization}% util</td>` : '<td></td>'}
                    </tr>`;
            });
            html += '</table>';
        }

        if (host.runningModels.length > 0) {
            html += '<div class="nc-fs-11b">Loaded Models</div>';
            html += '<table style="width:100%;font-size:11px;border-collapse:collapse;margin-bottom:10px;">';
            host.runningModels.forEach(model => {
                if (typeof model === 'string') {
                    html += `<tr><td style="padding:3px 0;"><span class="nc-model-tag">${shared.escapeHtml(shared.shortModel(model))}</span></td></tr>`;
                    return;
                }

                const sizeGb = model.size ? `${(model.size / (1024 * 1024 * 1024)).toFixed(2)} GB` : '--';
                const vramGb = model.size_vram ? `${(model.size_vram / (1024 * 1024 * 1024)).toFixed(2)} GB` : '--';
                html += `
                    <tr style="border-bottom:1px solid rgba(255,255,255,0.04);">
                        <td style="padding:4px 0;"><span class="nc-model-tag">${shared.escapeHtml(shared.shortModel(model.name))}</span></td>
                        <td class="nc-td-muted-sm">Size: ${sizeGb}</td>
                        <td class="nc-td-muted-sm">VRAM: ${vramGb}</td>
                        <td class="nc-td-muted-sm">Expires: ${shared.timeAgo(model.expires_at)}</td>
                    </tr>`;
            });
            html += '</table>';
        }

        if (host.availableModels.length > 0) {
            html += `<div style="font-size:11px;color:var(--muted);margin-bottom:6px;">${host.availableModels.length} available model${host.availableModels.length !== 1 ? 's' : ''}</div>`;
        }

        const systemRows = [];
        if (host.ollamaVersion) systemRows.push(['Ollama', `v${host.ollamaVersion}`]);
        if (host.uptime > 0) systemRows.push(['Uptime', shared.formatUptime(host.uptime)]);
        if (host.lastSeen) systemRows.push(['Last Heartbeat', shared.timeAgo(host.lastSeen)]);
        if (host.lastChecked) systemRows.push(['Ollama Checked', shared.timeAgo(host.lastChecked)]);
        if (host.configuredIp) systemRows.push(['Configured IP', host.configuredIp]);

        if (host.disks.length > 0) {
            const mainDisk = host.disks.find(disk => disk.mount === '/') || host.disks[0];
            if (mainDisk) {
                const totalGb = (mainDisk.total / (1024 * 1024 * 1024)).toFixed(0);
                systemRows.push(['Disk (' + mainDisk.mount + ')', `${mainDisk.usagePercent || 0}% of ${totalGb} GB`]);
            }
        }

        if (systemRows.length > 0) {
            html += '<div class="nc-fs-11b">System</div>';
            html += '<table style="width:100%;font-size:11px;border-collapse:collapse;">';
            systemRows.forEach(([label, value]) => {
                html += `
                    <tr>
                        <td style="padding:3px 0;color:var(--muted);width:40%;">${shared.escapeHtml(label)}</td>
                        <td style="padding:3px 0;">${shared.escapeHtml(value)}</td>
                    </tr>`;
            });
            html += '</table>';
        }

        // GPU Processes table
        const procs = host.nvidia?.processes || [];
        const gpuProcsHtml = procs.length > 0
          ? `<div style="margin-top:8px;"><strong style="font-size:0.8rem;">GPU Processes</strong>
              <table style="width:100%;font-size:0.8rem;margin-top:4px;border-collapse:collapse;">
                <tr style="color:var(--muted);font-size:0.72rem;text-transform:uppercase;">
                  <td style="padding:2px 6px;">PID</td><td>Process</td><td class="nc-td-right">VRAM</td>
                </tr>
                ${procs.map(p => `<tr><td style="padding:2px 6px;">${p.pid}</td><td>${shared.escapeHtml(p.name)}</td><td class="nc-td-right">${p.vramMiB} MiB</td></tr>`).join('')}
              </table></div>`
          : '';
        html += gpuProcsHtml;

        return html || '<div style="font-size:11px;color:var(--muted);">No additional details available</div>';
    }

    function isPinnedModelLoaded(host, model) {
        return (host.runningModels || []).some(rm => {
            const rmName = typeof rm === 'string' ? rm : (rm.name || '');
            return rmName === model || rmName.startsWith(model + ':');
        });
    }

    function buildPinnedModelChip(host, entry, index, options = {}) {
        const m = entry.model;
        const loaded = isPinnedModelLoaded(host, m);
        const isPrimary = index === 0;
        const allowRemove = options.allowRemove !== false;
        const isDrift = (host.driftModels || []).includes(m);
        const icon = isPrimary ? 'fa-thumbtack' : (loaded ? 'fa-circle-check' : 'fa-circle-pause');
        const color = loaded ? 'color:#4ade80;' : 'color:#f59e0b;';
        const driftBadge = isDrift
            ? '<i class="fas fa-triangle-exclamation nc-drift-icon" title="Not used by any task routing - may be phantom-loading"></i>'
            : '';
        return '<span class="nc-model-tag default nc-pinned-chip' + (isPrimary ? ' primary' : '') + (isDrift ? ' drift' : '') + '">' +
            '<i class="fas ' + icon + '" style="' + color + 'font-size:9px;" title="' + (loaded ? 'Loaded' : 'Not loaded') + '"></i>' +
            '<span>' + shared.escapeHtml(shared.shortModel(m)) + '</span>' +
            driftBadge +
            (allowRemove ? '<button class="nc-pref-remove-default" data-host-url="' + shared.escapeHtml(host.hostUrl) + '" data-model="' + shared.escapeHtml(m) + '"' +
                ' title="Remove from pinned set">' +
                '<i class="fas fa-xmark"></i></button>' : '') +
            '</span>';
    }

    function buildPinnedModelsSection(host) {
        const pinnedEntries = host.pinnedEntries || [];
        const pinnedNames = pinnedEntries.map(e => e.model);
        const availableOptions = host.availableModels
            .filter(am => {
                const name = typeof am === 'string' ? am : am.name;
                return !pinnedNames.includes(name);
            })
            .map(am => {
                const name = typeof am === 'string' ? am : am.name;
                return '<option value="' + shared.escapeHtml(name) + '">' + shared.escapeHtml(shared.shortModel(name)) + '</option>';
            }).join('');

        if (pinnedEntries.length === 0) {
            return '<div class="nc-defaults-panel nc-pinned-panel">' +
                '<div class="nc-pinned-header">' +
                    '<div class="nc-pinned-title">' +
                        '<span class="nc-defaults-label">Pinned Models</span>' +
                        '<span class="nc-pinned-note">None configured</span>' +
                    '</div>' +
                '</div>' +
                '<div class="nc-pinned-empty-row">' +
                    '<select class="nc-inline-select nc-pin-model-select" aria-label="Choose primary pinned model" data-host-url="' + shared.escapeHtml(host.hostUrl) + '">' +
                        '<option value="">Choose primary pin...</option>' + availableOptions +
                    '</select>' +
                    '<button type="button" class="nc-btn nc-pin-set nc-btn-icon" data-host-url="' + shared.escapeHtml(host.hostUrl) + '" title="Set primary pinned model" aria-label="Set primary pinned model">' +
                        '<i class="fas fa-thumbtack"></i>' +
                    '</button>' +
                '</div>' +
            '</div>';
        }

        // The first pinned entry is the primary pin; all entries share the
        // same keep-alive selector because the API stores one canonical set.
        const primaryEntry = pinnedEntries[0];
        const primaryPin = primaryEntry.model;
        const primaryKeepAlive = primaryEntry.keepAlive ?? -1;
        const primaryAutoRestore = primaryEntry.autoRestore !== false;
        const secondaryTags = pinnedEntries
            .slice(1)
            .map((entry, offset) => buildPinnedModelChip(host, entry, offset + 1))
            .join(' ');

        const slotOptions = [1, 2, 3, 4].map(n =>
            `<option value="${n}" ${n === host.maxConcurrentModels ? 'selected' : ''}>${n}</option>`
        ).join('');

        const keepAliveOptions = [-1, 0, 300, 600, 1800, 3600].map(v => {
            const label = v === -1 ? '∞' : v === 0 ? 'Off' : (v >= 3600 ? (v / 3600) + 'h' : (v / 60) + 'm');
            return `<option value="${v}" ${v === primaryKeepAlive ? 'selected' : ''}>${label}</option>`;
        }).join('');

        const statusColors = {
            ready: '#4ade80',
            swapping: '#f59e0b',
            restoring: '#f59e0b',
            offline: '#f87171',
            idle: '#6b7280'
        };
        const statusColor = statusColors[host.pinStatus] || statusColors.idle;
        const statusLabel = host.pinStatus.charAt(0).toUpperCase() + host.pinStatus.slice(1);

        const modelOptions = (host.availableModels || []).map(am => {
            const name = typeof am === 'string' ? am : am.name;
            return '<option value="' + shared.escapeHtml(name) + '">' + shared.escapeHtml(shared.shortModel(name)) + '</option>';
        }).join('');

        const loadedModel = host.runningModels.length > 0
            ? (typeof host.runningModels[0] === 'string' ? host.runningModels[0] : host.runningModels[0]?.name || '--')
            : null;
        const pinMatch = loadedModel && (loadedModel === primaryPin || loadedModel.startsWith(primaryPin + ':'));
        const loadedLine = loadedModel
            ? (pinMatch
                ? '<span style="color:#4ade80;font-size:11px;"><i class="fas fa-circle-check" style="font-size:9px;"></i> ' + shared.escapeHtml(shared.shortModel(loadedModel)) + '</span>'
                : '<span style="color:#f59e0b;font-size:11px;"><i class="fas fa-triangle-exclamation" style="font-size:9px;"></i> Loaded: ' + shared.escapeHtml(shared.shortModel(loadedModel)) + '</span>')
            : '<span style="color:#6b7280;font-size:11px;">Nothing loaded</span>';

        return '<div class="nc-defaults-panel nc-pinned-panel">' +
            '<div class="nc-pinned-header">' +
                '<div class="nc-pinned-title">' +
                    '<span class="nc-defaults-label">Pinned Models</span>' +
                    '<span class="nc-pinned-note">' + pinnedEntries.length + ' configured</span>' +
                '</div>' +
                '<div class="nc-pinned-controls">' +
                    '<label class="nc-defaults-slots" title="Maximum models this host may keep loaded together">' +
                        '<span>Slots</span>' +
                        '<select class="nc-inline-select nc-pref-max-select nc-pref-slot-select" data-host-url="' + shared.escapeHtml(host.hostUrl) + '">' +
                            slotOptions +
                        '</select>' +
                    '</label>' +
                    '<label class="nc-defaults-slots" title="keep_alive duration sent to Ollama for pinned models">' +
                        '<span>Keep-Alive</span>' +
                        '<select class="nc-inline-select nc-pref-keepalive-select" data-host-url="' + shared.escapeHtml(host.hostUrl) + '">' +
                            keepAliveOptions +
                        '</select>' +
                    '</label>' +
                '</div>' +
            '</div>' +
            '<div class="nc-pinned-primary-row">' +
                '<div class="nc-pinned-primary-main">' +
                    '<span class="nc-pinned-field-label">Primary</span>' +
                    buildPinnedModelChip(host, primaryEntry, 0, { allowRemove: false }) +
                    '<span class="nc-pin-status-badge" style="background:' + statusColor + '22;color:' + statusColor + ';">' + statusLabel + '</span>' +
                '</div>' +
                '<div class="nc-pinned-button-row">' +
                    '<button class="nc-btn nc-pin-restore nc-btn-icon" data-host-url="' + shared.escapeHtml(host.hostUrl) + '" title="Restore pinned model"' +
                        (host.pinStatus === 'restoring' ? ' disabled' : '') + '>' +
                        '<i class="fas fa-rotate-left"></i>' +
                    '</button>' +
                    '<button class="nc-btn nc-pin-clear nc-btn-icon" data-host-url="' + shared.escapeHtml(host.hostUrl) + '" title="Clear pinned set" style="color:rgba(248,113,113,0.8);">' +
                        '<i class="fas fa-xmark"></i>' +
                    '</button>' +
                '</div>' +
            '</div>' +
            (secondaryTags ? '<div class="nc-pinned-secondary-row">' +
                '<span class="nc-pinned-field-label">Also pinned</span>' +
                '<div class="nc-model-tag-row">' + secondaryTags + '</div>' +
            '</div>' : '') +
            '<div class="nc-pinned-runtime-row">' +
                '<div class="nc-pinned-loaded-now">' +
                    '<span class="nc-pinned-field-label">Loaded now</span>' +
                    loadedLine +
                '</div>' +
                '<div class="nc-pinned-swap-controls">' +
                    '<select class="nc-inline-select nc-pin-swap-select" data-host-url="' + shared.escapeHtml(host.hostUrl) + '">' +
                        '<option value="">Swap to...</option>' + modelOptions +
                    '</select>' +
                    '<button class="nc-btn nc-pin-swap nc-btn-icon" data-host-url="' + shared.escapeHtml(host.hostUrl) + '" title="Temporarily swap loaded model">' +
                        '<i class="fas fa-arrows-rotate"></i>' +
                    '</button>' +
                '</div>' +
            '</div>' +
            '<div class="nc-defaults-actions nc-pinned-add-row">' +
                '<select class="nc-inline-select nc-pref-add-select nc-pref-add-select-wide" data-host-url="' + shared.escapeHtml(host.hostUrl) + '">' +
                    '<option value="">Add pinned model...</option>' + availableOptions +
                '</select>' +
                '<button class="nc-btn nc-pref-add-default nc-btn-icon" data-host-url="' + shared.escapeHtml(host.hostUrl) + '" title="Add pinned model">' +
                    '<i class="fas fa-plus"></i>' +
                '</button>' +
                '<button class="nc-btn nc-pref-reload nc-btn-icon" data-host-url="' + shared.escapeHtml(host.hostUrl) + '" title="Warm pinned models now">' +
                    '<i class="fas fa-rotate-left"></i>' +
                '</button>' +
                '<label class="nc-pinned-autorestore" title="Automatically restore pinned models when health check detects they were evicted">' +
                    '<input type="checkbox" class="nc-pin-autorestore" data-host-url="' + shared.escapeHtml(host.hostUrl) + '"' +
                        (primaryAutoRestore ? ' checked' : '') + ' style="margin:0;">' +
                    '<span>Auto restore</span>' +
                '</label>' +
            '</div>' +
        '</div>';
    }

    function buildHostCard(host) {
        const vramPercent = host.vramTotalMiB > 0 ? Math.round((host.vramUsedMiB / host.vramTotalMiB) * 100) : 0;
        const vramClass = vramPercent > 85 ? 'danger' : vramPercent > 60 ? 'warning' : '';
        const vramTotalGb = (host.vramTotalMiB / 1024).toFixed(1);
        const vramUsedGb = (host.vramUsedMiB / 1024).toFixed(1);
        const gpuLine = host.gpuName ? `${host.gpuName}${host.vramTotalMiB > 0 ? ` | ${vramTotalGb}GB` : ''}` : '';
        const modelTags = host.runningModels.length > 0
            ? host.runningModels.map(model => {
                const name = typeof model === 'string' ? model : (model.name || '--');
                return `<span class="nc-model-tag">${shared.escapeHtml(shared.shortModel(name))}</span>`;
            }).join(' ')
            : '<span style="font-size:11px;color:var(--muted);">No models loaded</span>';

        // Optional runtime metadata, when provided by the configured endpoint.
        const nvidia = host.nvidia;
        const nGpu = nvidia?.gpus?.[0];
        const gpuTempValue = nGpu?.temperature ?? host.gpuTemp;
        const tempLine = gpuTempValue != null
          ? `<span class="nc-host-chip" title="GPU Temperature"><i class="fas fa-temperature-three-quarters"></i> ${Math.round(gpuTempValue)}°C</span>`
          : '';
        const powerLine = nGpu?.powerDraw != null
          ? `<span class="nc-host-chip" title="GPU Power"><i class="fas fa-bolt"></i> ${Math.round(nGpu.powerDraw)}W / ${Math.round(nGpu.powerLimit)}W</span>`
          : '';
        const fanLine = nGpu?.fanSpeed != null
          ? `<span class="nc-host-chip ${nGpu.fanSpeed > 85 ? 'warn' : ''}" title="Fan Speed"><i class="fas fa-fan"></i> ${nGpu.fanSpeed}%</span>`
          : '';
        const driverLine = nvidia?.driverVersion
          ? `<span class="nc-host-chip" title="NVIDIA Driver">drv ${shared.escapeHtml(nvidia.driverVersion)}</span>`
          : '';
        // Severity-tiered throttle badges: thermal = danger, power = warn, idle = hidden
        const throttleReasons = (nGpu?.throttleReasons || []).filter(r => r !== 'idle');
        const hasThermal = throttleReasons.includes('thermal');
        const throttleBadge = hasThermal
          ? `<span class="nc-host-chip danger" title="${shared.escapeHtml(throttleReasons.join(', '))}"><i class="fas fa-triangle-exclamation"></i> THROTTLED</span>`
          : throttleReasons.length > 0
            ? `<span class="nc-host-chip warn" title="${shared.escapeHtml(throttleReasons.join(', '))}"><i class="fas fa-bolt"></i> POWER CAP</span>`
            : '';

        const svcStatus = host.ollamaService?.status;
        const svcDot = svcStatus === 'running'
          ? '<span style="color:#4ade80;font-size:8px;margin-right:3px;" title="Ollama service running">&#9679;</span>'
          : svcStatus === 'failed'
            ? '<span style="color:#f87171;font-size:8px;margin-right:3px;" title="Ollama service failed">&#9679;</span>'
            : '';
        const svcUptime = (svcStatus === 'running' && host.ollamaService?.uptimeSeconds)
          ? `<span style="font-size:0.7rem;color:var(--muted);margin-left:4px;">up ${shared.formatUptime(host.ollamaService.uptimeSeconds)}</span>`
          : '';

        const swapLine = (host.swap?.used > 0)
          ? buildMiniBar('Swap', Math.round((host.swap.used / host.swap.total) * 100))
          : '';

        const ollamaOk = host.ollamaStatus === 'online';
        const ollamaIndicator = `<span class="nc-host-ollama ${ollamaOk ? 'ok' : 'down'}">
            ${svcDot}<i class="fas fa-${ollamaOk ? 'check-circle' : 'times-circle'}"></i>
            Ollama ${ollamaOk ? 'OK' : 'Down'}${host.ollamaLatency != null && ollamaOk ? ` &middot; ${host.ollamaLatency}ms` : ''}${svcUptime}
        </span>`;

        return `
            <div class="nc-host-card" data-host="${shared.escapeHtml(host.hostKey)}" style="cursor:pointer;">
                <div class="nc-host-card-header">
                    <div class="nc-host-card-title">
                        <span class="nc-status-dot ${host.status}"></span>
                        <span class="nc-host-card-name">${shared.escapeHtml(host.hostname)}</span>
                        ${host.hostKey ? `<span class="nc-host-key-badge">${shared.escapeHtml(host.hostKey)}</span>` : ''}
                    </div>
                    <div class="nc-host-card-status">${ollamaIndicator}</div>
                </div>
                <div class="nc-host-meta">
                    <div class="nc-host-meta-line">
                        ${host.ip ? `<span>${shared.escapeHtml(host.ip)}</span>` : ''}
                        ${gpuLine ? `<span>${shared.escapeHtml(gpuLine)}</span>` : ''}
                    </div>
                    <div class="nc-host-chip-row">
                        ${tempLine}${powerLine}${fanLine}${driverLine}${throttleBadge}
                    </div>
                </div>
                <div class="nc-host-card-main">
                    <div class="nc-host-loaded-models">${modelTags}</div>
                    ${host.vramTotalMiB > 0 ? `
                        <div class="nc-host-vram-section">
                            <div class="nc-vram-bar-track">
                                <div class="nc-vram-bar-fill ${vramClass}" style="width:${vramPercent}%;"></div>
                            </div>
                            <div class="nc-host-vram-labels">
                                <span>VRAM ${vramUsedGb} / ${vramTotalGb} GB</span>
                                <span>${vramPercent}%</span>
                            </div>
                        </div>
                    ` : '<div class="nc-host-vram-section"><div style="font-size:10px;color:var(--muted);">VRAM data unavailable</div></div>'}
                    ${(host.cpuUsage !== null || host.memUsage !== null) ? `
                        <div class="nc-host-mini-meters">
                            <div class="nc-mini-bar-grid">
                                ${host.cpuUsage !== null ? buildMiniBar('CPU', host.cpuUsage) : ''}
                                ${host.memUsage !== null ? buildMiniBar('RAM', host.memUsage) : ''}
                                ${swapLine}
                            </div>
                        </div>
                    ` : ''}
                    ${buildPinnedModelsSection(host)}
                </div>
                <div class="nc-host-detail" style="display:none;border-top:1px solid var(--panel-border);margin-top:10px;padding-top:10px;">
                    ${buildHostDetail(host)}
                </div>
                <div style="text-align:center;margin-top:6px;">
                    <i class="fas fa-chevron-down nc-expand-icon" style="font-size:10px;color:var(--muted);transition:transform 0.2s;"></i>
                </div>
            </div>`;
    }

    function buildClusterGrid(cards) {
        return `<div class="nc-host-cards">${cards.map(buildHostCard).join('')}</div>`;
    }

    function attachHostCardHandlers() {
        document.querySelectorAll('.nc-host-card[data-host]').forEach(card => {
            card.addEventListener('click', event => {
                if (event.target.closest('button, a, select, input')) return;
                const detail = card.querySelector('.nc-host-detail');
                const icon = card.querySelector('.nc-expand-icon');
                if (!detail) return;

                const isVisible = detail.style.display !== 'none';
                detail.style.display = isVisible ? 'none' : 'block';
                if (icon) {
                    icon.style.transform = isVisible ? 'rotate(0deg)' : 'rotate(180deg)';
                }
            });
        });
    }

    function attachClusterPreferenceHandlers() {
        // Max concurrent models selector
        document.querySelectorAll('.nc-pref-max-select').forEach(select => {
            select.addEventListener('change', async () => {
                const hostUrl = select.dataset.hostUrl;
                const maxConcurrentModels = parseInt(select.value, 10);
                try {
                    const data = await shared.fetchJson(`/api/nerve-center/host-preferences/${encodeURIComponent(hostUrl)}`, {
                        method: 'PUT',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ maxConcurrentModels })
                    });
                    if (data.status === 'success') {
                        window.NerveCenterCluster?.loadCluster();
                    }
                } catch (err) {
                    console.error('Failed to update max concurrent:', err);
                }
            });
        });

        // Fetch the current pinnedModels array from the server so we can
        // mutate it atomically and PUT the full canonical shape back. The
        // back-compat translation layer was retired in task 0158 — the
        // server now only accepts `pinnedModels: [...]`.
        async function fetchCurrentPinnedModels(hostUrl) {
            const data = await shared.fetchJson('/api/nerve-center/host-preferences');
            const prefs = (data && data.data) || [];
            const match = prefs.find(p => p.hostUrl === hostUrl);
            const entries = Array.isArray(match?.pinnedModels) ? match.pinnedModels : [];
            return entries
                .filter(e => e && e.model)
                .map(e => ({
                    model: e.model,
                    keepAlive: typeof e.keepAlive === 'number' ? e.keepAlive : -1,
                    contextSize: typeof e.contextSize === 'number' ? e.contextSize : 0,
                    autoRestore: e.autoRestore !== false
                }));
        }

        // Keep-alive selector — applies to every pinned entry on this host.
        document.querySelectorAll('.nc-pref-keepalive-select').forEach(select => {
            select.addEventListener('change', async () => {
                const hostUrl = select.dataset.hostUrl;
                const keepAlive = parseInt(select.value, 10);
                try {
                    const current = await fetchCurrentPinnedModels(hostUrl);
                    const pinnedModels = current.map(e => ({ ...e, keepAlive }));
                    const data = await shared.fetchJson(`/api/nerve-center/host-preferences/${encodeURIComponent(hostUrl)}`, {
                        method: 'PUT',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ pinnedModels })
                    });
                    if (data.status === 'success') {
                        window.NerveCenterCluster?.loadCluster();
                    }
                } catch (err) {
                    console.error('Failed to update keepAlive:', err);
                }
            });
        });

        // Add pinned model — appends a new entry with sensible defaults.
        document.querySelectorAll('.nc-pref-add-default').forEach(button => {
            button.addEventListener('click', async () => {
                const hostUrl = button.dataset.hostUrl;
                const select = document.querySelector(`.nc-pref-add-select[data-host-url="${CSS.escape(hostUrl)}"]`);
                const model = select?.value;
                if (!model) return;
                button.disabled = true;
                try {
                    const current = await fetchCurrentPinnedModels(hostUrl);
                    if (!current.some(e => e.model === model)) {
                        current.push({
                            model,
                            keepAlive: current[0]?.keepAlive ?? -1,
                            contextSize: 0,
                            autoRestore: true
                        });
                    }
                    await shared.fetchJson(`/api/nerve-center/host-preferences/${encodeURIComponent(hostUrl)}`, {
                        method: 'PUT',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ pinnedModels: current })
                    });
                    window.NerveCenterCluster?.loadCluster();
                } catch (err) {
                    console.error('Failed to add default:', err);
                } finally {
                    button.disabled = false;
                }
            });
        });

        // Remove pinned model
        document.querySelectorAll('.nc-pref-remove-default').forEach(button => {
            button.addEventListener('click', async () => {
                const hostUrl = button.dataset.hostUrl;
                const model = button.dataset.model;
                button.disabled = true;
                try {
                    const current = await fetchCurrentPinnedModels(hostUrl);
                    const pinnedModels = current.filter(e => e.model !== model);
                    await shared.fetchJson(`/api/nerve-center/host-preferences/${encodeURIComponent(hostUrl)}`, {
                        method: 'PUT',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ pinnedModels })
                    });
                    window.NerveCenterCluster?.loadCluster();
                } catch (err) {
                    console.error('Failed to remove default:', err);
                } finally {
                    button.disabled = false;
                }
            });
        });

        // Warm pinned models
        document.querySelectorAll('.nc-pref-reload').forEach(button => {
            button.addEventListener('click', async () => {
                const hostUrl = button.dataset.hostUrl;
                button.disabled = true;
                const origHtml = button.innerHTML;
                button.innerHTML = '<i class="fas fa-spinner fa-spin"></i>';
                try {
                    await shared.fetchJson(`/api/nerve-center/host-preferences/${encodeURIComponent(hostUrl)}/reload`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' }
                    });
                    setTimeout(() => window.NerveCenterCluster?.loadCluster(), 2000);
                } catch (err) {
                    console.error('Failed to reload defaults:', err);
                } finally {
                    button.disabled = false;
                    button.innerHTML = origHtml;
                }
            });
        });
    }

    function attachPinHandlers() {
        document.querySelectorAll('.nc-pin-set').forEach(button => {
            button.addEventListener('click', async () => {
                const hostUrl = button.dataset.hostUrl;
                const select = document.querySelector(`.nc-pin-model-select[data-host-url="${CSS.escape(hostUrl)}"]`);
                const model = select?.value;
                if (!model) return;
                button.disabled = true;
                try {
                    await shared.fetchJson(`/api/nerve-center/host-preferences/${encodeURIComponent(hostUrl)}/pin`, {
                        method: 'PUT',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ model })
                    });
                    setTimeout(() => window.NerveCenterCluster?.loadCluster(), 1000);
                } catch (err) {
                    console.error('Failed to set pin:', err);
                } finally {
                    button.disabled = false;
                }
            });
        });

        document.querySelectorAll('.nc-pin-restore').forEach(button => {
            button.addEventListener('click', async () => {
                const hostUrl = button.dataset.hostUrl;
                button.disabled = true;
                const origHtml = button.innerHTML;
                button.innerHTML = '<i class="fas fa-spinner fa-spin"></i>';
                try {
                    await shared.fetchJson(`/api/nerve-center/host-preferences/${encodeURIComponent(hostUrl)}/restore`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' }
                    });
                    setTimeout(() => window.NerveCenterCluster?.loadCluster(), 2000);
                } catch (err) {
                    console.error('Failed to restore pin:', err);
                } finally {
                    button.disabled = false;
                    button.innerHTML = origHtml;
                }
            });
        });

        document.querySelectorAll('.nc-pin-clear').forEach(button => {
            button.addEventListener('click', async () => {
                const hostUrl = button.dataset.hostUrl;
                const headers = await window.AgentXTypedConfirmation.confirm({
                    action: 'CLEAR HOST PIN',
                    resource: hostUrl,
                    title: 'Clear pinned model',
                    description: `Clear the persisted model pin for ${hostUrl}? Automatic placement may select a different model afterward.`
                });
                if (!headers) return;
                button.disabled = true;
                try {
                    await shared.fetchJson(`/api/nerve-center/host-preferences/${encodeURIComponent(hostUrl)}/pin`, {
                        method: 'DELETE',
                        headers: { 'Content-Type': 'application/json', ...headers }
                    });
                    window.NerveCenterCluster?.loadCluster();
                } catch (err) {
                    console.error('Failed to clear pin:', err);
                } finally {
                    button.disabled = false;
                }
            });
        });

        document.querySelectorAll('.nc-pin-swap').forEach(button => {
            button.addEventListener('click', async () => {
                const hostUrl = button.dataset.hostUrl;
                const select = document.querySelector(`.nc-pin-swap-select[data-host-url="${CSS.escape(hostUrl)}"]`);
                const model = select?.value;
                if (!model) return;
                button.disabled = true;
                const origHtml = button.innerHTML;
                button.innerHTML = '<i class="fas fa-spinner fa-spin"></i>';
                try {
                    await shared.fetchJson(`/api/nerve-center/host-preferences/${encodeURIComponent(hostUrl)}/swap`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ model })
                    });
                    setTimeout(() => window.NerveCenterCluster?.loadCluster(), 2000);
                } catch (err) {
                    console.error('Failed to swap model:', err);
                } finally {
                    button.disabled = false;
                    button.innerHTML = origHtml;
                }
            });
        });

        // Auto-restore toggle — applies to every pinned entry on this host.
        document.querySelectorAll('.nc-pin-autorestore').forEach(checkbox => {
            checkbox.addEventListener('change', async () => {
                const hostUrl = checkbox.dataset.hostUrl;
                try {
                    const data = await shared.fetchJson('/api/nerve-center/host-preferences');
                    const prefs = (data && data.data) || [];
                    const match = prefs.find(p => p.hostUrl === hostUrl);
                    const current = Array.isArray(match?.pinnedModels) ? match.pinnedModels : [];
                    const pinnedModels = current
                        .filter(e => e && e.model)
                        .map(e => ({
                            model: e.model,
                            keepAlive: typeof e.keepAlive === 'number' ? e.keepAlive : -1,
                            contextSize: typeof e.contextSize === 'number' ? e.contextSize : 0,
                            autoRestore: checkbox.checked
                        }));
                    await shared.fetchJson(`/api/nerve-center/host-preferences/${encodeURIComponent(hostUrl)}`, {
                        method: 'PUT',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ pinnedModels })
                    });
                } catch (err) {
                    console.error('Failed to update autoRestore:', err);
                    checkbox.checked = !checkbox.checked;
                }
            });
        });
    }

    async function loadCluster() {
        const body = document.getElementById('sectionClusterBody');
        if (!body) return;

        shared.renderSectionLoading(body, 'Loading cluster data...');

        try {
            const [ollamaJson, hostPrefsJson] = await Promise.all([
                shared.fetchJson('/api/ollama-hosts'),
                shared.fetchJson('/api/nerve-center/host-preferences')
            ]);
            const hostPrefs = hostPrefsJson.data || [];
            const prefByUrl = new Map(hostPrefs.map(p => [p.hostUrl, p]));

            const ollamaData = ollamaJson.data || {};
            const configuredHosts = ollamaData.hosts || [];
            const cards = configuredHosts.map((host) => mergeHostData({
                hostId: host.id,
                hostname: host.name || host.id,
                ollamaHostKey: host.id,
                ollamaStatus: host.available ? 'online' : 'offline',
                ollamaUrl: host.url,
                ollamaVersion: host.ollamaVersion || '',
                ollamaModelCount: (host.installedModels || []).length,
                ollamaModels: host.installedModels || host.models || []
            }, {}, host, {}, prefByUrl.get(host.url)));

            if (cards.length === 0) {
                body.innerHTML = '<div class="nc-section-placeholder nc-muted"><i class="fas fa-server"></i> No cluster hosts found</div>';
                return;
            }

            body.innerHTML = buildClusterGrid(cards);
            attachHostCardHandlers();
            attachClusterPreferenceHandlers();
            attachPinHandlers();
        } catch (err) {
            console.error('[NerveCenter] loadCluster failed', err);
            shared.renderSectionError(body, `Failed to load cluster data: ${err.message}`);
        } finally {
            shared.finishSectionLoad(body);
        }
    }

    window.NerveCenterCluster = { loadCluster };
})();
