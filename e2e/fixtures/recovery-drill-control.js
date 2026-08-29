'use strict';

// Streamed to `node` inside the isolated Core container. It intentionally
// emits only booleans, counts, identities, and hashes; fixture content never
// enters the recovery receipt.

const crypto = require('node:crypto');
const mongoose = require('mongoose');

const MODE = process.env.AGENTX_RECOVERY_DRILL_MODE;
const EXPECTED_PROFILE = process.env.AGENTX_RECOVERY_EXPECTED_PROFILE;
const EXPECTED_REVISION = process.env.AGENTX_RECOVERY_EXPECTED_REVISION;
const EXPECTED_VERSION = process.env.AGENTX_RECOVERY_EXPECTED_VERSION;
const MARKER = 'AGENTX_RECOVERY_PRODUCT_PROOF=';
const MAX_RESPONSE_BYTES = 256 * 1024;
const REQUEST_TIMEOUT_MS = 8000;
const DATABASE_NAME = 'agentx_product';
const COLLECTION_NAME = 'agentx_product_embeddings';
const FIXTURE_SCHEMA_VERSION = 1;
const PROMPT_ID = new mongoose.Types.ObjectId('66f100000000000000000001');
const TEMPLATE_ID = new mongoose.Types.ObjectId('66f100000000000000000002');
const PROMPT_NAME = 'agentx_recovery_fixture';
const TEMPLATE_NAME = 'Agent X recovery fixture';
const DOCUMENT_ID = 'agentx-recovery-document-v1';
const DOCUMENT_SOURCE = 'recovery-fixture';
const DOCUMENT_TEXT = 'Deterministic product recovery state.';
const POINT_ID = '66f10000-0000-4000-8000-000000000003';
const VECTOR = Object.freeze([0.1, 0.2, 0.3, 0.4]);
const VECTOR_MAGNITUDE = Math.hypot(...VECTOR);
const CANONICAL_QDRANT_VECTOR = Object.freeze(Array.from(Float32Array.from(
  VECTOR.map((value) => value / VECTOR_MAGNITUDE)
)));
const FIXED_DATE = new Date('2026-01-01T00:00:00.000Z');

function stable(value) {
  if (value instanceof Date) return value.toISOString();
  if (value && typeof value === 'object' && typeof value.toHexString === 'function') {
    return value.toHexString();
  }
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]));
  }
  return value;
}

function digest(value) {
  return crypto.createHash('sha256').update(JSON.stringify(stable(value))).digest('hex');
}

async function boundedRequest(origin, pathname, options = {}) {
  const target = new URL(pathname, origin);
  if (target.origin !== new URL(origin).origin) throw new Error('request escaped its fixed service origin');
  const response = await fetch(target, {
    method: options.method || 'GET',
    body: options.body,
    redirect: 'manual',
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    headers: {
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      ...(options.headers || {}),
    },
  });
  if (response.status >= 300 && response.status < 400) throw new Error('redirect rejected');
  if (!response.ok) throw new Error(`request returned status ${response.status}`);
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) throw new Error('response exceeds byte limit');
  const reader = response.body?.getReader();
  const chunks = [];
  let total = 0;
  if (reader) {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_RESPONSE_BYTES) {
        await reader.cancel().catch(() => {});
        throw new Error('response exceeds byte limit');
      }
      chunks.push(Buffer.from(value));
    }
  }
  const text = chunks.length ? Buffer.concat(chunks).toString('utf8') : '';
  if (options.type === 'text') return text;
  try {
    return text ? JSON.parse(text) : null;
  } catch {
    throw new Error('response is not JSON');
  }
}

async function connectDatabase() {
  await mongoose.connect(process.env.MONGODB_URI, {
    dbName: DATABASE_NAME,
    serverSelectionTimeoutMS: REQUEST_TIMEOUT_MS,
  });
  return mongoose.connection.db;
}

function promptFixture() {
  return {
    _id: PROMPT_ID,
    name: PROMPT_NAME,
    systemPrompt: 'Recovery fixture system instruction.',
    isActive: false,
    version: 1,
    description: 'Deterministic recovery rehearsal state',
    trafficWeight: 100,
    abTestGroup: null,
    stats: { impressions: 0, positiveCount: 0, negativeCount: 0 },
    uiConfig: { type: 'chat', route: '/playground', capabilities: ['text'], layoutConfig: {} },
    recoverySchemaVersion: FIXTURE_SCHEMA_VERSION,
    createdAt: FIXED_DATE,
    updatedAt: FIXED_DATE,
  };
}

function templateFixture() {
  return {
    _id: TEMPLATE_ID,
    name: TEMPLATE_NAME,
    description: 'Deterministic recovery rehearsal state',
    config: {
      models: [],
      levels: [1],
      judge_config: {},
      execution_config: { response_mode: 'final_only' },
      execution_mode: 'latency',
      depth_config: null,
    },
    tags: ['recovery-drill'],
    source_batch_id: null,
    run_count: 0,
    recoverySchemaVersion: FIXTURE_SCHEMA_VERSION,
    createdAt: FIXED_DATE,
    updatedAt: FIXED_DATE,
  };
}

function qdrantPayload() {
  const contentHash = crypto.createHash('sha256').update(DOCUMENT_TEXT).digest('hex');
  return {
    documentId: DOCUMENT_ID,
    source: DOCUMENT_SOURCE,
    tags: ['recovery-drill'],
    hash: contentHash,
    contentHash,
    sourceIdentity: DOCUMENT_SOURCE,
    sourceIdentityKind: 'fixture',
    identityVersion: FIXTURE_SCHEMA_VERSION,
    chunkSize: 64,
    chunkOverlap: 0,
    chunkIndex: 0,
    text: DOCUMENT_TEXT,
    originalText: DOCUMENT_TEXT,
    recoverySchemaVersion: FIXTURE_SCHEMA_VERSION,
  };
}

async function seed() {
  const database = await connectDatabase();
  const prompts = database.collection('promptconfigs');
  const templates = database.collection('benchmarktemplates');
  const [promptCollision, templateCollision] = await Promise.all([
    prompts.countDocuments({ $or: [{ _id: PROMPT_ID }, { name: PROMPT_NAME }] }, { limit: 1 }),
    templates.countDocuments({ $or: [{ _id: TEMPLATE_ID }, { name: TEMPLATE_NAME }] }, { limit: 1 }),
  ]);
  if (promptCollision || templateCollision) throw new Error('Mongo recovery state is not fresh');
  await prompts.insertOne(promptFixture());
  await templates.insertOne(templateFixture());

  const qdrantOrigin = process.env.QDRANT_URL;
  const existing = await fetch(new URL(`/collections/${COLLECTION_NAME}`, qdrantOrigin), {
    redirect: 'manual',
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (existing.ok) throw new Error('Qdrant recovery state is not fresh');
  if (existing.status !== 404) throw new Error(`Qdrant preflight returned status ${existing.status}`);
  await boundedRequest(qdrantOrigin, `/collections/${COLLECTION_NAME}`, {
    method: 'PUT',
    body: JSON.stringify({ vectors: { size: VECTOR.length, distance: 'Cosine' } }),
  });
  await boundedRequest(qdrantOrigin, `/collections/${COLLECTION_NAME}/points?wait=true`, {
    method: 'PUT',
    body: JSON.stringify({ points: [{ id: POINT_ID, vector: VECTOR, payload: qdrantPayload() }] }),
  });
  return { seeded: true, schemaVersion: FIXTURE_SCHEMA_VERSION };
}

function exactIdentity(value, service) {
  return {
    valid: value?.ok === true
      && value?.status === 'ok'
      && value?.service === service
      && value?.profile === EXPECTED_PROFILE
      && value?.revision === EXPECTED_REVISION
      && value?.version === EXPECTED_VERSION,
    service: value?.service || null,
    version: value?.version || null,
    profile: value?.profile || null,
    revision: value?.revision || null,
  };
}

async function probe() {
  const database = await connectDatabase();
  const coreOrigin = 'http://127.0.0.1:3080';
  const benchmarkOrigin = process.env.BENCHMARK_SERVICE_URL;
  const ragOrigin = process.env.RAG_SERVICE_URL;
  const qdrantOrigin = process.env.QDRANT_URL;

  const [
    coreHealth,
    benchmarkHealth,
    ragHealth,
    promptResult,
    templateResult,
    documentList,
    documentDetail,
    chunkResult,
    collectionInfo,
    pointResult,
    promptDocument,
    templateDocument,
    promptsPage,
    benchmarkPage,
    documentsPage,
  ] = await Promise.all([
    boundedRequest(coreOrigin, '/health'),
    boundedRequest(benchmarkOrigin, '/health'),
    boundedRequest(ragOrigin, '/health'),
    boundedRequest(coreOrigin, `/api/prompts/${encodeURIComponent(PROMPT_NAME)}?includeRemoved=true`),
    boundedRequest(benchmarkOrigin, '/api/benchmark/templates'),
    boundedRequest(ragOrigin, `/api/rag/documents?source=${encodeURIComponent(DOCUMENT_SOURCE)}&limit=2`),
    boundedRequest(ragOrigin, `/api/rag/documents/${encodeURIComponent(DOCUMENT_ID)}`),
    boundedRequest(ragOrigin, `/api/rag/documents/${encodeURIComponent(DOCUMENT_ID)}/chunks`),
    boundedRequest(qdrantOrigin, `/collections/${COLLECTION_NAME}`),
    boundedRequest(qdrantOrigin, `/collections/${COLLECTION_NAME}/points/scroll`, {
      method: 'POST',
      body: JSON.stringify({
        filter: { must: [{ key: 'documentId', match: { value: DOCUMENT_ID } }] },
        limit: 2,
        with_payload: true,
        with_vector: true,
      }),
    }),
    database.collection('promptconfigs').findOne({ _id: PROMPT_ID }),
    database.collection('benchmarktemplates').findOne({ _id: TEMPLATE_ID }),
    boundedRequest(coreOrigin, '/prompts', { type: 'text' }),
    boundedRequest(benchmarkOrigin, '/', { type: 'text' }),
    boundedRequest(ragOrigin, '/documents', { type: 'text' }),
  ]);

  const promptApi = Array.isArray(promptResult?.data) ? promptResult.data : [];
  const templatesApi = Array.isArray(templateResult?.data) ? templateResult.data : [];
  const fixtureTemplate = templatesApi.filter((entry) => String(entry?._id) === String(TEMPLATE_ID));
  const documentsApi = Array.isArray(documentList?.data?.documents) ? documentList.data.documents : [];
  const points = Array.isArray(pointResult?.result?.points) ? pointResult.result.points : [];
  const point = points[0];
  const vectorSize = collectionInfo?.result?.config?.params?.vectors?.size;
  const expectedPrompt = promptFixture();
  const expectedTemplate = templateFixture();
  const expectedPayload = qdrantPayload();
  // Cosine collections normalize vectors before persisting float32 values.
  // Round the JSON response back to float32 and keep an exact comparison; no
  // epsilon window can hide recovery corruption.
  const observedQdrantVector = Array.from(Float32Array.from(point?.vector || []));
  const identities = {
    core: exactIdentity(coreHealth, 'agentx-core'),
    benchmark: exactIdentity(benchmarkHealth, 'agentx-benchmark'),
    rag: exactIdentity(ragHealth, 'agentx-rag'),
  };
  const journeys = {
    prompt: promptApi.length === 1
      && promptApi[0]?.name === expectedPrompt.name
      && promptApi[0]?.systemPrompt === expectedPrompt.systemPrompt
      && promptApi[0]?.version === expectedPrompt.version,
    benchmark: fixtureTemplate.length === 1
      && fixtureTemplate[0]?.name === expectedTemplate.name
      && fixtureTemplate[0]?.config?.execution_mode === 'latency'
      && fixtureTemplate[0]?.run_count === 0,
    rag: documentsApi.length === 1
      && documentsApi[0]?.documentId === DOCUMENT_ID
      && documentsApi[0]?.chunkCount === 1
      && documentDetail?.data?.documentId === DOCUMENT_ID
      && chunkResult?.data?.chunks?.length === 1
      && chunkResult.data.chunks[0]?.text === DOCUMENT_TEXT,
    vector: vectorSize === VECTOR.length
      && points.length === 1
      && point?.id === POINT_ID
      && JSON.stringify(observedQdrantVector) === JSON.stringify(CANONICAL_QDRANT_VECTOR)
      && digest(point?.payload) === digest(expectedPayload),
    browser: /prompt/i.test(promptsPage)
      && /benchmark/i.test(benchmarkPage)
      && /document|knowledge/i.test(documentsPage),
  };
  const schemas = {
    mongo: promptDocument?.recoverySchemaVersion === FIXTURE_SCHEMA_VERSION
      && templateDocument?.recoverySchemaVersion === FIXTURE_SCHEMA_VERSION,
    qdrant: vectorSize === VECTOR.length
      && point?.payload?.recoverySchemaVersion === FIXTURE_SCHEMA_VERSION
      && point?.payload?.identityVersion === FIXTURE_SCHEMA_VERSION,
  };
  const mongoState = { prompt: promptDocument, template: templateDocument };
  const qdrantState = { vectorSize, id: point?.id, vector: point?.vector, payload: point?.payload };
  return {
    identities,
    journeys,
    schemas,
    counts: { mongo: Number(Boolean(promptDocument)) + Number(Boolean(templateDocument)), qdrant: points.length },
    fingerprints: {
      mongo: digest(mongoState),
      qdrant: digest(qdrantState),
      combined: digest({ mongoState, qdrantState }),
    },
  };
}

async function main() {
  if (!['seed', 'probe'].includes(MODE)) throw new Error('unknown recovery drill control mode');
  const result = MODE === 'seed' ? await seed() : await probe();
  process.stdout.write(`${MARKER}${JSON.stringify(result)}\n`);
}

main()
  .catch((error) => {
    process.stderr.write(`recovery drill control failed: ${error.message}\n`);
    process.exitCode = 1;
  })
  .finally(async () => {
    await mongoose.disconnect().catch(() => {});
  });
