#!/usr/bin/env node
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const readline = require('readline');
const zlib = require('zlib');

const SCHEMA_VERSION = 1;
const DEFAULT_LIMIT = 30000;
const MAX_GLOSSES_PER_ENTRY = 6;

function usage() {
  return [
    'Build a compact KidX French lexicon from local source files.',
    '',
    'Usage:',
    '  node scripts/build-kidx-lexicon.js --frequency <Lexique4.tsv> \\',
    '    --dictionary <frwiktionary.jsonl[.gz]> --output <kidx-fr.json> \\',
    '    [--limit 30000] [--wiktionary-date YYYY-MM-DD]',
    '',
    'Sources:',
    '  https://www.lexique.org/ (Lexique 4, CC BY-SA 4.0)',
    '  https://kaikki.org/frwiktionary/rawdata.html (Wiktionary extract)'
  ].join('\n');
}

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith('--')) continue;
    const key = token.slice(2);
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) throw new Error(`Missing value for --${key}`);
    args[key] = value;
    index += 1;
  }
  if (!args.frequency || !args.dictionary || !args.output) {
    throw new Error(usage());
  }
  args.limit = Math.max(100, Math.min(100000, Number(args.limit) || DEFAULT_LIMIT));
  return args;
}

function normalizeLexeme(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[’]/g, "'")
    .toLowerCase()
    .trim();
}

function inputStream(file) {
  const source = fs.createReadStream(file);
  return file.toLowerCase().endsWith('.gz') ? source.pipe(zlib.createGunzip()) : source;
}

function lineReader(file) {
  return readline.createInterface({
    input: inputStream(file),
    crlfDelay: Infinity
  });
}

function findColumn(headers, candidates) {
  const normalized = headers.map((header) => header.toLowerCase());
  for (const candidate of candidates) {
    const index = normalized.findIndex((header) => candidate.test(header));
    if (index !== -1) return index;
  }
  return -1;
}

async function readFrequencySelection(file, limit) {
  const rows = [];
  let headers = null;
  let wordIndex = -1;
  let lemmaIndex = -1;
  let frequencyIndex = -1;

  for await (const line of lineReader(file)) {
    if (!headers) {
      headers = line.replace(/^\uFEFF/, '').split('\t');
      wordIndex = findColumn(headers, [/(?:^|_)mot$/i, /^ortho$/i, /^word$/i]);
      lemmaIndex = findColumn(headers, [/(?:^|_)lemme$/i, /^lemma$/i]);
      frequencyIndex = findColumn(headers, [/(?:^|_)freqmot$/i, /(?:^|_)freqortho$/i, /frequency/i]);
      if (wordIndex === -1 || lemmaIndex === -1 || frequencyIndex === -1) {
        throw new Error(`Unsupported frequency columns: ${headers.join(', ')}`);
      }
      continue;
    }
    if (!line) continue;
    const columns = line.split('\t');
    const word = columns[wordIndex]?.trim();
    const lemma = columns[lemmaIndex]?.trim() || word;
    const frequency = Number.parseFloat(columns[frequencyIndex]) || 0;
    const normalized = normalizeLexeme(word);
    if (!normalized || !/^[-'\p{L}]+$/u.test(normalized)) continue;
    rows.push({ word, normalized, lemma, normalizedLemma: normalizeLexeme(lemma), frequency });
  }

  rows.sort((left, right) => right.frequency - left.frequency || left.normalized.localeCompare(right.normalized));
  const primary = rows.slice(0, limit);
  const selectedLemmas = new Set(primary.map((row) => row.normalizedLemma).filter(Boolean));
  const selected = new Map(primary.map((row) => [row.normalized, row]));

  for (const row of rows) {
    if (selected.size >= limit * 2) break;
    if (selectedLemmas.has(row.normalizedLemma) && !selected.has(row.normalized)) {
      selected.set(row.normalized, row);
    }
  }
  for (const row of rows) {
    if (selectedLemmas.has(row.normalized) && !selected.has(row.normalized)) {
      selected.set(row.normalized, row);
    }
  }
  return selected;
}

function unique(values, limit) {
  return [...new Set(values.filter(Boolean))].slice(0, limit);
}

function mergeDictionaryEntry(current, source, frequencyRow) {
  const senses = Array.isArray(source.senses) ? source.senses : [];
  const glosses = senses.flatMap((sense) => Array.isArray(sense.glosses) ? sense.glosses : [])
    .map((gloss) => String(gloss || '').replace(/\s+/g, ' ').trim())
    .filter((gloss) => gloss && gloss !== '[no-gloss]');
  const formOf = senses.flatMap((sense) => Array.isArray(sense.form_of) ? sense.form_of : [])
    .map((item) => item?.word);
  const pronunciations = (Array.isArray(source.sounds) ? source.sounds : [])
    .map((sound) => sound?.ipa)
    .filter(Boolean);
  const word = source.word || frequencyRow.word;
  const sourceUrl = `https://fr.wiktionary.org/wiki/${encodeURIComponent(word)}`;
  const base = current || {
    word,
    lemma: frequencyRow.lemma || formOf[0] || word,
    frequency: frequencyRow.frequency,
    partOfSpeech: [],
    glosses: [],
    pronunciation: '',
    sourceUrl
  };
  base.partOfSpeech = unique([...base.partOfSpeech, source.pos], 4);
  base.glosses = unique([...base.glosses, ...glosses], MAX_GLOSSES_PER_ENTRY);
  base.pronunciation = base.pronunciation || pronunciations[0] || '';
  if (normalizeLexeme(base.lemma) === normalizeLexeme(base.word) && formOf[0]) base.lemma = formOf[0];
  return base;
}

async function extractDictionary(file, selected) {
  const entries = new Map();
  let scanned = 0;
  let invalid = 0;
  for await (const line of lineReader(file)) {
    if (!line) continue;
    scanned += 1;
    let source;
    try {
      source = JSON.parse(line);
    } catch (_error) {
      invalid += 1;
      continue;
    }
    if (source.lang_code !== 'fr') continue;
    const normalized = normalizeLexeme(source.word);
    const frequencyRow = selected.get(normalized);
    if (!frequencyRow) continue;
    const merged = mergeDictionaryEntry(entries.get(normalized), source, frequencyRow);
    if (merged.glosses.length) entries.set(normalized, merged);
  }
  return { entries, scanned, invalid };
}

function sha256(file) {
  const hash = crypto.createHash('sha256');
  return new Promise((resolve, reject) => {
    const stream = fs.createReadStream(file);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

async function buildArtifact(args) {
  const frequencyFile = path.resolve(args.frequency);
  const dictionaryFile = path.resolve(args.dictionary);
  const outputFile = path.resolve(args.output);
  const selected = await readFrequencySelection(frequencyFile, args.limit);
  const extracted = await extractDictionary(dictionaryFile, selected);
  const sortedEntries = Object.fromEntries([...extracted.entries.entries()]
    .sort(([left], [right]) => left.localeCompare(right)));
  const [frequencySha256, dictionarySha256] = await Promise.all([
    sha256(frequencyFile),
    sha256(dictionaryFile)
  ]);
  const artifact = {
    schemaVersion: SCHEMA_VERSION,
    generatedAt: new Date().toISOString(),
    sources: {
      wiktionary: {
        name: 'Wiktionnaire français via Wiktextract/Kaikki',
        dumpDate: args['wiktionary-date'] || '',
        license: 'CC BY-SA 3.0',
        licenseUrl: 'https://fr.wiktionary.org/wiki/Wiktionnaire:Licence',
        url: 'https://kaikki.org/frwiktionary/rawdata.html',
        file: path.basename(dictionaryFile),
        sha256: dictionarySha256
      },
      frequency: {
        name: 'Lexique 4.00',
        license: 'CC BY-SA 4.0',
        licenseUrl: 'https://creativecommons.org/licenses/by-sa/4.0/',
        url: 'https://www.lexique.org/',
        file: path.basename(frequencyFile),
        sha256: frequencySha256
      }
    },
    stats: {
      frequencyLimit: args.limit,
      selectedForms: selected.size,
      dictionaryRowsScanned: extracted.scanned,
      invalidDictionaryRows: extracted.invalid,
      entries: extracted.entries.size
    },
    entries: sortedEntries
  };

  fs.mkdirSync(path.dirname(outputFile), { recursive: true });
  const temporaryFile = `${outputFile}.tmp-${process.pid}`;
  fs.writeFileSync(temporaryFile, JSON.stringify(artifact));
  fs.renameSync(temporaryFile, outputFile);
  return { outputFile, stats: artifact.stats, bytes: fs.statSync(outputFile).size };
}

async function main() {
  try {
    const result = await buildArtifact(parseArgs(process.argv.slice(2)));
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}

if (require.main === module) void main();

module.exports = {
  buildArtifact,
  extractDictionary,
  mergeDictionaryEntry,
  normalizeLexeme,
  parseArgs,
  readFrequencySelection
};
