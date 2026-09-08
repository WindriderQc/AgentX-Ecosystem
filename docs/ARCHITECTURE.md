# Agent X architecture

Status: canonical product architecture, verified 2026-09-07.

## Product topology

| Component | Responsibility | Depends on |
|---|---|---|
| Core (`core`, internal 3080) | Inference boundary, model discovery/routing, prompts, telemetry, Dreaming, product UI and APIs | MongoDB; optional Ollama; Benchmark and RAG service contracts |
| Benchmark (`benchmark`, internal 3081) | Runs evaluations, profiles models, scores evidence, renders model and harness comparisons | MongoDB; Core; optional Ollama; optional authenticated AIOps harness broker |
| RAG (`rag`, internal 3082) | Ingests bounded documents, embeds chunks, retrieves knowledge, exposes the RAG API | MongoDB; Qdrant; Core embedding proxy |
| `shared/` | Small cross-service contracts with identical semantics | No runtime service |
| `skills/` | Optional portable Agent Skills for open-format authoring and other reviewed procedures | No runtime service |
| MongoDB | Product metadata and evaluation state | Internal only |
| Qdrant | Vector storage | Internal only |
| Ollama | User-selected inference runtime | Optional; native, isolated Docker, or explicit remote endpoint |

The default Compose project is `agentx-ecosystem`. Product ports 3180–3182 bind
to host loopback only; MongoDB, Qdrant, and opt-in Docker Ollama have no host
port. All persisted data uses named volumes owned by this project. There are no
host bind mounts.

Core owns a separate `recovery_data` named volume mounted at the fixed logical
location `/backups`. The Core image packages only the supported secret-free
Compose and `config/` sources used by configuration archives; runtime env,
credentials, private adapters, personal data, and system crontabs are outside
that allowlist. Public
backup projections expose logical storage and artifact metadata, never service
URLs, credentials, private topology, or filesystem paths.

MongoDB and Qdrant restore are disabled by default and report the stable
`OFFLINE_RESTORE_REQUIRED` policy. Enabling the gate is reserved for a
controlled offline release rehearsal and still requires exact typed
confirmation. Ordinary `down`
preserves `recovery_data`; the exact confirmed `reset` removes it.

Compose, image CI, and release publishing use `docker/core.Dockerfile`,
`docker/benchmark.Dockerfile`, and `docker/rag.Dockerfile` as the only product
image build definitions. Service-local duplicate Dockerfiles are unsupported.
The default MongoDB and Qdrant images and every production Node base image are
pinned to reviewed version tags and immutable multi-platform manifest digests.
`config/container-image-pins.json` is the review inventory; update it together
with the governed declarations.

## Following a feature through the code

Start with the browser module for interaction changes, the route for request
input, and the service for behavior. These are the main paths:

| Feature | Browser | HTTP entry | Main service and storage |
|---|---|---|---|
| Chat and cancellation | [chat-main.js](../core/public/js/chat/chat-main.js), [chat-messaging.js](../core/public/js/chat/chat-messaging.js) | [chat.js](../core/routes/chat.js) | [chatService.js](../core/src/services/chatService.js), [chatServiceStream.js](../core/src/services/chatServiceStream.js), [conversationPersistence.js](../core/src/services/chat/conversationPersistence.js) |
| Model selection and routing | [chat-config.js](../core/public/js/chat/chat-config.js) | [models-unified.js](../core/routes/models-unified.js) | [modelRouter.js](../core/src/services/modelRouter.js), [hostPreferenceService.js](../core/src/services/hostPreferenceService.js) |
| Document import and search | [upload.js](../rag/public/js/upload.js), [search.js](../rag/public/js/search.js) | [rag.js](../rag/routes/rag.js) | [ragStore.js](../rag/src/services/ragStore.js), [embeddings](../rag/src/services/embeddings.js), [vector stores](../rag/src/services/vectorStore/) |
| Benchmark launch and results | [batch-config.js](../benchmark/public/js/benchmark-v2/batch-config.js), [index.js](../benchmark/public/js/benchmark-v2/index.js) | [benchmark/core.js](../benchmark/routes/benchmark/core.js), [results.js](../benchmark/routes/benchmark/results.js) | [execution.js](../benchmark/src/services/benchmark/execution.js), [batchOrchestrator.js](../benchmark/src/services/benchmark/batchOrchestrator.js), [BenchmarkBatch](../benchmark/models/BenchmarkBatch.js), [BenchmarkResult](../benchmark/models/BenchmarkResult.js) |

Ordinary and streamed chat share `resolveChatRequest` in the chat route;
single and bulk document imports share `validateIngestDocument` in the RAG
route. Change those common paths when an input rule should apply to both.
Transport details stay in their handlers. Use `shared/` for behavior that
actually has the same meaning in multiple services.

Chat's Stop action ends delivery immediately and preserves the partial turn.
Core drains an already dispatched Ollama response to its final record before
releasing the host reservation; local generation may continue. The
existing five-minute upstream deadline still applies. A broken stream without
terminal proof remains quarantined, rather than being treated as finished.

For validation commands and disposable test databases, see [Testing](TESTING.md).

Core stops its background producers and closes its HTTP listener on SIGTERM
or SIGINT. An active watchdog cycle finishes its dispatched probe without
starting another host or recovery operation. Inference completion/quarantine
receipts are written before telemetry is flushed and Mongo disconnects. Core
then exits naturally; failed or stuck shutdown exits nonzero. Compose grants
eleven minutes to cover a default ten-minute inference attempt and its final
receipt. Longer custom operations remain subject to the shutdown deadline;
expiry is a nonzero failure, never proof of upstream completion.

## Runtime boundary

`AGENTX_PROFILE=demo` is the product-safe default, including when the variable
is absent. The same Compose definition accepts an explicit
`AGENTX_PROFILE=full` for the supported product-owned operational surfaces;
this does not configure a private adapter or extension. The demo profile
exposes inference, model,
RAG, Benchmark, and evidence surfaces while rejecting private storage,
environment-specific integrations, household devices, and other operator
routes. It also skips full-profile monitors, backups, host polling, and model
prewarming. Default Compose defines no private-integration credentials or
deployment addresses.

Benchmark and profiling use Core's workload reservations, host claims, and
release/recovery handlers in both profiles. These product APIs retain their
existing `/api/nerve-center/` paths. The Nerve Center page, manual pin editing,
host swaps, and maintenance controls remain full-profile features.

Environment-specific automation and private adapters live outside this
repository. They may consume bounded product APIs. In an explicit full-profile
deployment, Core may also load a separately pinned absolute-path trusted
extension through its disabled-by-default versioned seam. Agent X never embeds
the private implementation, secret, mount, or deployment, and the seam is not
an operations extension framework. See [Trusted extensions](TRUSTED_EXTENSIONS.md).

Independent applications should prefer the versioned
[external consumer API](EXTERNAL_CONSUMERS.md). It exposes stateless
routed inference and a sanitized effective-routing snapshot over HTTP. Core never persists consumer transcripts, returns host URLs, accepts a
consumer-selected host, or treats caller identity metadata as lane authority.
Streaming is SSE and client disconnect cancels the Core-owned upstream request.

Nestor-style assistants may use the narrower fixed-operation
[Nestor consumer API](NESTOR_CONSUMER.md). It provides the same Core-owned
routing and real SSE cancellation while keeping persona, transcript, and speech
behavior in the separately deployed consumer.

A private Data service may independently expose a bounded, read-only API to
agents. Data remains outside the product boundary: it is neither a product
service nor a skill owned or loaded by Agent X.

Every separately operated consumer follows the
[external adapter consumer contract](EXTERNAL_ADAPTER_CONTRACT.md). It limits
the integration to versioned public APIs and defines identity, freshness,
provenance, timeout, degraded-state, authentication, and deployment ownership
without importing the external implementation into this repository.

Portable skills are static distribution artifacts. No Agent X service loads or
executes them automatically. Installation, filesystem access, mutation
approval, and runtime-specific configuration remain owned by the consuming
agent runtime.

External harnesses may exchange versioned
[worker envelopes and receipts](WORKER_HARNESS_CONTRACTS.md) through a
separately operated adapter. Agent X owns the neutral task/tool/policy contract
and Benchmark comparison; it does not own harness identity, private
conversations, memory, credentials, workspace realization, or execution loop.
Benchmark may invoke that adapter only through the disabled-by-default
[harness broker contract](BENCHMARK_HARNESS_BROKER.md). Product receives a
secret-free target catalog and public receipts; the AIOps deployment retains
all provider configuration, executable pins, profiles, sessions and secrets.

## Contract rules

- Every service health response includes the same additive identity fields:
  `service`, `version`, `profile`, `revision`, and ISO-8601 `ts`. Released
  images embed the source commit as `revision`; local image builds identify
  themselves as `working-tree`. Aggregators must keep these fields with the
  observation so mixed profiles, revisions, or stale evidence are visible.
- Full-profile operator surfaces consume the read-only ecosystem snapshot v2
  at `/api/nerve-center/ecosystem`. It combines host/model observations,
  routing, product-service readiness, build/profile consistency, alerts, and
  source timestamps without inventing values for unavailable evidence. Its
  additive `evidenceTrust` scorecard keeps operational health separate from
  reporting integrity, applies a zero-contradiction budget to internal counts,
  and labels stale or missing observation sources explicitly.
- Cross-service calls use Docker DNS (`core`, `benchmark`, `rag`, `mongo`,
  `qdrant`); browser links use explicit IPv4-loopback public URLs.
- Canonical pages do not depend on WAN-hosted scripts, stylesheets, or fonts.
  Browser libraries and type assets are pinned production dependencies served
  by each product service through immutable, exact-file routes; `node_modules`
  is never exposed as a static root.
- The product starts and presents its UI without Ollama. Inference and
  embeddings report unavailable until the user selects an endpoint/model.
- Readiness requires MongoDB for all services and Qdrant for RAG. Ollama and
  embedding models are reported as optional capabilities, not startup gates.
- A remote Ollama endpoint is an explicit operator choice. The repository does
  not contain or default to a private or production network. Benchmark admits
  only path-free HTTP(S) origins, rejects metadata/link-local/unspecified and
  multicast targets (including resolved DNS answers), never follows Ollama
  redirects, and bounds inventory responses. Port 11434 is the default;
  first-time setup on another port requires the exact origin in
  `AGENTX_OLLAMA_ALLOWED_TARGETS` or existing operator configuration.
- Live qualification and maintenance scripts require their target host, model,
  context, and external service endpoints explicitly. Fixed benchmark matrices
  remain valid when the fixed values are the experiment being measured.
- Native-tool support follows the fail-closed
  [exact-artifact qualification contract](NATIVE_TOOL_QUALIFICATION.md).
  Benchmark alone persists repeated mocked-tool evidence; Core consumes its
  bounded projection. Legacy booleans remain inventory hints, and missing,
  interrupted, inconclusive, expired, or identity/version-drifted evidence can
  never become an `unsupported` conclusion.
- Playground renders a conversational cockpit over the same routing and host
  controls used by chat. It may display bounded health, fleet, and route
  evidence, but it does not own a second router, host registry, service-health
  store, or model-selection policy.
- A service does not recreate another service's Mongoose schema to query its
  collections. Cross-service evidence moves through the owning service's API;
  unavailable evidence stays unavailable.
- Trusted extensions use injected Core contracts for Core-owned data. In
  particular, transcript reads and lifecycle mutations go through the scoped
  conversation lifecycle service rather than direct collection access.
- External consumers use the HTTP consumer contract for routed inference. They
  own application state and conversation persistence, cannot select an
  inference host, and cannot derive private topology from the routing snapshot.
- External worker evidence uses shared `WorkerEnvelope v1` and
  `WorkerReceipt v1` normalization. Benchmark accepts only receipts bound to
  their supplied normalized envelopes. When the optional broker is enabled,
  Benchmark may request one bounded harness cell but still cannot contact a
  provider directly, receive a provider credential, retain a harness
  transcript, mutate routing, or promote a candidate.
- Model identity is the exact installed tag, host, manifest digest, and runtime
  fingerprint. Profiling records evidence for that identity and never creates
  or silently selects a replacement tag; see
  [Exact-artifact profiling](EXACT_ARTIFACT_PROFILING.md).
- Cloud/local comparisons use Benchmark's stateless
  [lane accounting contract](CLOUD_LOCAL_LANE_ACCOUNTING.md). Local,
  free-cloud, and paid-cloud observations remain separate, family/kid lanes
  fail closed to local candidates, paid receipts use immutable integer
  nanodollars plus effective price provenance, and comparison has no routing
  authority. Those accounting endpoints remain stateless. Optional live cloud
  Benchmark cells use the separate authenticated harness-broker contract,
  exact live identity/price checks, one-use batch spend ceilings and public
  per-call receipts. Neither path has routing authority.
- Degraded cross-model retry is never implicit. It requires the existing
  server-side degraded-fallback policy, a Core-managed non-stream route, and
  the request field `allowCrossModelFallback: true`. The alternate must be an
  operator-pinned local model on an approved host whose current exact artifact
  matches non-stale Benchmark qualification and whose context fits the input.
  Responses expose the primary and actual model/host through degraded metadata
  and `X-AgentX-Degraded-*` headers. Direct benchmark/profiler calls and
  explicit host overrides cannot change models.
- Filesystem scanning is disabled by topology: the image has a bounded
  `/data/imports` policy but no host mount. Public demo ingestion uses HTTP.
- A portable skill grants no filesystem, vault, network, or RAG authority. The
  consuming runtime must provide and govern every capability separately.
- Product documentation is permanent and current. Evolution logs, migration
  plans, incident notes, inventories, and audits do not belong in this
  repository.
- `callerDetail` performance classification has one authority in Core. It is
  telemetry metadata, not identity. A caller may declare itself with the plain
  `X-AgentX-Caller` header; the value is attribution only.

## Cancellation lifecycle

Benchmark stop is a durable state transition, not just an in-process abort.
The stop path first conditionally commits `stopped`, an idle current-test
projection, and cleared execution ownership for an active batch. Only after
that write succeeds does it abort the batch's registered outbound controllers.
It repeats the abort after best-effort result reconciliation to catch work
registered during the transition. Reconciliation failure cannot resurrect the
worker or turn a committed stop into a failed stop request. Completion and
crash finalization also use conditional terminal transitions, so a stale
runner cannot overwrite a stop that won the race.

Core creates one bounded caller-disconnect signal before host admission. Local
gate waiters are removed when that signal aborts; shared admission polling is
abortable and releases a slot if cancellation wins immediately after the slot
write. The same signal covers the upstream fetch and response-body read, with
caller cancellation distinguished from the owned request timeout. Once the
caller has gone away, the route suppresses degraded fallback and downstream
response work, cleans up listeners, and releases any admission slot.

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
