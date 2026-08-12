#!/usr/bin/env node
/**
 * Extract ZIPs in RAG ingest roots.
 *
 * Walks each directory in INGEST_ROOTS, finds .zip files, and extracts
 * each one to a sibling `<zipname>.extracted/` directory. Skips zips
 * whose extraction directory already exists (idempotent). The normal
 * ingest worker poll will pick up the extracted files on its next pass.
 *
 * Usage:   node scripts/extract-rag-zips.js
 * Env:     INGEST_ROOTS  comma-separated list of root directories
 *                        (defaults match the rag service config)
 *
 * Design notes:
 * - Original zip is preserved so a rerun doesn't re-extract.
 * - To force re-extraction, delete the `<zipname>.extracted/` directory.
 * - Only handles top-level zips in each root — not nested zips inside
 *   already-extracted content. Good enough for the "drop a folder of
 *   docs as a zip" workflow.
 */

require('dotenv').config();
const fs = require('fs').promises;
const path = require('path');
const { extractZipArchive } = require('../src/helpers/zip');

const DEFAULT_ROOTS = ['/home/agentx/docs', process.cwd()];

function parseRoots(value = process.env.INGEST_ROOTS) {
  if (!value || !String(value).trim()) return DEFAULT_ROOTS.slice();
  return Array.from(new Set(
    String(value).split(',').map((s) => s.trim()).filter(Boolean).map((s) => path.resolve(s))
  ));
}

async function dirExists(p) {
  try {
    const stat = await fs.stat(p);
    return stat.isDirectory();
  } catch {
    return false;
  }
}

async function walkZips(root) {
  const found = [];
  async function recurse(dir) {
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch (err) {
      console.warn(`[skip] ${dir}: ${err.message}`);
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        // Don't recurse into already-extracted dirs
        if (entry.name.endsWith('.extracted')) continue;
        await recurse(full);
      } else if (entry.isFile() && entry.name.toLowerCase().endsWith('.zip')) {
        found.push(full);
      }
    }
  }
  await recurse(root);
  return found;
}

async function run() {
  const roots = parseRoots();
  console.log(`Scanning roots: ${roots.join(', ')}`);

  let scanned = 0;
  let extracted = 0;
  let skipped = 0;
  let failed = 0;

  for (const root of roots) {
    if (!(await dirExists(root))) {
      console.warn(`[skip] root missing: ${root}`);
      continue;
    }
    const zips = await walkZips(root);
    for (const zipPath of zips) {
      scanned += 1;
      const destDir = `${zipPath}.extracted`;
      if (await dirExists(destDir)) {
        console.log(`[skip] ${path.relative(root, zipPath)} (already extracted)`);
        skipped += 1;
        continue;
      }
      try {
        console.log(`[extract] ${path.relative(root, zipPath)} -> ${path.basename(destDir)}/`);
        await extractZipArchive(zipPath, destDir);
        extracted += 1;
      } catch (err) {
        console.error(`[fail] ${zipPath}: ${err.message}`);
        failed += 1;
      }
    }
  }

  console.log('');
  console.log(`Summary: scanned=${scanned}, extracted=${extracted}, skipped=${skipped}, failed=${failed}`);
  if (failed > 0) process.exit(1);
}

run().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
