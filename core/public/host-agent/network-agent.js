'use strict';

/**
 * AgentX network-scan host-agent (sibling of host-agent/agent.js).
 *
 * Runs `nmap` on the REAL LAN — where it can actually ARP-discover devices —
 * and feeds results to the data service. The data container cannot see the LAN
 * (Docker Desktop / WSL2 net), so this agent is the primary scan path.
 *
 * Triggers:
 *   - ON-DEMAND (primary): polls data for queued scan requests, runs nmap, posts.
 *   - SWEEP (optional): a light periodic discovery on SCAN_CIDR.
 *
 * Self-contained: Node built-ins only (no xml2js / npm install) — the data
 * service parses the raw nmap XML we post (reusing its proven parser). The nmap
 * COMMANDS mirror data/services/networkScanner.js exactly; keep them in sync.
 *
 * Run (Windows, elevated for ARP + -O):
 *   set DATA_URL=http://127.0.0.1:3083 && set SCANNER_ID=example-host && node network-agent.js
 * Run (Linux, with privileges):
 *   DATA_URL=http://127.0.0.1:3083 SCANNER_ID=example-host sudo -E node network-agent.js
 */

const os = require('os');
const fs = require('fs');
const { execFile } = require('child_process');

const VERSION = 'net-1.0.0';

// Resolve the nmap binary. On Windows the Nmap installer often does NOT add
// itself to PATH, so `execFile('nmap')` would ENOENT even with nmap installed.
// Honour an explicit NMAP_BIN, else probe the standard Windows install dirs,
// else fall back to bare `nmap` (Linux/macOS, where it's normally on PATH).
function resolveNmapBin() {
  if (process.env.NMAP_BIN) return process.env.NMAP_BIN;
  if (process.platform === 'win32') {
    for (const p of ['C:\\Program Files (x86)\\Nmap\\nmap.exe', 'C:\\Program Files\\Nmap\\nmap.exe']) {
      try { if (fs.existsSync(p)) return p; } catch { /* ignore */ }
    }
  }
  return 'nmap';
}
const NMAP_BIN = resolveNmapBin();
const DATA_URL = (process.env.DATA_URL || process.env.DATAAPI_BASE_URL || 'http://127.0.0.1:3083').replace(/\/+$/, '');
const SCANNER_ID = process.env.SCANNER_ID || process.env.NETWORK_SCANNER_ID || os.hostname();
const HOSTNAME = process.env.HOSTNAME_OVERRIDE || os.hostname();
const SCAN_CIDR = process.env.SCAN_CIDR || '192.0.2.0/24';
const NETWORK_AGENT_TOKEN = process.env.NETWORK_AGENT_TOKEN || '';
const POLL_MS = Math.max(2000, Number.parseInt(process.env.NETWORK_AGENT_POLL_MS || '5000', 10));
const SWEEP_MS = Math.max(0, Number.parseInt(process.env.NETWORK_AGENT_SWEEP_MS || '900000', 10)); // 15m; 0 = off
const NMAP_TIMEOUT_MS = Math.max(10000, Number.parseInt(process.env.NMAP_TIMEOUT_MS || '120000', 10));
const PRUNE = process.env.NETWORK_AGENT_PRUNE === '1' || process.env.NETWORK_AGENT_PRUNE === 'true';

const ts = () => new Date().toISOString();

function localIp() {
  const addrs = Object.values(os.networkInterfaces())
    .flat()
    .filter(i => i && i.family === 'IPv4' && !i.internal)
    .map(i => i.address);
  // Prefer the LAN-facing address: first one on the scan subnet, then any
  // non-link-local address, then whatever's left. Avoids reporting a virtual
  // adapter's 169.254.x APIPA (e.g. Hyper-V/WSL vEthernet on Windows) when a
  // real LAN address exists.
  const scanPrefix = SCAN_CIDR.split('/')[0].split('.').slice(0, 3).join('.') + '.';
  return addrs.find(a => a.startsWith(scanPrefix))
    || addrs.find(a => !a.startsWith('169.254.'))
    || addrs[0] || '';
}

function isElevated() {
  try { return typeof process.getuid === 'function' ? process.getuid() === 0 : undefined; }
  catch { return undefined; }
}

/** Run nmap, buffering stdout (XML). Never rejects — returns a status object. */
function runNmap(args) {
  return new Promise((resolve) => {
    execFile(NMAP_BIN, args, { timeout: NMAP_TIMEOUT_MS, windowsHide: true, maxBuffer: 8 * 1024 * 1024 }, (error, stdout, stderr) => {
      resolve({
        ok: !error,
        stdout: String(stdout || ''),
        stderr: String(stderr || ''),
        error: error ? error.message : null
      });
    });
  });
}

/**
 * Discovery scan — mirrors networkScanner.scanNetwork exactly:
 *   nmap -sn --privileged -oX - <cidr>
 */
async function runDiscovery(cidr) {
  const { ok, stdout, stderr, error } = await runNmap(['-sn', '--privileged', '-oX', '-', cidr]);
  // nmap may emit partial XML even on a non-zero exit (e.g. unprivileged ARP).
  const hasXml = stdout.includes('<nmaprun');
  if (!ok && !hasXml) {
    console.error(`[${ts()}] nmap discovery failed for ${cidr}: ${error || stderr || 'no output'}`);
  }
  return { ok: ok || hasXml, xml: hasXml ? stdout : '', error: error || (hasXml ? null : (stderr || 'nmap returned no XML')) };
}

/** POST results (raw nmap XML preferred; the data service parses) to the ingest endpoint. */
async function postResults({ requestId, xml, devices, note, pruneMissing }) {
  const body = {
    scannerId: SCANNER_ID,
    scanSource: SCANNER_ID,
    hostname: HOSTNAME,
    ip: localIp(),
    platform: process.platform,
    agentVersion: VERSION,
    cidr: SCAN_CIDR,
    capabilities: { nmap: true, privileged: isElevated() },
    pruneMissing: pruneMissing === true ? true : PRUNE
  };
  if (requestId) body.requestId = requestId;
  if (xml && xml.trim()) {
    body.format = 'nmap-xml';
    body.xml = xml;
  } else {
    body.format = 'devices';
    body.devices = devices || [];
    if (note) body.note = note;
  }

  const headers = { 'content-type': 'application/json' };
  if (NETWORK_AGENT_TOKEN) headers['x-agent-token'] = NETWORK_AGENT_TOKEN;

  const res = await fetch(`${DATA_URL}/api/v1/network/scan-results`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body)
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.message || `HTTP ${res.status}`);
  return json.data || {};
}

/** Run one discovery for a queued request and post the result back. */
async function serviceRequest(req) {
  const target = req.target || SCAN_CIDR;
  console.log(`[${ts()}] servicing request ${req.requestId} target=${target}`);
  const { xml, error } = await runDiscovery(target);
  try {
    const summary = await postResults({ requestId: req.requestId, xml, note: error });
    console.log(`[${ts()}] request ${req.requestId} → discovered=${summary.discovered ?? '?'} updated=${summary.updated ?? '?'}`);
  } catch (err) {
    console.error(`[${ts()}] post failed for request ${req.requestId}: ${err.message}`);
  }
}

/** Poll for pending scan requests (this also heartbeats the scanner registry). */
async function poll() {
  const qs = new URLSearchParams({
    scannerId: SCANNER_ID,
    hostname: HOSTNAME,
    ip: localIp(),
    platform: process.platform,
    agentVersion: VERSION,
    cidr: SCAN_CIDR
  });
  const headers = {};
  if (NETWORK_AGENT_TOKEN) headers['x-agent-token'] = NETWORK_AGENT_TOKEN;

  let requests = [];
  try {
    const res = await fetch(`${DATA_URL}/api/v1/network/scan-requests?${qs.toString()}`, { headers });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(json.message || `HTTP ${res.status}`);
    requests = json.data?.requests || [];
  } catch (err) {
    console.error(`[${ts()}] poll failed (${DATA_URL}): ${err.message}`);
    return;
  }
  for (const req of requests) {
    // eslint-disable-next-line no-await-in-loop
    await serviceRequest(req);
  }
}

/** Light background discovery sweep of SCAN_CIDR. */
async function sweep() {
  console.log(`[${ts()}] background sweep ${SCAN_CIDR}`);
  const { xml, error } = await runDiscovery(SCAN_CIDR);
  try {
    const summary = await postResults({ xml, note: error, pruneMissing: PRUNE });
    console.log(`[${ts()}] sweep → discovered=${summary.discovered ?? '?'} updated=${summary.updated ?? '?'}`);
  } catch (err) {
    console.error(`[${ts()}] sweep post failed: ${err.message}`);
  }
}

console.log(`AgentX network-agent ${VERSION} starting`, {
  DATA_URL, SCANNER_ID, SCAN_CIDR, POLL_MS, SWEEP_MS, NMAP_BIN, tokened: !!NETWORK_AGENT_TOKEN, elevated: isElevated()
});

if (process.env.NETWORK_AGENT_ONCE === '1') {
  // One pass — poll (services any queued requests) then a single sweep. For CI / proof.
  (async () => {
    try {
      await poll();
      if (SWEEP_MS > 0) await sweep();
    } finally {
      // Let in-flight HTTP sockets settle before exiting. Forcing exit() right
      // after the last fetch can trip a libuv teardown assertion on Windows;
      // the unref'd timer also lets the loop drain naturally if it can.
      setTimeout(() => process.exit(process.exitCode || 0), 250).unref();
    }
  })();
} else {
  poll();
  setInterval(poll, POLL_MS);
  if (SWEEP_MS > 0) {
    sweep();
    setInterval(sweep, SWEEP_MS);
  }
}
