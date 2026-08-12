'use strict';

const fetch = require('node-fetch');
const hostProfileService = require('./hostProfileService');
const { checkHost } = require('../hostTestService');
const { listRunning } = require('../../clients/ollamaClient');
const { getConfiguredHosts, normalizeHostUrl } = require('../../helpers/ollamaHostConfig');

const CORE_URL = String(process.env.CORE_URL || process.env.AGENTX_CORE_URL || 'http://localhost:3080').replace(/\/+$/, '');
const HOST_AGENT_STALE_MS = 120000;

function parseUrlHost(hostUrl) {
  try {
    return new URL(hostUrl).hostname.toLowerCase();
  } catch {
    const m = String(hostUrl || '').match(/^(?:https?:\/\/)?([^/:]+)/i);
    return m ? m[1].toLowerCase() : '';
  }
}

function hostIdFromUrl(hostUrl) {
  const normalized = normalizeHostUrl(hostUrl);
  const host = parseUrlHost(normalized);
  let port = '11434';
  try { port = new URL(normalized).port || '11434'; } catch {}
  const slug = `${host}-${port}`.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  return `custom-${slug || 'ollama-host'}`;
}

function sameUrl(a, b) {
  const na = normalizeHostUrl(a || '');
  const nb = normalizeHostUrl(b || '');
  return !!na && !!nb && na.replace(/\/+$/, '') === nb.replace(/\/+$/, '');
}

function getDisplayName(hostUrl, fallback) {
  return fallback || parseUrlHost(hostUrl) || 'Ollama host';
}

function getInstallCoreUrl() {
  const configured = process.env.CORE_PUBLIC_URL || process.env.AGENTX_CORE_PUBLIC_URL || process.env.AGENTX_PUBLIC_CORE_URL;
  if (configured && String(configured).trim()) return String(configured).trim().replace(/\/+$/, '');

  try {
    const parsed = new URL(CORE_URL);
    const host = parsed.hostname.toLowerCase();
    if (host === 'core' || host === 'localhost' || host === '127.0.0.1') {
      return `http://<agentx-core-host>:${parsed.port || 3080}`;
    }
  } catch {}

  return CORE_URL;
}

async function fetchCoreJson(path, options = {}) {
  const url = `${CORE_URL}${path}`;
  const res = await fetch(url, {
    timeout: options.timeoutMs || 5000,
    method: options.method || 'GET',
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
    body: options.body ? JSON.stringify(options.body) : undefined
  });
  if (!res.ok) throw new Error(`Core ${path} returned HTTP ${res.status}`);
  const json = await res.json();
  return json?.data !== undefined ? json.data : json;
}

function unwrapCoreHostList(data) {
  if (Array.isArray(data)) return data;
  if (Array.isArray(data?.hosts)) return data.hosts;
  return [];
}

function matchCoreHost(coreHosts, host) {
  const hostIp = parseUrlHost(host.hostUrl);
  const hostId = String(host.hostId || '').toLowerCase();

  return (coreHosts || []).find((candidate) => {
    if (!candidate) return false;
    if (String(candidate.hostId || '').toLowerCase() === hostId) return true;
    if (String(candidate.ollamaHostKey || '').toLowerCase() === hostId) return true;
    if (candidate.ollamaUrl && sameUrl(candidate.ollamaUrl, host.hostUrl)) return true;
    const candidateIp = String(candidate.ip || '').toLowerCase();
    const candidateHost = String(candidate.hostname || '').toLowerCase();
    return !!hostIp && (candidateIp === hostIp || candidateHost === hostIp);
  }) || null;
}

function matchCoreGpu(gpuRows, host, coreHost) {
  const hostIp = parseUrlHost(host.hostUrl);
  const hostId = String(host.hostId || '').toLowerCase();
  const coreHostId = String(coreHost?.hostId || '').toLowerCase();

  return (gpuRows || []).find((row) => {
    if (!row) return false;
    if (String(row.hostId || '').toLowerCase() === hostId) return true;
    if (coreHostId && String(row.hostId || '').toLowerCase() === coreHostId) return true;
    if (String(row.ollamaHostKey || '').toLowerCase() === hostId) return true;
    return !!hostIp && String(row.ip || '').toLowerCase() === hostIp;
  }) || null;
}

function matchCoreVram(vramHosts, host) {
  const hostIp = parseUrlHost(host.hostUrl);
  const hostId = String(host.hostId || '').toLowerCase();

  return (vramHosts || []).find((row) => {
    if (!row) return false;
    if (String(row.id || '').toLowerCase() === hostId) return true;
    if (row.url && sameUrl(row.url, host.hostUrl)) return true;
    return !!hostIp && String(row.sshHost || '').toLowerCase() === hostIp;
  }) || null;
}

function summarizeAgent(coreHost) {
  if (!coreHost) {
    return { ok: false, available: false, fresh: false, reason: 'No host-agent heartbeat in Core yet' };
  }

  const lastSeenMs = Date.parse(coreHost.lastSeen || '');
  const ageMs = Number.isFinite(lastSeenMs) ? Date.now() - lastSeenMs : null;
  const fresh = ageMs != null && ageMs <= HOST_AGENT_STALE_MS;
  const online = ['online', 'degraded'].includes(String(coreHost.status || '').toLowerCase());

  return {
    ok: online && fresh,
    available: true,
    fresh,
    status: coreHost.status || 'unknown',
    hostId: coreHost.hostId || null,
    hostname: coreHost.hostname || null,
    ip: coreHost.ip || null,
    platform: coreHost.platform || 'unknown',
    agentVersion: coreHost.agentVersion || '',
    lastSeen: coreHost.lastSeen || null,
    ageSeconds: ageMs == null ? null : Math.max(0, Math.round(ageMs / 1000)),
    reason: online && fresh ? null : 'Host agent is missing or stale'
  };
}

function firstFinite(...values) {
  for (const value of values) {
    const n = Number(value);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

function firstText(...values) {
  for (const value of values) {
    if (value !== undefined && value !== null && String(value).trim()) return String(value).trim();
  }
  return '';
}

function sumFinite(values) {
  const finite = values.map(Number).filter(Number.isFinite);
  return finite.length ? finite.reduce((sum, n) => sum + n, 0) : null;
}

function normalizeGpu(gpu, index, source) {
  const pcie = gpu?.pcie || gpu?.pci || {};
  const pcieLink = pcie.link || {};
  const pcieGen = firstFinite(
    gpu?.pcieGen,
    gpu?.pcieLinkGen,
    gpu?.pcie_link_gen_current,
    gpu?.pcieLinkGenCurrent,
    pcie.gen,
    pcie.currentGen,
    pcieLink.gen,
    pcieLink.currentGen,
    pcieLink?.gen?.current
  );
  const pcieGenMax = firstFinite(
    gpu?.pcieGenMax,
    gpu?.pcieLinkGenMax,
    gpu?.pcie_link_gen_max,
    pcie.maxGen,
    pcieLink.maxGen,
    pcieLink?.gen?.max
  );
  const pcieWidth = firstFinite(
    gpu?.pcieWidth,
    gpu?.pcieLinkWidth,
    gpu?.pcie_link_width_current,
    gpu?.pcieLinkWidthCurrent,
    pcie.width,
    pcie.currentWidth,
    pcieLink.width,
    pcieLink.currentWidth,
    pcieLink?.width?.current
  );
  const pcieWidthMax = firstFinite(
    gpu?.pcieWidthMax,
    gpu?.pcieLinkWidthMax,
    gpu?.pcie_link_width_max,
    pcie.maxWidth,
    pcieLink.maxWidth,
    pcieLink?.width?.max
  );

  return {
    index: firstFinite(gpu?.index, gpu?.id, gpu?.gpu, index) ?? index,
    name: firstText(gpu?.name, gpu?.model, gpu?.gpuName),
    busId: firstText(gpu?.busId, gpu?.pciBusId, gpu?.pci_bus_id, gpu?.uuid),
    utilizationPct: firstFinite(gpu?.utilization, gpu?.utilizationPct, gpu?.utilizationGpu, gpu?.gpuUtilization, gpu?.utilization_gpu),
    memoryUsedMiB: firstFinite(gpu?.memoryUsed, gpu?.memoryUsedMiB, gpu?.vramUsed, gpu?.vramUsedMiB, gpu?.memory?.usedMiB, gpu?.memory?.used),
    memoryTotalMiB: firstFinite(gpu?.memoryTotal, gpu?.memoryTotalMiB, gpu?.vramTotal, gpu?.vramTotalMiB, gpu?.memory?.totalMiB, gpu?.memory?.total),
    powerDrawW: firstFinite(gpu?.powerDraw, gpu?.powerDrawW, gpu?.power?.draw, gpu?.power?.drawW),
    powerLimitW: firstFinite(gpu?.powerLimit, gpu?.powerLimitW, gpu?.power?.limit, gpu?.power?.limitW),
    temperatureC: firstFinite(gpu?.temperature, gpu?.temperatureC, gpu?.temp, gpu?.temperatureGpu),
    pcieGen,
    pcieGenMax,
    pcieWidth,
    pcieWidthMax,
    source
  };
}

function normalizeGpuList({ coreHost, coreGpu, coreVram }) {
  const nvidiaGpus = Array.isArray(coreHost?.nvidia?.gpus) ? coreHost.nvidia.gpus : [];
  if (nvidiaGpus.length) return nvidiaGpus.map((gpu, index) => normalizeGpu(gpu, index, 'host-agent-nvidia'));

  const hostGpus = Array.isArray(coreHost?.gpus) ? coreHost.gpus : [];
  if (hostGpus.length) return hostGpus.map((gpu, index) => normalizeGpu(gpu, index, 'host-agent'));

  const vramGpus = Array.isArray(coreVram?.gpus) ? coreVram.gpus : [];
  if (vramGpus.length) return vramGpus.map((gpu, index) => normalizeGpu(gpu, index, `core-${coreVram._source || 'vram'}`));

  const coreGpuList = Array.isArray(coreGpu?.gpus) ? coreGpu.gpus : [];
  if (coreGpuList.length) return coreGpuList.map((gpu, index) => normalizeGpu(gpu, index, 'core-gpu-status'));

  if (coreGpu) return [normalizeGpu(coreGpu, 0, 'core-gpu-status')];
  return [];
}

function buildTelemetryDiagnostics({ gpus, usedMiB, totalMiB }) {
  const notes = [];
  const vramPressurePct = totalMiB ? Math.round((Number(usedMiB || 0) / Number(totalMiB)) * 100) : null;
  const utilizations = gpus.map(g => g.utilizationPct).filter(v => v != null);
  const gpuUtilizationPct = utilizations.length
    ? Math.round(utilizations.reduce((sum, n) => sum + n, 0) / utilizations.length)
    : null;
  const gpuImbalancePct = utilizations.length > 1 ? Math.round(Math.max(...utilizations) - Math.min(...utilizations)) : null;
  const hottest = Math.max(...gpus.map(g => g.temperatureC ?? -Infinity));
  // Flag a real link downgrade — current speed below what the slot/cards can negotiate.
  // Hardware-fixed ceilings (e.g. a Gen 3 motherboard with PCIe 4.0 cards) are not warnings;
  // they're the platform's max and not actionable from the profiler. If max is unknown
  // we stay silent rather than false-positive against a hardware ceiling.
  const pcieWarnings = gpus
    .map(g => {
      const bits = [];
      if (g.pcieGen != null && g.pcieGenMax != null && g.pcieGen < g.pcieGenMax) {
        bits.push(`Gen${g.pcieGen}/max${g.pcieGenMax}`);
      }
      if (g.pcieWidth != null && g.pcieWidthMax != null && g.pcieWidth < g.pcieWidthMax) {
        bits.push(`x${g.pcieWidth}/max${g.pcieWidthMax}`);
      }
      return bits.length ? `GPU${g.index}: PCIe ${bits.join(' ')} (linked below max)` : null;
    })
    .filter(Boolean);

  if (vramPressurePct != null && vramPressurePct >= 90) notes.push(`VRAM pressure ${vramPressurePct}%`);
  if (totalMiB && usedMiB && Number(usedMiB) > Number(totalMiB) * 1.05) {
    notes.push('reported VRAM total is below loaded Ollama VRAM; enable host-agent for per-GPU totals');
  }
  if (gpuImbalancePct != null && gpuImbalancePct >= 35) notes.push(`multi-GPU utilization imbalance ${gpuImbalancePct}%`);
  if (Number.isFinite(hottest) && hottest >= 85) notes.push(`GPU temperature ${Math.round(hottest)}C`);
  notes.push(...pcieWarnings);

  return {
    vramPressurePct,
    gpuUtilizationPct,
    gpuImbalancePct,
    pcieWarning: pcieWarnings[0] || null,
    thermalWarning: Number.isFinite(hottest) && hottest >= 85 ? `GPU temperature ${Math.round(hottest)}C` : null,
    powerWarning: null,
    notes
  };
}

function summarizeTelemetry({ coreHost, coreGpu, coreVram, ollamaPs, profile }) {
  const gpus = normalizeGpuList({ coreHost, coreGpu, coreVram });
  const gpu = gpus[0] || null;
  const hasHostAgentTelemetry = gpus.some(g => ['host-agent-nvidia', 'host-agent'].includes(g.source));
  const gpuTotalMiB = sumFinite(gpus.map(g => g.memoryTotalMiB));
  const gpuUsedMiB = sumFinite(gpus.map(g => g.memoryUsedMiB));
  const usedFromPs = (ollamaPs.models || []).reduce((sum, model) => sum + (model.size_vram || 0), 0);
  const usedPsMiB = usedFromPs > 0 ? Math.round(usedFromPs / (1024 * 1024)) : null;
  const totalMiB = hasHostAgentTelemetry
    ? gpuTotalMiB
    : firstFinite(
      coreVram?.memoryTotalMiBTotal,
      coreGpu?.vramTotalMiB,
      coreHost?.ollamaVram?.totalMiB,
      gpu?.memoryTotalMiB,
      profile?.gpu?.vramTotalMiB
    );
  const usedMiB = hasHostAgentTelemetry
    ? (gpuUsedMiB ?? usedPsMiB)
    : firstFinite(
      coreVram?.memoryUsedMiBTotal,
      coreGpu?.vramUsedMiB,
      coreHost?.ollamaVram?.usedMiB,
      gpu?.memoryUsedMiB,
      usedPsMiB
    );

  const source = gpus.find(g => g.source === 'host-agent-nvidia') ? 'host-agent-nvidia'
    : gpus.find(g => g.source === 'host-agent') ? 'host-agent'
    : gpus.find(g => String(g.source || '').startsWith('core-ssh')) ? 'core-ssh-nvidia-smi'
    : coreGpu ? 'core-gpu-status'
    : coreVram?.ok ? `core-${coreVram._source || 'vram'}`
    : usedPsMiB != null ? 'ollama-ps'
    : totalMiB != null ? 'static-profile'
    : 'none';
  const diagnostics = buildTelemetryDiagnostics({ gpus, usedMiB, totalMiB });
  const telemetryError = hasHostAgentTelemetry ? null : (coreVram?.fallbackError || coreVram?.error || null);
  if (telemetryError) {
    diagnostics.notes.push(telemetryError);
  }

  return {
    ok: source !== 'none',
    source,
    gpuName: gpu?.name || coreGpu?.gpuName || '',
    utilization: gpu?.utilizationPct ?? coreGpu?.utilization ?? null,
    temperature: gpu?.temperatureC ?? coreGpu?.temperature ?? null,
    powerDrawW: gpu?.powerDrawW ?? null,
    pcieGen: gpu?.pcieGen ?? null,
    pcieGenMax: gpu?.pcieGenMax ?? null,
    pcieWidth: gpu?.pcieWidth ?? null,
    pcieWidthMax: gpu?.pcieWidthMax ?? null,
    topology: coreHost?.nvidia?.topology || coreHost?.nvidia?.topo || coreHost?.topology || null,
    gpuCount: gpus.length || null,
    gpus,
    diagnostics,
    vramUsedMiB: usedMiB,
    vramTotalMiB: totalMiB,
    runningModels: (ollamaPs.models || []).map(model => ({
      name: model.name,
      sizeVramMiB: model.size_vram ? Math.round(model.size_vram / (1024 * 1024)) : null,
      sizeTotalMiB: model.size ? Math.round(model.size / (1024 * 1024)) : null
    })),
    error: telemetryError,
    actionRequired: hasHostAgentTelemetry ? false : !!coreVram?.actionRequired
  };
}

function buildInstallPlan(host, agent) {
  const installCoreUrl = getInstallCoreUrl();
  const hostId = agent?.hostId || host.hostId;
  const hostname = getDisplayName(host.hostUrl, host.displayName);
  const agentUrl = `${installCoreUrl}/host-agent/agent.js`;
  const tokenEnv = process.env.HOST_AGENT_TOKEN ? ` HOST_AGENT_TOKEN="$HOST_AGENT_TOKEN"` : '';
  const tokenPs = process.env.HOST_AGENT_TOKEN ? `; $env:HOST_AGENT_TOKEN = $env:HOST_AGENT_TOKEN` : '';
  const serviceEnvToken = process.env.HOST_AGENT_TOKEN ? 'Environment=HOST_AGENT_TOKEN=$HOST_AGENT_TOKEN\n' : '';

  return {
    available: true,
    reason: 'Run the lightweight AgentX host-agent on the Ollama host to stream GPU, VRAM, PCIe, power, temperature, topology, and Ollama state into Core.',
    coreUrl: installCoreUrl,
    internalCoreUrl: CORE_URL,
    reportUrl: `${installCoreUrl}/api/hosts/report`,
    agentUrl,
    tokenRequired: !!process.env.HOST_AGENT_TOKEN,
    linux: [
      `mkdir -p ~/.agentx-host-agent && curl -fsS ${agentUrl} -o ~/.agentx-host-agent/agent.js`,
      `CORE_URL="${installCoreUrl}" HOST_ID="${hostId}" HOSTNAME_OVERRIDE="${hostname}" OLLAMA_URL="${host.hostUrl}"${tokenEnv} nohup node ~/.agentx-host-agent/agent.js > ~/.agentx-host-agent/agent.log 2>&1 &`
    ],
    linuxSystemd: [
      `mkdir -p ~/.agentx-host-agent && curl -fsS ${agentUrl} -o ~/.agentx-host-agent/agent.js`,
      `NODE_BIN="$(command -v node)" && sudo tee /etc/systemd/system/agentx-host-agent.service >/dev/null <<EOF
[Unit]
Description=AgentX Host Agent
After=network-online.target
Wants=network-online.target

[Service]
User=$USER
Environment=CORE_URL=${installCoreUrl}
Environment=HOST_ID=${hostId}
Environment=HOSTNAME_OVERRIDE=${hostname}
Environment=OLLAMA_URL=${host.hostUrl}
${serviceEnvToken}ExecStart=$NODE_BIN %h/.agentx-host-agent/agent.js
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF`,
      'sudo systemctl daemon-reload && sudo systemctl enable --now agentx-host-agent.service',
      'systemctl status --no-pager agentx-host-agent.service'
    ],
    windows: [
      `$dir = Join-Path $env:USERPROFILE ".agentx-host-agent"; New-Item -ItemType Directory -Force $dir | Out-Null; Invoke-WebRequest -UseBasicParsing -Uri "${agentUrl}" -OutFile (Join-Path $dir "agent.js")`,
      `$env:CORE_URL = "${installCoreUrl}"; $env:HOST_ID = "${hostId}"; $env:HOSTNAME_OVERRIDE = "${hostname}"; $env:OLLAMA_URL = "${host.hostUrl}"${tokenPs}; Start-Process -FilePath node -ArgumentList @((Join-Path $dir "agent.js")) -WindowStyle Hidden`
    ],
    next: 'Use Linux systemd for reboot-resistant telemetry. After the host-agent posts its first heartbeat, Validate Probes should show agent and GPU telemetry as live.'
  };
}

async function detectOllamaHost({ hostUrl, displayName } = {}) {
  const normalized = normalizeHostUrl(hostUrl || '');
  if (!normalized) {
    const err = new Error('hostUrl is required');
    err.statusCode = 400;
    throw err;
  }

  const check = await checkHost(normalized);
  if (!check.available) {
    const err = new Error(check.error || 'Ollama host is unreachable');
    err.statusCode = 503;
    err.data = { hostUrl: normalized, available: false, latency: check.latency || 0 };
    throw err;
  }

  const configured = getConfiguredHosts().find(h => sameUrl(h.url, normalized));
  const existing = await hostProfileService.getByUrl(normalized);
  const hostId = existing?.hostId || configured?.id || hostIdFromUrl(normalized);
  const name = String(displayName || '').trim() || existing?.displayName || configured?.name || getDisplayName(normalized);

  const profile = await hostProfileService.upsert({
    hostId,
    hostUrl: normalized,
    displayName: name,
    gpu: { vramTotalMiB: configured?.vramMb || existing?.gpu?.vramTotalMiB || 0 },
    status: 'online',
    lastSeenAt: new Date(),
    modelCount: check.models.length
  });

  return {
    host: profile.toObject ? profile.toObject() : profile,
    detection: {
      available: true,
      latency: check.latency,
      modelCount: check.models.length,
      models: check.models
    }
  };
}

async function getLiveProbeStatus(hostId) {
  let hosts = [];
  if (hostId) {
    const host = await hostProfileService.getById(hostId);
    if (!host) {
      const err = new Error(`Host not found: ${hostId}`);
      err.statusCode = 404;
      throw err;
    }
    hosts = [host];
  } else {
    hosts = await hostProfileService.getAll();
  }

  const [coreHostsResult, coreGpuResult, coreVramResult] = await Promise.allSettled([
    fetchCoreJson('/api/hosts'),
    fetchCoreJson('/api/nerve-center/inference/gpu-status'),
    fetchCoreJson('/api/ollama-vram')
  ]);

  const coreHosts = coreHostsResult.status === 'fulfilled' ? unwrapCoreHostList(coreHostsResult.value) : [];
  const coreGpuRows = coreGpuResult.status === 'fulfilled' && Array.isArray(coreGpuResult.value) ? coreGpuResult.value : [];
  const coreVramHosts = coreVramResult.status === 'fulfilled' ? unwrapCoreHostList(coreVramResult.value) : [];

  const data = await Promise.all(hosts.map(async (host) => {
    const [ollamaCheck, psResult] = await Promise.allSettled([
      checkHost(host.hostUrl),
      listRunning(host.hostUrl, { timeoutMs: 4000 })
    ]);

    const check = ollamaCheck.status === 'fulfilled'
      ? ollamaCheck.value
      : { available: false, models: [], latency: 0, error: ollamaCheck.reason?.message || 'Ollama check failed' };
    const ollamaPs = psResult.status === 'fulfilled'
      ? { ok: true, models: Array.isArray(psResult.value?.models) ? psResult.value.models : [] }
      : { ok: false, models: [], error: psResult.reason?.message || 'Ollama /api/ps failed' };

    const coreHost = matchCoreHost(coreHosts, host);
    const coreGpu = matchCoreGpu(coreGpuRows, host, coreHost);
    const coreVram = matchCoreVram(coreVramHosts, host);
    const agent = summarizeAgent(coreHost);
    const telemetry = summarizeTelemetry({ coreHost, coreGpu, coreVram, ollamaPs, profile: host });
    const status = !check.available ? 'offline' : agent.ok && telemetry.ok ? 'ready' : 'partial';

    return {
      hostId: host.hostId,
      displayName: host.displayName,
      hostUrl: host.hostUrl,
      status,
      checkedAt: new Date().toISOString(),
      ollama: {
        ok: !!check.available,
        latency: check.latency || 0,
        modelCount: check.models?.length || 0,
        error: check.error || null
      },
      ollamaPs,
      agent,
      telemetry,
      core: {
        ok: coreHostsResult.status === 'fulfilled',
        url: CORE_URL,
        errors: [
          coreHostsResult.status === 'rejected' ? coreHostsResult.reason?.message : null,
          coreGpuResult.status === 'rejected' ? coreGpuResult.reason?.message : null,
          coreVramResult.status === 'rejected' ? coreVramResult.reason?.message : null
        ].filter(Boolean)
      },
      install: buildInstallPlan(host, agent)
    };
  }));

  return hostId ? data[0] : { hosts: data, total: data.length };
}

module.exports = {
  detectOllamaHost,
  getLiveProbeStatus,
  hostIdFromUrl,
  _internal: { parseUrlHost, sameUrl, buildInstallPlan, summarizeAgent }
};
