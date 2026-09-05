# Runtime coordination contract

Status: Product contract for Core/Benchmark coordination. This contract is
required by deployment and benchmark clients; it is not a deployment receipt.

Core owns one MongoDB coordination record. A maintenance lease and Benchmark
workload admissions are mutually exclusive through a single atomic compare-and-
set boundary. Core mints every `leaseId`, `admissionId`, and `generation`.
Clients may choose only a stable `requestId` (or `idempotencyKey`) for retry.
The authenticated service identity, never a request-body field, becomes the
stored `principal`.

## Authentication and envelope

Maintenance calls require Core operator access. An AIOps service normally sends
`Authorization: Bearer <AGENTX_OPERATOR_TOKEN>` (the existing
`X-AgentX-Operator-Token` form is also supported). Workload-admission calls
require the exact `X-AgentX-Benchmark-Token`; trusted-origin and loopback UI
classification do not grant Benchmark capability.

Successful responses use:

```json
{ "status": "success", "data": {} }
```

An exclusion conflict is HTTP 409 with `status: "error"` and a non-capability
`data` object. Authentication failures are HTTP 403. A client must validate all
identity fields in the receipt below, not only the boolean result.

## Maintenance lease

Acquire before any deploy or force-recreate mutation:

`POST /api/nerve-center/maintenance-leases`

```json
{ "requestId": "deploy-unique-id", "scope": "force-recreate", "ttlMs": 120000 }
```

The generation is deliberately absent from the acquire body. HTTP 200 returns:

```json
{
  "status": "success",
  "data": {
    "acquired": true,
    "leaseId": "core-uuid",
    "generation": "core-uuid",
    "principal": "operator-token",
    "requestId": "deploy-unique-id",
    "scope": "force-recreate",
    "acquiredAt": "2026-09-04T00:00:00.000Z",
    "heartbeatAt": "2026-09-04T00:00:00.000Z",
    "expiresAt": "2026-09-04T00:02:00.000Z"
  }
}
```

Renew with `POST /api/nerve-center/maintenance-leases/:leaseId/heartbeat`
and body `{ "generation": "core-uuid", "ttlMs": 120000 }`. The success data
contains `heartbeat: true` plus the exact `leaseId`, `generation`, `principal`,
`requestId`, `scope`, `heartbeatAt`, and `expiresAt` from the Core-owned state.

Release only after the maintenance mutation and verification have drained:
`DELETE /api/nerve-center/maintenance-leases/:leaseId`, body
`{ "generation": "core-uuid" }`. Core removes the matching state by CAS and
returns the identity from the removed record:

```json
{
  "status": "success",
  "data": {
    "released": true,
    "leaseId": "core-uuid",
    "generation": "core-uuid",
    "principal": "operator-token",
    "requestId": "deploy-unique-id",
    "scope": "force-recreate",
    "releasedAt": "2026-09-04T00:01:00.000Z"
  }
}
```

## Benchmark workload admission

Every Benchmark execution path acquires admission before creating or mutating
its durable workload record. This includes local/cloud batches, profile,
profile-host, host-test, context sweeps, and native harness campaigns.

`POST /api/nerve-center/workload-admissions`

```json
{
  "requestId": "benchmark:workload-id",
  "workloadId": "workload-id",
  "kind": "benchmark",
  "batchId": "optional-batch-id",
  "hosts": ["http://ollama:11434"],
  "ttlMs": 120000
}
```

HTTP 200 returns `acquired: true` plus Core-minted `admissionId` and
`generation`, authenticated `principal`, and the exact `requestId`,
`workloadId`, `kind`, `batchId`, `hosts`, `acquiredAt`, `heartbeatAt`, and
`expiresAt`. Retry after an ambiguous transport failure must reuse the same
request id; Core returns the same proof rather than creating another admission.

Heartbeat is `POST /api/nerve-center/workload-admissions/:admissionId/heartbeat`
with `{ "generation": "core-uuid", "ttlMs": 120000 }`. Release is
`DELETE /api/nerve-center/workload-admissions/:admissionId` with
`{ "generation": "core-uuid" }`. Their success receipts repeat the exact
admission identity; release also contains an ISO `releasedAt`. Benchmark keeps
the admission through terminal persistence/finalization and releases host
claims before releasing this runtime-wide admission.

`GET /api/nerve-center/runtime-coordination/active` is operator-only and
redacts generations and request ids. Expired entries are removed with
generation/expiry-fenced writes; a renewed lease cannot be erased by a stale
reaper observation.

## Exact host restoration receipt

Host claim acquisition remains
`POST /api/nerve-center/host-preferences/:encodedHost/benchmark-claim`.
Its successful `data` includes `batchId`, `claimGeneration`, `prevStatus`,
`snapshotExact: true`, and `snapshotIdentity` (a lowercase 64-hex SHA-256).
Benchmark must retain that entire acquisition proof and reject a legacy or
partial acknowledgement before any host mutation. The authenticated nested
`data.pref.benchmarkClaim.preClaimRuntime` is part of the receipt: it must
contain `exact: true`, `capturedAt`, source `ollama_ps`, the matching
`identityDigest`, and the complete resident identities. The top-level fields
are convenience projections and must agree with that nested snapshot.
Host-claim heartbeat success repeats the same `batchId`, `claimGeneration`,
`prevStatus`, `snapshotExact`, and `snapshotIdentity`; Benchmark treats any
divergence as ownership loss and aborts/drains in-flight work.

Host claim release remains:

`DELETE /api/nerve-center/host-preferences/:encodedHost/benchmark-claim/:batchId`

with `{ "claimGeneration": "claim-generation", "admissionId": "...", "admissionGeneration": "...", "excludedModels": [] }` and
exact Benchmark service authentication. `data.released: true` is valid only
when `data.releaseReceipt.contract` is
`agentx.benchmark-claim-release/v1`. The receipt binds:

- `hostUrl`, `batchId`, and `claimGeneration`;
- `snapshot.identityDigest`, `appliedIdentityDigest`, `exact`, `capturedAt`,
  source, the exact `filterEvaluatedAt` used for TTL decisions, resident count,
  and every resident's model, digest, artifact size, VRAM size, context, and
  expiry;
- `verification.ready: true`, `verified: true`, `degraded: false`, mode
  `exact_runtime_snapshot`, and the matching snapshot identity;
- `state.claimCleared: true`, `finalizerCleared: true`, the restored status,
  and an ISO `releasedAt`.

If capture, restoration, verification, or fence clearing is incomplete, Core
returns `released: false` and retains a recoverable fence. A legacy claim without
an exact snapshot cannot produce a successful release receipt. Consumers must
recompute both digests and the expired resident membership at
`filterEvaluatedAt`; the arrays and digest strings are not trusted projections.
