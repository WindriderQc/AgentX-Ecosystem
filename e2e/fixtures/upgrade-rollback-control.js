'use strict';

// This source is streamed to `node` inside the active Core container. It is
// deliberately self-contained so the rehearsal never bind-mounts repository
// files into a release image.

const crypto = require('node:crypto');
const mongoose = require('mongoose');

const MODE = process.env.AGENTX_UPGRADE_ROLLBACK_MODE;
const MARKER = 'AGENTX_UPGRADE_ROLLBACK_CONTROL=';
const MAX_RESPONSE_BYTES = 256 * 1024;
const REQUEST_TIMEOUT_MS = 8_000;
const DATABASE_NAME = 'agentx_product';
const COLLECTION_NAME = 'agentx_product_embeddings';
const FIXTURE_SCHEMA_VERSION = 1;
const PROMPT_ID = new mongoose.Types.ObjectId('66f000000000000000000001');
const TEMPLATE_ID = new mongoose.Types.ObjectId('66f000000000000000000002');
const PROMPT_NAME = 'agentx_upgrade_rollback_fixture';
const TEMPLATE_NAME = 'Agent X upgrade rollback fixture';
const DOCUMENT_ID = 'agentx-upgrade-rollback-document-v1';
const DOCUMENT_SOURCE = 'upgrade-rollback-fixture';
const DOCUMENT_TEXT = 'Deterministic upgrade rollback compatibility state.';
const POINT_ID = '66f00000-0000-4000-8000-000000000003';
const VECTOR = Object.freeze([0.1, 0.2, 0.3, 0.4]);
// Qdrant normalizes vectors for Cosine collections and persists the result as
// IEEE-754 float32 values. Its JSON encoder emits the shortest decimal that
// round-trips to each float32, so canonicalize both the expected and observed
// vectors back to float32 before exact comparison. This deliberately has no
// tolerance window.
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

async function boundedJson(origin, pathname, options = {}) {
  const target = new URL(pathname, origin);
  if (target.origin !== new URL(origin).origin) throw new Error('request escaped its fixed service origin');
  const response = await fetch(target, {
    ...options,
    redirect: 'manual',
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    headers: {
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      ...(options.headers || {}),
    },
  });
  if (response.status >= 300 && response.status < 400) throw new Error('redirect rejected');
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) throw new Error('response exceeds byte limit');
  const reader = response.body?.getReader();
  let total = 0;
  const chunks = [];
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
  const body = chunks.length ? Buffer.concat(chunks).toString('utf8') : '';
  let parsed;
  try {
    parsed = body ? JSON.parse(body) : null;
  } catch {
    throw new Error('response is not JSON');
  }
  if (!response.ok) throw new Error(`request returned status ${response.status}`);
  return parsed;
}

async function connectDatabase() {
  await mongoose.connect(process.env.MONGODB_URI, {
    dbName: DATABASE_NAME,
    serverSelectionTimeoutMS: 8_000,
  });
  return mongoose.connection.db;
}

function promptFixture() {
  return {
    _id: PROMPT_ID,
    name: PROMPT_NAME,
    systemPrompt: 'Upgrade rollback fixture system instruction.',
    isActive: false,
    version: 1,
    description: 'Deterministic lifecycle rehearsal state',
    trafficWeight: 100,
    abTestGroup: null,
    stats: { impressions: 0, positiveCount: 0, negativeCount: 0 },
    uiConfig: { type: 'chat', route: '/playground', capabilities: ['text'], layoutConfig: {} },
    rehearsalSchemaVersion: FIXTURE_SCHEMA_VERSION,
    createdAt: FIXED_DATE,
    updatedAt: FIXED_DATE,
  };
}

function templateFixture() {
  return {
    _id: TEMPLATE_ID,
    name: TEMPLATE_NAME,
    description: 'Deterministic lifecycle rehearsal state',
    config: {
      models: [],
      levels: [1],
      judge_config: {},
      execution_config: { response_mode: 'final_only' },
      execution_mode: 'latency',
      depth_config: null,
    },
    tags: ['upgrade-rollback'],
    source_batch_id: null,
    run_count: 0,
    rehearsalSchemaVersion: FIXTURE_SCHEMA_VERSION,
    createdAt: FIXED_DATE,
    updatedAt: FIXED_DATE,
  };
}

function qdrantPayload() {
  return {
    documentId: DOCUMENT_ID,
    source: DOCUMENT_SOURCE,
    tags: ['upgrade-rollback'],
    hash: crypto.createHash('sha256').update(DOCUMENT_TEXT).digest('hex'),
    contentHash: crypto.createHash('sha256').update(DOCUMENT_TEXT).digest('hex'),
    sourceIdentity: DOCUMENT_SOURCE,
    sourceIdentityKind: 'fixture',
    identityVersion: FIXTURE_SCHEMA_VERSION,
    chunkSize: 64,
    chunkOverlap: 0,
    chunkIndex: 0,
    text: DOCUMENT_TEXT,
    originalText: DOCUMENT_TEXT,
    rehearsalSchemaVersion: FIXTURE_SCHEMA_VERSION,
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
  if (promptCollision || templateCollision) throw new Error('Mongo rehearsal state is not fresh');

  await prompts.insertOne(promptFixture());
  await templates.insertOne(templateFixture());

  const qdrantOrigin = process.env.QDRANT_URL;
  const existing = await fetch(new URL(`/collections/${COLLECTION_NAME}`, qdrantOrigin), {
    redirect: 'manual',
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (existing.ok) throw new Error('Qdrant rehearsal state is not fresh');
  if (existing.status !== 404) throw new Error(`Qdrant collection preflight returned status ${existing.status}`);

  await boundedJson(qdrantOrigin, `/collections/${COLLECTION_NAME}`, {
    method: 'PUT',
    body: JSON.stringify({ vectors: { size: VECTOR.length, distance: 'Cosine' } }),
  });
  await boundedJson(qdrantOrigin, `/collections/${COLLECTION_NAME}/points?wait=true`, {
    method: 'PUT',
    body: JSON.stringify({
      points: [{ id: POINT_ID, vector: VECTOR, payload: qdrantPayload() }],
    }),
  });

  return { seeded: true, schemaVersion: FIXTURE_SCHEMA_VERSION };
}

function observedField(value, field) {
  const present = Boolean(value) && Object.prototype.hasOwnProperty.call(value, field);
  return { present, value: present ? value[field] ?? null : null };
}

function healthIdentityObservation(value, service) {
  const ok = observedField(value, 'ok');
  return {
    httpStatus: 200,
    healthyStatusVerified: value?.status === 'ok' && (!ok.present || ok.value === true),
    okFieldPresent: ok.present,
    ok: ok.value,
    service: value?.service || null,
    serviceVerified: value?.service === service,
    fields: {
      version: observedField(value, 'version'),
      profile: observedField(value, 'profile'),
      revision: observedField(value, 'revision'),
    },
  };
}

async function probe() {
  const database = await connectDatabase();
  const coreOrigin = 'http://core:3080';
  const benchmarkOrigin = process.env.BENCHMARK_SERVICE_URL;
  const ragOrigin = process.env.RAG_SERVICE_URL;
  const qdrantOrigin = process.env.QDRANT_URL;

  const [coreHealth, benchmarkHealth, ragHealth, promptResult, templateResult, documentList, documentDetail, chunkResult, collectionInfo, pointResult, promptDocument, templateDocument] = await Promise.all([
    boundedJson(coreOrigin, '/health'),
    boundedJson(benchmarkOrigin, '/health'),
    boundedJson(ragOrigin, '/health'),
    boundedJson(coreOrigin, `/api/prompts/${encodeURIComponent(PROMPT_NAME)}?includeRemoved=true`),
    boundedJson(benchmarkOrigin, '/api/benchmark/templates'),
    boundedJson(ragOrigin, `/api/rag/documents?source=${encodeURIComponent(DOCUMENT_SOURCE)}&limit=2`),
    boundedJson(ragOrigin, `/api/rag/documents/${encodeURIComponent(DOCUMENT_ID)}`),
    boundedJson(ragOrigin, `/api/rag/documents/${encodeURIComponent(DOCUMENT_ID)}/chunks`),
    boundedJson(qdrantOrigin, `/collections/${COLLECTION_NAME}`),
    boundedJson(qdrantOrigin, `/collections/${COLLECTION_NAME}/points/scroll`, {
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

  const coreStateValid = promptApi.length === 1
    && promptApi[0]?.name === expectedPrompt.name
    && promptApi[0]?.systemPrompt === expectedPrompt.systemPrompt
    && promptApi[0]?.version === expectedPrompt.version
    && promptApi[0]?.trafficWeight === expectedPrompt.trafficWeight;
  const benchmarkStateValid = fixtureTemplate.length === 1
    && fixtureTemplate[0]?.name === expectedTemplate.name
    && fixtureTemplate[0]?.description === expectedTemplate.description
    && fixtureTemplate[0]?.config?.execution_mode === 'latency'
    && fixtureTemplate[0]?.run_count === 0;
  const ragStateValid = documentsApi.length === 1
    && documentsApi[0]?.documentId === DOCUMENT_ID
    && documentsApi[0]?.chunkCount === 1
    && documentDetail?.data?.documentId === DOCUMENT_ID
    && documentDetail?.data?.chunkCount === 1
    && chunkResult?.data?.documentId === DOCUMENT_ID
    && chunkResult?.data?.chunks?.length === 1
    && chunkResult.data.chunks[0]?.chunkIndex === 0
    && chunkResult.data.chunks[0]?.text === DOCUMENT_TEXT;
  const observedQdrantVector = Array.from(Float32Array.from(point?.vector || []));
  const vectorStateValid = vectorSize === VECTOR.length
    && points.length === 1
    && point?.id === POINT_ID
    && JSON.stringify(observedQdrantVector) === JSON.stringify(CANONICAL_QDRANT_VECTOR)
    && digest(point?.payload) === digest(expectedPayload);
  const mongoSchemaValid = promptDocument?.rehearsalSchemaVersion === FIXTURE_SCHEMA_VERSION
    && templateDocument?.rehearsalSchemaVersion === FIXTURE_SCHEMA_VERSION
    && promptDocument?.name === expectedPrompt.name
    && promptDocument?.systemPrompt === expectedPrompt.systemPrompt
    && promptDocument?.stats?.impressions === 0
    && templateDocument?.name === expectedTemplate.name
    && templateDocument?.config?.execution_mode === 'latency'
    && templateDocument?.run_count === 0;
  const qdrantSchemaValid = vectorSize === VECTOR.length
    && point?.payload?.rehearsalSchemaVersion === FIXTURE_SCHEMA_VERSION
    && point?.payload?.identityVersion === FIXTURE_SCHEMA_VERSION
    && typeof point?.payload?.hash === 'string'
    && point.payload.hash.length === 64;

  const mongoState = {
    prompt: promptDocument,
    template: templateDocument,
  };
  const vectorState = {
    vectorSize,
    id: point?.id,
    vector: point?.vector,
    payload: point?.payload,
  };

  return {
    identities: {
      core: healthIdentityObservation(coreHealth, 'agentx-core'),
      benchmark: healthIdentityObservation(benchmarkHealth, 'agentx-benchmark'),
      rag: healthIdentityObservation(ragHealth, 'agentx-rag'),
    },
    journeys: {
      coreState: { passed: coreStateValid, records: promptApi.length },
      benchmarkState: { passed: benchmarkStateValid, records: fixtureTemplate.length },
      ragState: { passed: ragStateValid, records: documentsApi.length, chunks: chunkResult?.data?.chunks?.length ?? null },
      vectorState: { passed: vectorStateValid, records: points.length },
    },
    schemas: {
      fixtureSchemaVersion: FIXTURE_SCHEMA_VERSION,
      mongo: { passed: mongoSchemaValid, records: Number(Boolean(promptDocument)) + Number(Boolean(templateDocument)) },
      qdrant: { passed: qdrantSchemaValid, records: points.length, vectorSize: vectorSize ?? null },
    },
    state: {
      mongoFingerprint: digest(mongoState),
      qdrantFingerprint: digest(vectorState),
      combinedFingerprint: digest({ mongoState, vectorState }),
    },
  };
}

async function main() {
  if (!['seed', 'probe'].includes(MODE)) throw new Error('unknown rehearsal control mode');
  const result = MODE === 'seed' ? await seed() : await probe();
  process.stdout.write(`${MARKER}${JSON.stringify(result)}\n`);
}

main()
  .catch((error) => {
    process.stderr.write(`upgrade rollback control failed: ${error.message}\n`);
    process.exitCode = 1;
  })
  .finally(async () => {
    await mongoose.disconnect().catch(() => {});
  });
