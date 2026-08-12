/**
 * @file Shared frontend utilities — single import for all services.
 * Built by esbuild -> public/dist/shared-utils.js
 */

// Keep this browser-rooted so the source file is also a valid artifact in
// service images that reuse Core's public assets without running esbuild.
export { PollingController } from '/js/utils/polling-controller.js';

// --- Common format helpers ---
// These replace the 8+ duplicated copies across the codebase.

export function escapeHtml(str) {
  if (typeof str !== 'string') return '';
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#039;');
}

export function formatBytes(bytes, decimals = 1) {
  if (!bytes || bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(decimals))} ${sizes[i]}`;
}

export function formatMs(ms) {
  if (ms == null || isNaN(ms)) return '\u2014';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  return `${(ms / 60000).toFixed(1)}m`;
}

export function formatNumber(n, decimals = 1) {
  if (n == null || isNaN(n)) return '\u2014';
  if (n >= 1e6) return `${(n / 1e6).toFixed(decimals)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(decimals)}K`;
  return String(n);
}

export function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}
