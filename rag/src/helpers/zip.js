/**
 * Cross-platform ZIP archive extraction.
 *
 * Uses `unzip` on Linux/macOS and PowerShell `Expand-Archive` on Windows.
 * Both invocations go through execFile (no shell injection risk).
 *
 * Ported from legacy AgentX src/helpers/zip.js — first consumer is
 * rag/scripts/extract-rag-zips.js, which unpacks zips dropped into
 * INGEST_ROOTS so the normal scanner + ingest worker can pick up the
 * contents on the next poll cycle.
 */

const fs = require('fs').promises;
const { execFile } = require('child_process');
const { promisify } = require('util');

const execFileAsync = promisify(execFile);

function escapePowerShellLiteral(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

/**
 * Extract a zip file to a destination directory.
 *
 * @param {string} zipPath         Absolute path to the .zip file.
 * @param {string} destinationDir  Directory to extract into (created if missing).
 * @param {object} [options]
 * @param {number} [options.timeoutMs=60000] Timeout for the extraction process.
 * @returns {Promise<{stdout: string, stderr: string}>}
 */
async function extractZipArchive(zipPath, destinationDir, { timeoutMs = 60000 } = {}) {
  await fs.mkdir(destinationDir, { recursive: true });

  if (process.platform === 'win32') {
    const command = `Expand-Archive -LiteralPath ${escapePowerShellLiteral(zipPath)} -DestinationPath ${escapePowerShellLiteral(destinationDir)} -Force`;
    return execFileAsync(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', command],
      { timeout: timeoutMs, maxBuffer: 1024 * 1024 }
    );
  }

  return execFileAsync(
    'unzip',
    ['-o', zipPath, '-d', destinationDir],
    { timeout: timeoutMs, maxBuffer: 1024 * 1024 }
  );
}

module.exports = { extractZipArchive };
