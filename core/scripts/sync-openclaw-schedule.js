#!/usr/bin/env node
/**
 * Sync OpenClaw Schedule → AgentX
 *
 * Reads OpenClaw's cron/jobs.json and pushes to AgentX's cluster schedule API.
 * Zero OpenClaw code changes — reads the official CLI or state file directly.
 * Zero npm dependencies — uses Node 18+ built-in fetch.
 *
 * Deploy on the host that owns ~/.openclaw/cron/jobs.json.
 *
 * Manual run:
 *   node sync-openclaw-schedule.js
 *
 * Environment overrides:
 *   AGENTX_OPENCLAW_JOBS_URL (optional AgentX /api/openclaw/cron projection)
 *   OPENCLAW_JOBS_FILE  (default: $OPENCLAW_HOME/cron/jobs.json or ~/.openclaw/cron/jobs.json)
 *   OPENCLAW_BIN        (default: openclaw)
 *   AGENTX_URL          (default: http://192.0.2.99:3080)
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');

const JOBS_FILE = process.env.OPENCLAW_JOBS_FILE
  || (process.env.OPENCLAW_HOME
    ? path.join(process.env.OPENCLAW_HOME, 'cron', 'jobs.json')
    : path.join(os.homedir(), '.openclaw', 'cron', 'jobs.json'));
const AGENTX_URL = process.env.AGENTX_URL || 'http://192.0.2.99:3080';
const AGENTX_OPENCLAW_JOBS_URL = process.env.AGENTX_OPENCLAW_JOBS_URL || null;
const SYNC_ENDPOINT = `${AGENTX_URL}/api/cluster/schedule/sync`;

// OpenClaw model alias → { model, host }
// primary   = Host Alpha          192.0.2.199  2x RTX 3090 / 48 GB total
// secondary = Host Beta         192.0.2.12   RTX 5070 Ti / 16 GB
// tertiary  = Host Gamma          192.0.2.99   RTX 3080 Ti / 12 GB
const MODEL_ALIASES = {
  local:   { model: 'ax/qwen3-coder:30b',            host: 'primary'   }, // Host Alpha
  fast:    { model: 'qwen3:8b',                     host: 'secondary' }, // Host Beta
  big:     { model: 'ax/qwen3-coder:30b',            host: 'primary'   }, // Host Alpha
  main:    { model: 'ax/qwen3-coder:30b',            host: 'primary'   }, // Host Alpha
  coder:   { model: 'deepcoder:14b-preview-q4_K_M', host: 'secondary' }, // Host Beta
  coder30: { model: 'qwen3-coder:30b',              host: 'primary'   }, // legacy alias
  think:   { model: 'deepseek-r1:14b',              host: 'secondary' }, // Host Beta
  oss:     { model: 'openclaw-oss-20b',              host: 'secondary' }, // Host Beta
  mistral: { model: 'Mistral-Small3.1-24B',          host: 'secondary' }, // Host Beta
  ablit:   { model: 'qwen3-abliterated:30b',         host: 'primary'   }, // Host Gamma
  small:   { model: 'qwen3:8b',                      host: 'secondary' }, // Host Beta
};

function resolveModel(alias) {
  if (!alias) return { model: 'ax/gemma4:26b-a4b-it-qat', host: 'primary' };
  return MODEL_ALIASES[alias] || { model: alias, host: 'secondary' };
}

function classifyTaskType(jobName) {
  if (/health|monitor|infra/i.test(jobName)) return 'monitoring';
  if (/benchmark/i.test(jobName)) return 'benchmark';
  if (/maintenance|memory|rag/i.test(jobName)) return 'maintenance';
  if (/sync|bisync/i.test(jobName)) return 'sync';
  if (/audit|security/i.test(jobName)) return 'diagnostics';
  if (/analytics|report|quality|improve/i.test(jobName)) return 'diagnostics';
  return 'inference';
}

function parseCronSchedule(job) {
  const sched = job.schedule;
  if (!sched || !sched.kind) return null;
  const tz = sched.tz || 'America/Toronto';

  if (sched.kind === 'cron' && sched.expr) {
    return { type: 'cron', cron: sched.expr, timezone: tz };
  }
  if (sched.kind === 'every' && sched.everyMs) {
    return { type: 'interval', intervalMs: sched.everyMs, timezone: tz };
  }
  return null;
}

function loadJobsFromCli(bin = process.env.OPENCLAW_BIN || 'openclaw') {
  const raw = execFileSync(bin, ['cron', 'list', '--json'], {
    encoding: 'utf8',
    timeout: 20_000,
    windowsHide: true,
  });
  const data = JSON.parse(raw);
  if (Array.isArray(data)) return data;
  if (Array.isArray(data?.jobs)) return data.jobs;
  throw new Error('OpenClaw CLI did not return a jobs array');
}

async function loadJobsFromAgentX(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(30_000) });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.message || `AgentX returned HTTP ${response.status}`);
  const jobs = Array.isArray(data) ? data : (data.data || data.jobs);
  if (!Array.isArray(jobs)) throw new Error('AgentX OpenClaw cron projection did not return an array');
  return jobs;
}

function loadJobsFromFile(file) {
  if (!fs.existsSync(file)) {
    throw new Error(`Jobs file not found: ${file}`);
  }

  const raw = fs.readFileSync(file, 'utf8');
  let jobs;
  try {
    jobs = JSON.parse(raw);
  } catch (err) {
    throw new Error(`Failed to parse ${file}: ${err.message}`);
  }

  return Array.isArray(jobs) ? jobs : (jobs.jobs || Object.values(jobs));
}

async function loadJobs() {
  if (AGENTX_OPENCLAW_JOBS_URL) {
    return { jobs: await loadJobsFromAgentX(AGENTX_OPENCLAW_JOBS_URL), source: AGENTX_OPENCLAW_JOBS_URL };
  }
  try {
    return { jobs: loadJobsFromCli(), source: 'openclaw cron list --json' };
  } catch (cliError) {
    try {
      return { jobs: loadJobsFromFile(JOBS_FILE), source: JOBS_FILE };
    } catch (fileError) {
      throw new Error(`OpenClaw CLI failed (${cliError.message}); state file failed (${fileError.message})`);
    }
  }
}

async function main() {
  // 1. Read jobs from the official OpenClaw CLI, then local jobs.json.
  let loaded;
  try {
    loaded = await loadJobs();
  } catch (err) {
    console.error(err.message);
    console.error('Install the OpenClaw CLI, set OPENCLAW_HOME to the real OpenClaw state directory, set OPENCLAW_JOBS_FILE explicitly, or mount cron/jobs.json into the container.');
    process.exit(1);
  }

  const jobList = loaded.jobs;

  if (!jobList || jobList.length === 0) {
    console.log('No jobs found in', loaded.source);
    process.exit(0);
  }

  // 2. Transform to ClusterScheduleEntry format
  const entries = [];
  for (const job of jobList) {
    const name = job.name || job.id || 'unknown';
    const schedule = parseCronSchedule(job);
    if (!schedule) continue;

    const modelAlias = job.payload?.model || null;
    const { model, host } = resolveModel(modelAlias);
    const state = job.state || {};

    entries.push({
      source: 'openclaw',
      sourceId: `oc-${name}`,
      name: name.replace(/[:-]/g, ' ').replace(/\b\w/g, c => c.toUpperCase()).trim(),
      taskType: classifyTaskType(name),
      host,
      model,
      agent: job.agentId || null,
      schedule,
      estimatedDurationMs: state.lastDurationMs || null,
      enabled: job.enabled !== false,
      lastRun: state.lastRunAtMs ? new Date(state.lastRunAtMs) : null,
      metadata: {
        modelAlias,
        delivery: job.delivery || null,
        lastStatus: state.lastStatus || null,
        consecutiveErrors: state.consecutiveErrors || 0,
        originalJobId: job.id || name,
        payloadPreview: job.payload?.message
          ? job.payload.message.slice(0, 100) + (job.payload.message.length > 100 ? '...' : '')
          : null,
        nextRunAtMs: state.nextRunAtMs || null,
      }
    });
  }

  console.log(`Parsed ${entries.length} jobs from ${loaded.source}`);

  // 3. POST to AgentX sync endpoint (uses Node 18+ built-in fetch — no npm deps)
  try {
    const res = await fetch(SYNC_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ entries }),
      signal: AbortSignal.timeout(10000)
    });

    const data = await res.json();
    if (data.status === 'success') {
      console.log(`Sync OK: ${data.data.created} created, ${data.data.updated} updated, ${data.data.unchanged} unchanged`);
    } else {
      console.error('Sync failed:', data.error || JSON.stringify(data));
      process.exit(1);
    }
  } catch (err) {
    console.error(`Failed to reach AgentX at ${SYNC_ENDPOINT}:`, err.message);
    process.exit(1);
  }
}

if (require.main === module) {
  main();
}

module.exports = {
  loadJobs,
  loadJobsFromAgentX,
  loadJobsFromFile,
  loadJobsFromCli,
  parseCronSchedule,
  resolveModel,
  classifyTaskType
};
