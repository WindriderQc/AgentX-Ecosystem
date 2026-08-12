'use strict';

const fs = require('fs');

function sortStrings(values) {
  return values.slice().sort((a, b) => a.localeCompare(b));
}

function parseScalar(value) {
  if (value === 'true') return true;
  if (value === 'false') return false;
  if (value === 'null' || value === '~') return null;
  if ((value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1);
  }
  if (/^\d+$/.test(value)) return parseInt(value, 10);
  if (/^\d+\.\d+$/.test(value)) return parseFloat(value);
  return value;
}

/** Parse the subset of YAML used by config/docs-map.yml when js-yaml is absent. */
function minimalYamlParse(text) {
  const lines = text.split(/\r?\n/);
  const root = {};
  let currentTopic = null;
  let currentListKey = null;

  for (const line of lines) {
    if (!line.trim() || line.trim().startsWith('#')) continue;

    const topMatch = line.match(/^(\w+):\s*(.*)$/);
    if (topMatch && !line.startsWith(' ') && !line.startsWith('-')) {
      const key = topMatch[1];
      const value = topMatch[2].trim();
      if (value === '') {
        currentListKey = null;
        continue;
      }
      root[key] = parseScalar(value);
      currentTopic = null;
      continue;
    }

    if (/^\s+-\s+id:\s*/.test(line)) {
      currentTopic = {};
      if (!root.topics) root.topics = [];
      root.topics.push(currentTopic);
      currentTopic.id = parseScalar(line.replace(/^\s+-\s+id:\s*/, '').trim());
      currentListKey = null;
      continue;
    }

    if (currentTopic && /^\s{4,}(\w+):\s*(.*)$/.test(line)) {
      const match = line.match(/^\s{4,}(\w+):\s*(.*)$/);
      const key = match[1];
      const value = match[2].trim();
      if (value === '') {
        currentListKey = key;
        currentTopic[key] = [];
      } else {
        currentTopic[key] = parseScalar(value);
        currentListKey = null;
      }
      continue;
    }

    if (currentTopic && currentListKey && /^\s+-\s+/.test(line)) {
      currentTopic[currentListKey].push(parseScalar(line.replace(/^\s+-\s+/, '').trim()));
    }
  }

  return root;
}

function loadDocsMap(mapPath) {
  const text = fs.readFileSync(mapPath, 'utf8');
  try {
    const yaml = require('js-yaml');
    return yaml.load(text);
  } catch (_error) {
    return minimalYamlParse(text);
  }
}

function yamlScalar(value) {
  if (value === null || value === undefined) return 'null';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') return String(value);
  const str = String(value);
  if (/[:#{}\[\]&*!|>'"%@`,\n\r]/.test(str) || str === '' ||
      ['null', 'true', 'false'].includes(str) || /^\d/.test(str)) {
    return '"' + str.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
  }
  return str;
}

function renderYaml(inventory) {
  const lines = [
    `schema_version: ${inventory.schema_version}`,
    `repo_root: ${yamlScalar(inventory.repo_root)}`,
    `total_artifacts: ${inventory.total_artifacts}`,
    'by_class:'
  ];

  for (const cls of sortStrings(Object.keys(inventory.by_class))) {
    lines.push(`  ${cls}: ${inventory.by_class[cls]}`);
  }

  lines.push('artifacts:');
  for (const artifact of inventory.artifacts) {
    lines.push(`  - path: ${yamlScalar(artifact.path)}`);
    lines.push(`    format: ${artifact.format}`);
    lines.push(`    title: ${yamlScalar(artifact.title)}`);
    lines.push(`    owner: ${yamlScalar(artifact.owner)}`);
    lines.push(`    last_verified: ${yamlScalar(artifact.last_verified)}`);
    lines.push(`    supersedes: ${yamlScalar(artifact.supersedes)}`);
    lines.push(`    superseded_by: ${yamlScalar(artifact.superseded_by)}`);
    lines.push(`    generator: ${yamlScalar(artifact.generator)}`);
    lines.push(`    class: ${artifact.class}`);
    lines.push(`    authority: ${artifact.authority}`);
    lines.push(`    classification_reason: ${yamlScalar(artifact.classification_reason)}`);
    lines.push(`    migration_state: ${artifact.migration_state}`);
    lines.push(`    proposed_target: ${yamlScalar(artifact.proposed_target)}`);
    for (const [key, values] of [
      ['docs_map_topics', artifact.docs_map_topics],
      ['outgoing_links', artifact.outgoing_links]
    ]) {
      if (values.length === 0) lines.push(`    ${key}: []`);
      else {
        lines.push(`    ${key}:`);
        for (const value of values) lines.push(`      - ${yamlScalar(value)}`);
      }
    }
    lines.push(`    inbound_link_count: ${artifact.inbound_link_count}`);
    if (artifact.broken_links.length === 0) lines.push('    broken_links: []');
    else {
      lines.push('    broken_links:');
      for (const link of artifact.broken_links) lines.push(`      - ${yamlScalar(link)}`);
    }
  }

  return lines.join('\n') + '\n';
}

module.exports = { loadDocsMap, minimalYamlParse, renderYaml };
