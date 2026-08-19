# Agent X architecture

Status: canonical product architecture, verified 2026-08-17.

## Product topology

| Component | Responsibility | Depends on |
|---|---|---|
| Core (`core`, internal 3080) | Inference boundary, model discovery/routing, prompts, telemetry, Dreaming, product UI and APIs | MongoDB; optional Ollama; Benchmark and RAG service contracts |
| Benchmark (`benchmark`, internal 3081) | Runs evaluations, profiles models, scores evidence, renders comparisons | MongoDB; Core; optional Ollama |
| RAG (`rag`, internal 3082) | Ingests bounded documents, embeds chunks, retrieves knowledge, exposes the RAG API | MongoDB; Qdrant; Core embedding proxy |
| `shared/` | Small cross-service contracts with identical semantics | No runtime service |
| MongoDB | Product metadata and evaluation state | Internal only |
| Qdrant | Vector storage | Internal only |
| Ollama | User-selected inference runtime | Optional; native, isolated Docker, or explicit remote endpoint |

The default Compose project is `agentx-ecosystem`. Product ports 3180–3182 bind
to host loopback only; MongoDB, Qdrant, and opt-in Docker Ollama have no host
port. All persisted data uses named volumes owned by this project. There are no
host bind mounts.

## Runtime boundary

`AGENTX_PROFILE=demo` is the product-safe default, including when the variable
is absent. It exposes inference, model,
RAG, Benchmark, and evidence surfaces while rejecting private storage,
environment-specific integrations, household devices, and other operator
routes. It also skips full-profile monitors, backups, host polling, and model
prewarming. Empty integration variables are deliberate and must not fall back
to a private or production address.

Environment-specific automation and private adapters live outside this
repository. They may consume bounded product APIs. In an explicit full-profile
deployment, Core may also load a separately pinned absolute-path trusted
extension through its disabled-by-default versioned seam. Agent X never embeds
the private implementation, secret, mount, or deployment, and the seam is not
an operations extension framework. See [Trusted extensions](TRUSTED_EXTENSIONS.md).

A private Data service may independently expose a bounded, read-only API to
agents. Data remains outside the product boundary: it is neither a product
service nor a skill owned or loaded by Agent X.

## Contract rules

- Cross-service calls use Docker DNS (`core`, `benchmark`, `rag`, `mongo`,
  `qdrant`); browser links use explicit localhost public URLs.
- The product starts and presents its UI without Ollama. Inference and
  embeddings report unavailable until the user selects an endpoint/model.
- Readiness requires MongoDB for all services and Qdrant for RAG. Ollama and
  embedding models are reported as optional capabilities, not startup gates.
- A remote Ollama endpoint is an explicit operator choice. The repository does
  not contain or default to a private or production network.
- Live qualification and maintenance scripts require their target host, model,
  context, and external service endpoints explicitly. Fixed benchmark matrices
  remain valid when the fixed values are the experiment being measured.
- A service does not recreate another service's Mongoose schema to query its
  collections. Cross-service evidence moves through the owning service's API;
  unavailable evidence stays unavailable.
- Trusted extensions use injected Core contracts for Core-owned data. In
  particular, transcript reads and lifecycle mutations go through the scoped
  conversation lifecycle service rather than direct collection access.
- Model identity is the exact installed tag, host, manifest digest, and runtime
  fingerprint. Profiling records evidence for that identity and never creates
  or silently selects a replacement tag; see
  [Exact-artifact profiling](EXACT_ARTIFACT_PROFILING.md).
- Filesystem scanning is disabled by topology: the image has a bounded
  `/data/imports` policy but no host mount. Public demo ingestion uses HTTP.
- Product documentation is permanent and current. Evolution logs, migration
  plans, incident notes, inventories, and audits do not belong in this
  repository.
- `callerDetail` performance classification has one authority in Core. It is
  telemetry metadata, not identity. Both inference execution and rate limiting
  consume the same authenticated effective policy; neither owns a parallel
  caller-prefix list. The scoped `AGENTX_BENCHMARK_TOKEN` can promote only
  Benchmark/profiler families. Same-origin UI proof or the operator token can
  promote internal interactive families. Missing or invalid proof degrades to
  the automated lane and general rate bucket without rejecting inference.

## Conversation lifecycle ownership

Core owns transcript persistence and reversible conversation lifecycle. Its
scoped contract requires `userId` plus `promptName` on every read or mutation
and provides list/get, rename, archive, restore, permanent delete, and ownership
checks. Archive is a Core state transition. External callers use bounded
product APIs and must not add competing transcript stores or write lifecycle
fields directly. Legacy conversations without lifecycle metadata remain active.

## Context ownership

Each deployed model/host pair has one runtime context window. An explicit host
pin or Modelfile controls that resident window; Benchmark records the largest
successful measured window and the actual prompt tokens processed by its probe.
Core reports both capacity and measured evidence without silently shrinking the
resident configuration.

Thinking mode, output budget, and timeout are request execution choices. They
must not create alternate context-window lanes for the same resident model.
Short requests naturally use less prefill work inside the same window, so the
product does not impose fixed 32K, 64K, 98K, or 131K context tiers.

Runtime topology and hardware facts come from configuration, discovery, or
measurement. Addresses, host labels, model names, and artifact byte sizes do
not imply GPU type, VRAM, placement fit, context, or execution role. When
evidence is absent, APIs report an unresolved value rather than manufacturing
a conservative default.

Cross-service primitives with identical semantics live in `shared/`; service
wrappers may add their own I/O but do not fork the underlying policy. Legacy
aliases remain only for verified external contracts or persisted-data
migrations, not as speculative compatibility layers.
