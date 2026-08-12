#!/usr/bin/env node
'use strict';

/**
 * HF model-intake CLI (B5). Fetches candidate GGUF models from the HuggingFace
 * API, runs them through the intake scanner (fit/lane/host/priority — reuses the
 * benchmark fit math), and prints a prioritized intake queue. Node stdlib only,
 * no new deps. Results cached 7 days in benchmark/data/hf_intake_cache.json.
 *
 * Usage:
 *   node scripts/hf-intake.js --family qwen,gemma,llama --limit 15 [--json] [--no-cache] [--out FILE]
 *   node scripts/hf-intake.js --selftest        # offline, no network
 */

const fs = require('fs');
const path = require('path');
const { scanIntake, gatherCandidates, formatIntakeTable } = require('../src/services/benchmark/intakeScanner');
const hfClient = require('../src/clients/hfClient');

const CACHE_FILE = path.join(__dirname, '..', 'data', 'hf_intake_cache.json');
const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const DEFAULT_FAMILIES = ['qwen', 'gemma', 'llama', 'mistral', 'phi', 'deepseek'];

function parseArgs(argv) {
  const args = { families: DEFAULT_FAMILIES, limit: 15, json: false, cache: true, out: null, selftest: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--family' || a === '--families') args.families = String(argv[++i] || '').split(',').map((s) => s.trim()).filter(Boolean);
    else if (a === '--limit') args.limit = parseInt(argv[++i], 10) || args.limit;
    else if (a === '--json') args.json = true;
    else if (a === '--no-cache') args.cache = false;
    else if (a === '--out') args.out = argv[++i];
    else if (a === '--selftest') args.selftest = true;
  }
  return args;
}

function readCache() {
  try { return JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8')); } catch (_) { return {}; }
}
function writeCache(cache) {
  try {
    fs.mkdirSync(path.dirname(CACHE_FILE), { recursive: true });
    fs.writeFileSync(CACHE_FILE, JSON.stringify(cache, null, 2));
  } catch (err) { process.stderr.write(`[hf-intake] cache write failed: ${err.message}\n`); }
}

/** A per-family fetch that reads/writes the 7-day cache around hfClient. */
function makeCachedFetch(useCache) {
  const cache = useCache ? readCache() : {};
  const now = Date.now();
  let dirty = false;
  const fn = async (family, limit) => {
    const key = `${family}:${limit}`;
    const cached = cache[key];
    if (useCache && cached && (now - cached.fetchedAtMs) < CACHE_TTL_MS) return cached.models;
    const models = await hfClient.fetchFamily(family, limit);
    cache[key] = { fetchedAtMs: now, models };
    dirty = true;
    return models;
  };
  fn.flush = () => { if (useCache && dirty) writeCache(cache); };
  return fn;
}

const SELFTEST_FIXTURE = [
  { id: 'Qwen/Qwen2.5-7B-Instruct-GGUF', downloads: 500000, likes: 1200 },
  { id: 'unsloth/gemma-2-2b-it-GGUF', downloads: 30000, likes: 80 },
  { id: 'bartowski/Meta-Llama-3.1-70B-Instruct-GGUF', downloads: 200000, likes: 900 }
];

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const date = new Date().toISOString().slice(0, 10);

  let records;
  if (args.selftest) {
    records = scanIntake({ models: SELFTEST_FIXTURE, date });
  } else {
    const cachedFetch = makeCachedFetch(args.cache);
    records = await gatherCandidates({
      families: args.families,
      limit: args.limit,
      fetchFamily: cachedFetch,
      date,
      onWarn: (m) => process.stderr.write(`[hf-intake] ${m}\n`)
    });
    cachedFetch.flush();
  }
  const output = args.json ? JSON.stringify(records, null, 2) : formatIntakeTable(records);

  if (args.out) {
    fs.writeFileSync(args.out, output);
    process.stderr.write(`[hf-intake] wrote ${records.length} records to ${args.out}\n`);
  } else {
    process.stdout.write(output + '\n');
  }
  process.stderr.write(`[hf-intake] ${records.length} candidates (${records.filter((r) => r.priority === 'high').length} high priority)\n`);
}

main().catch((err) => { process.stderr.write(`[hf-intake] fatal: ${err.message}\n`); process.exit(1); });
