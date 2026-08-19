---
doc_type: permanent
authority: canonical
status: active
owner: rag
last_verified: 2026-07-27
---

# AgentX RAG — API Contract

> Base URL: `http://localhost:3082`

**Envelope:** `{ "ok": true, "data": { ... }, "meta": { "durationMs": 42 } }`
**Errors:** `{ "ok": false, "error": "CODE", "detail": "..." }`

## Health & Status

### GET /health

Readiness check (not behind `/api/rag`). Returns 503 when MongoDB or the
configured vector store is unavailable. The embedding model remains an
optional capability and is reported by `/api/rag/status`.

```bash
curl http://localhost:3082/health
# => { "ok": true, "status": "ok", "service": "agentx-rag", "db": "connected", "vectorStore": { "healthy": true, "type": "qdrant" } }
```

### GET /api/rag/status

Full health with dependency matrix and cache stats.

```bash
curl http://localhost:3082/api/rag/status
```

```json
{
  "ok": true,
  "data": {
    "documentCount": 12, "chunkCount": 340, "vectorDimension": 768,
    "vectorStore": { "healthy": true, "type": "qdrant" },
    "cache": { "hits": 50, "misses": 12, "size": 62 },
    "dependencies": {
      "mongodb": { "healthy": true },
      "embedding": { "healthy": true, "provider": "core-proxy", "model": "nomic-embed-text:v1.5", "endpoint": "http://localhost:3080" },
      "qdrant": { "healthy": true }
    },
    "healthy": true
  }
}
```

## Ingestion

### POST /api/rag/ingest

Ingest a text document (chunk + embed + store). `POST /api/rag/documents` is an alias.

| Field | Type | Required | Default | Notes |
|-------|------|----------|---------|-------|
| text | string | yes | -- | Max 2,000,000 chars |
| source | string | no | `"api"` | For filtering |
| tags | string[] | no | `[]` | For filtering |
| chunkSize | int | no | 500 | 50-10,000 |
| chunkOverlap | int | no | 50 | 0 to chunkSize/2 |
| documentId | string | no | MD5 auto | Stable ID; re-ingest replaces |

```bash
curl -X POST http://localhost:3082/api/rag/ingest \
  -H 'Content-Type: application/json' \
  -d '{ "text": "Content...", "source": "my-source", "tags": ["docs"] }'
# => { "ok": true, "data": { "documentId": "abc123", "chunkCount": 7, "status": "ok" } }
```

**Errors:** 400 (validation), 503 `VECTOR_STORE_UNAVAILABLE`, 503 `EMBEDDING_SERVICE_UNAVAILABLE`

### POST /api/rag/ingest/batch

Bulk ingest up to 50 documents sequentially (configurable via `BATCH_MAX_DOCS`).

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| documents | array | yes | Max 50 items |
| documents[].text | string | yes | Same validation as /ingest |
| documents[].source | string | no | |
| documents[].tags | string[] | no | |
| documents[].documentId | string | no | |

```bash
curl -X POST http://localhost:3082/api/rag/ingest/batch \
  -H 'Content-Type: application/json' \
  -d '{ "documents": [{ "text": "First...", "source": "batch" }, { "text": "Second...", "source": "batch" }] }'
```

```json
{ "ok": true, "data": { "total": 2, "succeeded": 2, "failed": 0, "results": [
  { "index": 0, "documentId": "abc123", "status": "ok", "chunkCount": 3 },
  { "index": 1, "documentId": "def456", "status": "ok", "chunkCount": 5 }
] } }
```

### POST /api/rag/ingest-scan

Async approved-corpus scan + ingestion. Returns 202 with jobId. Max 1
concurrent scan. The product policy defaults to the container-local
`/data/imports` directory, `.md` and `.txt`, and 1 MiB per file. No host path is
mounted by default. Environment/request values may narrow but cannot widen the
policy. Roots and files are realpath-checked before reads.

| Field | Type | Default | Notes |
|-------|------|---------|-------|
| limit | int | 5000 | Capped at 5000 |
| roots | string[] | configured | Restrict to specific dirs |

```bash
curl -X POST http://localhost:3082/api/rag/ingest-scan \
  -H 'Content-Type: application/json' -d '{ "limit": 100 }'
# => 202 { "ok": true, "data": { "jobId": "uuid", "status": "running" } }
```

**Errors:** 409 `SCAN_ALREADY_RUNNING`, 400 `INVALID_ROOTS`, 503 `MONGODB_UNAVAILABLE`

### GET /api/rag/ingest-scan/:jobId

Poll scan progress. Status: `running` | `completed` | `failed` | `cancelled`.

```bash
curl http://localhost:3082/api/rag/ingest-scan/uuid
```

```json
{ "ok": true, "data": {
  "jobId": "uuid", "status": "running",
  "progress": { "scanned": 50, "ingested": 30, "skipped": 20 },
  "startedAt": "2026-04-03T12:00:00.000Z", "completedAt": null
} }
```

### DELETE /api/rag/ingest-scan/:jobId

Cancel a running scan. **Errors:** 404, 400 `JOB_NOT_RUNNING`

```bash
curl -X DELETE http://localhost:3082/api/rag/ingest-scan/uuid
# => { "ok": true, "data": { "jobId": "uuid", "status": "cancelled" } }
```

### GET /api/rag/ingestion/policy

Returns the public read-only import contract: container-local root, approved
roots, extension/size limits, and deterministic exclusions. It contains no
secrets or document contents.

```bash
curl http://localhost:3082/api/rag/ingestion/policy
```

## Search

### POST /api/rag/search

Semantic vector search across chunks.

| Field | Type | Required | Default | Notes |
|-------|------|----------|---------|-------|
| query | string | yes | -- | Max 10,000 chars |
| topK | int | no | 5 | 1-20 |
| minScore | number | no | 0.0 | 0-1 |
| filters | object | no | -- | `{ source, tags }` |
| expand | bool | no | false | LLM query expansion (+~300ms) |
| hybrid | bool | no | false | Semantic + keyword (+~75ms) |
| rerank | bool | no | false | LLM judge re-ranking (+~1000ms) |
| compress | bool | no | false | Extract query-relevant sentences after retrieval; fail-soft |

```bash
curl -X POST http://localhost:3082/api/rag/search \
  -H 'Content-Type: application/json' \
  -d '{ "query": "How does the alert system work?", "topK": 5, "minScore": 0.3 }'
```

```json
{ "ok": true, "data": {
  "results": [{ "text": "The alert system monitors...", "score": 0.87,
    "metadata": { "source": "docs", "documentId": "abc123", "chunkIndex": 2 } }],
  "count": 1
} }
```

**Errors:** 400 (validation), 503 `VECTOR_STORE_UNAVAILABLE`, 503 `EMBEDDING_SERVICE_UNAVAILABLE`

When `compress` is enabled, result objects may also include `compressedText`,
`originalText`, `wasCompressed`, and `compressionRatio`. Compression falls back
to the original text when inference is unavailable.

## Documents

### GET /api/rag/documents

List documents with filtering and pagination.

| Param | Type | Default | Notes |
|-------|------|---------|-------|
| source | string | -- | Filter |
| tags | string | -- | Comma-separated |
| limit | int | 50 | Max 200 |
| offset | int | 0 | |

```bash
curl "http://localhost:3082/api/rag/documents?source=docs&limit=20"
# => { "ok": true, "data": { "documents": [...], "total": 1, "limit": 20, "offset": 0 } }
```

### GET /api/rag/documents/:id

Document metadata. **Errors:** 404

```bash
curl http://localhost:3082/api/rag/documents/abc123
# => { "ok": true, "data": { "documentId": "abc123", "source": "docs", "chunkCount": 7, "metadata": { "tags": ["api"], "hash": "md5" } } }
```

### GET /api/rag/documents/:id/chunks

All chunks for a document. **Errors:** 404

```bash
curl http://localhost:3082/api/rag/documents/abc123/chunks
# => { "ok": true, "data": { "documentId": "abc123", "chunks": [{ "chunkIndex": 0, "text": "...", "metadata": {} }] } }
```

### DELETE /api/rag/documents/:id

Delete a document and all its chunks. **Errors:** 404

```bash
curl -X DELETE http://localhost:3082/api/rag/documents/abc123
# => { "ok": true, "data": { "documentId": "abc123" } }
```

## Manifests & Cleanup

### POST /api/rag/manifests

Store a folder scan snapshot. Used by ingest-scan.

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| source | string | yes | Source identifier |
| root | string | yes | Root directory path |
| scanId | string | no | Scan identifier |
| files | array | yes | `[{ path, size }]` |

```bash
curl -X POST http://localhost:3082/api/rag/manifests \
  -H 'Content-Type: application/json' \
  -d '{ "source": "local-import", "root": "/data/imports", "files": [{ "path": "/data/imports/f.txt", "size": 1024 }] }'
# => { "ok": true, "data": { "manifestId": "...", "source": "local-import", "stats": { "fileCount": 1, "totalBytes": 1024 } } }
```

### GET /api/rag/manifests/latest

Most recent manifest. Optional `?source=X` filter. Returns `data: null` if none exists.

```bash
curl "http://localhost:3082/api/rag/manifests/latest?source=local-import"
```

### GET /api/rag/deletion-preview

Compare manifest vs indexed docs. Omit `source` for multi-source aggregate.

```bash
curl "http://localhost:3082/api/rag/deletion-preview?source=local-import"
# => { "ok": true, "data": { "source": "local-import", "manifestFiles": 50, "indexedDocs": 55, "stale": [...], "fresh": 50 } }
```

### POST /api/rag/cleanup

Delete stale documents. Dry-run by default.

| Field | Type | Required | Default | Notes |
|-------|------|----------|---------|-------|
| source | string | yes | -- | Source to clean |
| dryRun | bool | no | true | Set false to delete |
| manifestId | string | no | latest | Specific manifest |
| maxDeletes | int | no | 100 | Safety cap (max 500) |

```bash
curl -X POST http://localhost:3082/api/rag/cleanup \
  -H 'Content-Type: application/json' \
  -d '{ "source": "local-import", "dryRun": false, "maxDeletes": 100 }'
# => { "ok": true, "data": { "dryRun": false, "deleted": ["doc1"], "errors": [], "stats": { "attempted": 1, "succeeded": 1, "failed": 0, "elapsedMs": 150 } } }
```

## Embedding Migration

### GET /api/rag/embedding-migration/status

Check dimension mismatch between current model and stored vectors.

```bash
curl http://localhost:3082/api/rag/embedding-migration/status
# => { "ok": true, "data": { "currentModel": "nomic-embed-text:v1.5", "currentDimension": 768, "storedDimension": 768, "dimensionMatch": true, "migrationNeeded": false, "documentCount": 12, "chunkCount": 340 } }
```

### POST /api/rag/embedding-migration/reindex

Re-embed all documents with current model. Requires `{ "confirm": true }`. Async 202 + jobId.

```bash
curl -X POST http://localhost:3082/api/rag/embedding-migration/reindex \
  -H 'Content-Type: application/json' -d '{ "confirm": true }'
# => 202 { "ok": true, "data": { "jobId": "reindex-...", "status": "running" } }
```

**Errors:** 400 `CONFIRMATION_REQUIRED`, 409 `REINDEX_ALREADY_RUNNING`

### GET /api/rag/embedding-migration/reindex/:jobId

Poll reindex progress.

```bash
curl http://localhost:3082/api/rag/embedding-migration/reindex/reindex-123
# => { "ok": true, "data": { "jobId": "reindex-123", "status": "running", "progress": { "total": 12, "processed": 5, "succeeded": 5, "failed": 0, "errors": [] } } }
```

## Metrics & Telemetry

### GET /api/rag/metrics

Totals, per-source breakdown, last ingest timestamp.

```bash
curl http://localhost:3082/api/rag/metrics
# => { "ok": true, "data": { "totals": { "documents": 12, "chunks": 340 }, "bySource": [...], "lastIngest": { "timestamp": "...", "source": "docs" } } }
```

### GET /api/rag/telemetry/ingest

Recent ingest telemetry. Params: `?limit=50&source=X&status=success|failed`

```bash
curl "http://localhost:3082/api/rag/telemetry/ingest?limit=10"
# => { "ok": true, "data": { "jobs": [{ "jobId": "...", "source": "api", "status": "success", "totalTimeMs": 230 }], "count": 1 } }
```

### GET /api/rag/telemetry/ingest/summary

Aggregate ingest stats (all-time + last 24h).

```bash
curl http://localhost:3082/api/rag/telemetry/ingest/summary
# => { "ok": true, "data": { "totalIngests": 150, "successRate": 97.33, "avgTotalTimeMs": 450, "last24h": { "total": 12, "success": 11, "failed": 1 }, "lastIngestAt": "..." } }
```

## Cache

### POST /api/rag/cache/clear

Clear in-memory embedding cache.

```bash
curl -X POST http://localhost:3082/api/rag/cache/clear
# => { "ok": true, "data": { "cleared": true } }
```

## Qdrant Snapshots

These endpoints proxy collection-level Qdrant snapshots. Snapshot names may
contain letters, numbers, dots, underscores, and hyphens only.

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/rag/snapshots` | POST | Create a snapshot of the configured collection |
| `/api/rag/snapshots` | GET | List collection snapshots |
| `/api/rag/snapshots/:name` | DELETE | Delete a named snapshot |
| `/api/rag/snapshots/:name/restore` | POST | Restore the collection from a named snapshot |

Snapshot operations return 502 when Qdrant cannot complete the request. Delete
returns 404 when Qdrant reports that the named snapshot does not exist.

## Error Codes

| Code | HTTP | Meaning |
|------|------|---------|
| `VECTOR_STORE_UNAVAILABLE` | 503 | Qdrant unreachable |
| `EMBEDDING_SERVICE_UNAVAILABLE` | 503 | Embedding provider (Ollama) down |
| `SCAN_ALREADY_RUNNING` | 409 | Ingest-scan already in progress |
| `REINDEX_ALREADY_RUNNING` | 409 | Reindex migration in progress |
| `CONFIRMATION_REQUIRED` | 400 | Destructive op needs `confirm: true` |
| `MONGODB_UNAVAILABLE` | 503 | MongoDB not connected |
| `INVALID_ROOTS` | 400 | Scan roots outside configured paths |
| `JOB_NOT_RUNNING` | 400 | Cannot cancel non-running job |
| Validation messages | 400 | Missing/invalid fields |
