#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { TextDecoder } = require('node:util');

const NODE_TYPES = new Set(['text', 'file', 'link', 'group']);
const SIDES = new Set(['top', 'right', 'bottom', 'left']);
const ENDS = new Set(['none', 'arrow']);

function decodeUtf8(buffer) {
  return new TextDecoder('utf-8', { fatal: true }).decode(buffer);
}

function validateMarkdownText(text) {
  const errors = [];
  const content = text.startsWith('\uFEFF') ? text.slice(1) : text;

  if (content.includes('\0')) errors.push('contains a NUL byte');

  const lines = content.split(/\r?\n/);
  if (lines[0] === '---') {
    const closingLine = lines.findIndex((line, index) => index > 0 && line === '---');
    if (closingLine === -1) errors.push('starts frontmatter but has no closing --- line');
  }

  return errors;
}

function requireString(record, field, label, errors) {
  if (typeof record[field] !== 'string' || record[field].length === 0) {
    errors.push(`${label}.${field} must be a non-empty string`);
  }
}

function validateCanvasData(data) {
  const errors = [];
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    return ['top level must be a JSON object'];
  }

  const nodes = data.nodes === undefined ? [] : data.nodes;
  const edges = data.edges === undefined ? [] : data.edges;
  if (!Array.isArray(nodes)) errors.push('nodes must be an array when present');
  if (!Array.isArray(edges)) errors.push('edges must be an array when present');
  if (!Array.isArray(nodes) || !Array.isArray(edges)) return errors;

  const allIds = new Set();
  const nodeIds = new Set();

  nodes.forEach((node, index) => {
    const label = `nodes[${index}]`;
    if (!node || typeof node !== 'object' || Array.isArray(node)) {
      errors.push(`${label} must be an object`);
      return;
    }

    requireString(node, 'id', label, errors);
    if (typeof node.id === 'string' && node.id.length > 0) {
      if (allIds.has(node.id)) errors.push(`${label}.id duplicates ${node.id}`);
      allIds.add(node.id);
      nodeIds.add(node.id);
    }

    if (!NODE_TYPES.has(node.type)) {
      errors.push(`${label}.type must be text, file, link, or group`);
    }

    for (const field of ['x', 'y', 'width', 'height']) {
      if (!Number.isInteger(node[field])) errors.push(`${label}.${field} must be an integer`);
    }
    if (Number.isInteger(node.width) && node.width <= 0) errors.push(`${label}.width must be positive`);
    if (Number.isInteger(node.height) && node.height <= 0) errors.push(`${label}.height must be positive`);

    if (node.type === 'text') requireString(node, 'text', label, errors);
    if (node.type === 'file') requireString(node, 'file', label, errors);
    if (node.type === 'link') requireString(node, 'url', label, errors);
  });

  edges.forEach((edge, index) => {
    const label = `edges[${index}]`;
    if (!edge || typeof edge !== 'object' || Array.isArray(edge)) {
      errors.push(`${label} must be an object`);
      return;
    }

    for (const field of ['id', 'fromNode', 'toNode']) requireString(edge, field, label, errors);
    if (typeof edge.id === 'string' && edge.id.length > 0) {
      if (allIds.has(edge.id)) errors.push(`${label}.id duplicates ${edge.id}`);
      allIds.add(edge.id);
    }
    if (typeof edge.fromNode === 'string' && !nodeIds.has(edge.fromNode)) {
      errors.push(`${label}.fromNode references missing node ${edge.fromNode}`);
    }
    if (typeof edge.toNode === 'string' && !nodeIds.has(edge.toNode)) {
      errors.push(`${label}.toNode references missing node ${edge.toNode}`);
    }
    if (edge.fromSide !== undefined && !SIDES.has(edge.fromSide)) {
      errors.push(`${label}.fromSide is invalid`);
    }
    if (edge.toSide !== undefined && !SIDES.has(edge.toSide)) {
      errors.push(`${label}.toSide is invalid`);
    }
    if (edge.fromEnd !== undefined && !ENDS.has(edge.fromEnd)) {
      errors.push(`${label}.fromEnd is invalid`);
    }
    if (edge.toEnd !== undefined && !ENDS.has(edge.toEnd)) {
      errors.push(`${label}.toEnd is invalid`);
    }
  });

  return errors;
}

function validateFile(filePath) {
  const extension = path.extname(filePath).toLowerCase();
  let text;
  try {
    text = decodeUtf8(fs.readFileSync(filePath));
  } catch (error) {
    return { file: filePath, errors: [`cannot read as UTF-8: ${error.message}`] };
  }

  if (extension === '.md') {
    return { file: filePath, errors: validateMarkdownText(text) };
  }
  if (extension === '.canvas') {
    try {
      return { file: filePath, errors: validateCanvasData(JSON.parse(text)) };
    } catch (error) {
      return { file: filePath, errors: [`invalid JSON: ${error.message}`] };
    }
  }
  return { file: filePath, errors: ['expected a .md or .canvas file'] };
}

function main(args = process.argv.slice(2)) {
  if (args.length === 0) {
    console.error('Usage: node scripts/validate.js <file.md|file.canvas> [file...]');
    return 2;
  }

  let failed = false;
  for (const filePath of args) {
    const result = validateFile(filePath);
    if (result.errors.length === 0) {
      console.log(`PASS ${filePath}`);
      continue;
    }
    failed = true;
    console.error(`FAIL ${filePath}`);
    for (const error of result.errors) console.error(`  - ${error}`);
  }
  return failed ? 1 : 0;
}

if (require.main === module) process.exitCode = main();

module.exports = {
  main,
  validateCanvasData,
  validateFile,
  validateMarkdownText,
};
