'use strict';

const os = require('os');
const { execFile } = require('child_process');

const VERSION = 'lite-1.0.0';
const CORE_URL = (process.env.CORE_URL || process.env.AGENTX_CORE_URL || 'http://127.0.0.1:3080').replace(/\/+$/, '');
const HOST_ID = process.env.HOST_ID || process.env.AGENTX_HOST_ID || os.hostname();
const HOSTNAME = process.env.HOSTNAME_OVERRIDE || process.env.AGENTX_HOSTNAME || os.hostname();
const OLLAMA_URL = (process.env.OLLAMA_URL || process.env.OLLAMA_HOST || 'http://localhost:11434').replace(/\/+$/, '');
const HOST_AGENT_TOKEN = process.env.HOST_AGENT_TOKEN || '';
const INTERVAL_MS = Math.max(5000, Number.parseInt(process.env.HOST_AGENT_INTERVAL_MS || '30000', 10));
const COMMAND_TIMEOUT_MS = Math.max(1000, Number.parseInt(process.env.HOST_AGENT_COMMAND_TIMEOUT_MS || '5000', 10));

let pendingTaskResults = [];

function execFileText(command, args = [], timeout = COMMAND_TIMEOUT_MS) {
  return new Promise((resolve) => {
    execFile(command, args, { timeout, windowsHide: true, maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) {
        resolve({ ok: false, stdout: String(stdout || ''), stderr: String(stderr || ''), error: error.message });
        return;
      }
      resolve({ ok: true, stdout: String(stdout || ''), stderr: String(stderr || ''), error: null });
    });
  });
}

function splitCsvLine(line) {
  const out = [];
  let current = '';
  let quoted = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (ch === '"') {
      quoted = !quoted;
    } else if (ch === ',' && !quoted) {
      out.push(current.trim());
      current = '';
    } else {
      current += ch;
    }
  }
  out.push(current.trim());
  return out;
}

function finiteNumber(value) {
  const n = Number.parseFloat(String(value ?? '').replace(/[^\d.-]/g, ''));
  return Number.isFinite(n) ? n : null;
}

async function collectNvidia() {
  const query = [
    'index',
    'name',
    'pci.bus_id',
    'pcie.link.gen.current',
    'pcie.link.gen.max',
    'pcie.link.width.current',
    'pcie.link.width.max',
    'utilization.gpu',
    'memory.used',
    'memory.total',
    'power.draw',
    'power.limit',
    'temperature.gpu'
  ].join(',');

  const gpuResult = await execFileText('nvidia-smi', [
    `--query-gpu=${query}`,
    '--format=csv,noheader,nounits'
  ]);

  if (!gpuResult.ok) return null;

  const gpus = gpuResult.stdout
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(Boolean)
    .map((line) => {
      const parts = splitCsvLine(line);
      return {
        index: finiteNumber(parts[0]) ?? 0,
        name: parts[1] || '',
        busId: parts[2] || '',
        pcieGen: finiteNumber(parts[3]),
        pcieGenMax: finiteNumber(parts[4]),
        pcieWidth: finiteNumber(parts[5]),
        pcieWidthMax: finiteNumber(parts[6]),
        utilization: finiteNumber(parts[7]),
        memoryUsed: finiteNumber(parts[8]),
        memoryTotal: finiteNumber(parts[9]),
        powerDraw: finiteNumber(parts[10]),
        powerLimit: finiteNumber(parts[11]),
        temperature: finiteNumber(parts[12])
      };
    });

  const [topo, driver] = await Promise.all([
    execFileText('nvidia-smi', ['topo', '-m']),
    execFileText('nvidia-smi', ['--query-gpu=driver_version', '--format=csv,noheader,nounits'])
  ]);

  return {
    driverVersion: driver.ok ? driver.stdout.split(/\r?\n/).map(s => s.trim()).find(Boolean) || '' : '',
    cudaVersion: '',
    topology: topo.ok ? topo.stdout.trim() : '',
    gpus,
    processes: []
  };
}

async function fetchJson(url, timeoutMs = COMMAND_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

async function collectOllama() {
  const state = {
    ollamaUrl: OLLAMA_URL,
    ollamaStatus: 'unknown',
    ollamaModels: [],
    ollamaRunningModels: [],
    ollamaModelCount: 0,
    ollamaVersion: '',
    ollamaLatencyMs: null,
    ollamaLastChecked: new Date().toISOString()
  };

  const started = Date.now();
  try {
    const [tags, ps, version] = await Promise.allSettled([
      fetchJson(`${OLLAMA_URL}/api/tags`),
      fetchJson(`${OLLAMA_URL}/api/ps`),
      fetchJson(`${OLLAMA_URL}/api/version`)
    ]);
    state.ollamaLatencyMs = Date.now() - started;
    if (tags.status === 'fulfilled') {
      state.ollamaStatus = 'online';
      state.ollamaModels = (tags.value.models || []).map(model => model.name).filter(Boolean);
      state.ollamaModelCount = state.ollamaModels.length;
    }
    if (ps.status === 'fulfilled') {
      state.ollamaRunningModels = ps.value.models || [];
    }
    if (version.status === 'fulfilled') {
      state.ollamaVersion = version.value.version || '';
    }
  } catch (_err) {
    state.ollamaStatus = 'offline';
  }
  return state;
}

function collectBase(nvidia, ollama) {
  const totalMem = os.totalmem();
  const freeMem = os.freemem();
  const usedMem = totalMem - freeMem;
  const networkInterfaces = os.networkInterfaces();
  const firstIp = Object.values(networkInterfaces)
    .flat()
    .find(iface => iface && iface.family === 'IPv4' && !iface.internal)?.address || '';
  const genericGpus = (nvidia?.gpus || []).map(gpu => ({
    index: gpu.index,
    name: gpu.name,
    vramTotal: gpu.memoryTotal || 0,
    vramUsed: gpu.memoryUsed || 0,
    temperature: gpu.temperature,
    utilization: gpu.utilization,
    powerDrawW: gpu.powerDraw,
    pcieGen: gpu.pcieGen,
    pcieGenMax: gpu.pcieGenMax,
    pcieWidth: gpu.pcieWidth,
    pcieWidthMax: gpu.pcieWidthMax
  }));

  return {
    hostId: HOST_ID,
    hostname: HOSTNAME,
    platform: process.platform,
    distro: os.type(),
    kernel: os.release(),
    arch: os.arch(),
    ip: firstIp,
    agentVersion: VERSION,
    cpu: {
      model: os.cpus()[0]?.model || '',
      cores: os.cpus().length,
      physicalCores: os.cpus().length,
      speed: os.cpus()[0]?.speed ? Math.round(os.cpus()[0].speed / 100) / 10 : 0,
      usage: null,
      loadAvg: os.loadavg()
    },
    memory: {
      total: totalMem,
      used: usedMem,
      available: freeMem,
      free: freeMem,
      usagePercent: totalMem ? Math.round((usedMem / totalMem) * 1000) / 10 : 0
    },
    gpus: genericGpus,
    nvidia: nvidia || undefined,
    disks: [],
    network: { interfaces: [] },
    uptime: os.uptime(),
    ...ollama
  };
}

async function buildReport() {
  const [nvidia, ollama] = await Promise.all([
    collectNvidia().catch(() => null),
    collectOllama().catch(() => ({ ollamaUrl: OLLAMA_URL, ollamaStatus: 'offline' }))
  ]);
  return {
    ...collectBase(nvidia, ollama),
    taskResults: pendingTaskResults
  };
}

async function postReport(report) {
  const headers = { 'content-type': 'application/json' };
  if (HOST_AGENT_TOKEN) headers['x-agent-token'] = HOST_AGENT_TOKEN;
  const res = await fetch(`${CORE_URL}/api/hosts/report`, {
    method: 'POST',
    headers,
    body: JSON.stringify(report)
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.message || `HTTP ${res.status}`);
  pendingTaskResults = [];
  return body.tasks || body.data?.tasks || [];
}

async function runTask(task) {
  const taskId = task.id || task.taskId;
  try {
    if (task.type === 'diag.ping') {
      return { taskId, status: 'completed', result: { pong: true, at: new Date().toISOString(), version: VERSION } };
    }
    if (task.type === 'nvidia.smi') {
      const dump = await execFileText('nvidia-smi', [], Math.max(COMMAND_TIMEOUT_MS, 10000));
      return { taskId, status: dump.ok ? 'completed' : 'failed', result: dump };
    }
    return { taskId, status: 'failed', result: { error: `Unsupported by ${VERSION}: ${task.type}` } };
  } catch (err) {
    return { taskId, status: 'failed', result: { error: err.message } };
  }
}

async function tick() {
  try {
    const report = await buildReport();
    const tasks = await postReport(report);
    if (tasks.length) {
      const results = await Promise.all(tasks.map(runTask));
      pendingTaskResults.push(...results);
    }
    const gpuText = report.nvidia?.gpus?.length
      ? report.nvidia.gpus.map(g => `${g.name || `GPU${g.index}`} ${g.memoryUsed}/${g.memoryTotal}MiB Gen${g.pcieGen || '?'}x${g.pcieWidth || '?'}`).join('; ')
      : 'no nvidia-smi';
    console.log(`[${new Date().toISOString()}] reported ${HOST_ID} -> ${CORE_URL} (${gpuText})`);
  } catch (err) {
    console.error(`[${new Date().toISOString()}] report failed: ${err.message}`);
  }
}

console.log(`AgentX host-agent ${VERSION} starting`, { CORE_URL, HOST_ID, HOSTNAME, OLLAMA_URL, INTERVAL_MS });
if (process.env.HOST_AGENT_ONCE === '1') {
  tick()
    .then(() => { process.exitCode = 0; })
    .catch((err) => {
      console.error(`[${new Date().toISOString()}] one-shot failed: ${err.message}`);
      process.exitCode = 1;
    });
} else {
  tick();
  setInterval(tick, INTERVAL_MS);
}
