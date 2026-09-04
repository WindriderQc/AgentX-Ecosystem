# Agent X architecture

Status: canonical product architecture, verified 2026-08-28.

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
that allowlist. Core and RAG alone receive an ephemeral launcher-managed
recovery token, and every RAG snapshot route fails closed without it. Public
backup projections expose logical storage and artifact metadata, never service
URLs, credentials, private topology, or filesystem paths.

MongoDB and Qdrant restore are disabled by default and report the stable
`OFFLINE_RESTORE_REQUIRED` policy. Enabling the gate is reserved for a
controlled offline release rehearsal and still requires exact typed
confirmation. The supported disposable recovery drill creates three isolated
Compose projects with no published ports or bind mounts, proves corruption is
rejected before mutation, restores representative MongoDB and Qdrant state,
then starts the exact product images for identity and journey checks. Only its
schema-validated privacy-safe receipt may claim that rehearsal passed. Ordinary `down`
preserves `recovery_data`; the exact confirmed `reset` removes it.

Compose, image CI, and release publishing use `docker/core.Dockerfile`,
`docker/benchmark.Dockerfile`, and `docker/rag.Dockerfile` as the only product
image build definitions. Service-local duplicate Dockerfiles are unsupported.
The default MongoDB and Qdrant images, every production Node base image, and
release-test fixture bases are pinned to reviewed version tags and immutable
multi-platform manifest digests. `config/container-image-pins.json` is the
single review inventory; `scripts/verify-container-image-pins.js` fails CI if a
governed declaration drifts or becomes mutable. Updating a dependency therefore
requires an explicit inventory and declaration change followed by Compose,
image-build, health, and recovery validation.

`docker-compose.live-cancellation.yml` is an isolated release-test topology,
not a supported deployment topology. It runs real full-profile Core and
Benchmark with an ephemeral MongoDB and a deterministic Ollama-compatible
socket fixture on one internal network. It publishes no ports, creates no
persistent volume or bind mount, and provides no host-gateway path. The fixture
is test infrastructure for observing cancellation; it is not an adapter,
model runtime, or product service.

The release gate checks that boundary twice: first from the rendered Compose
configuration, then from the exact four healthy running containers and their
project-scoped network. Runtime inspection rejects persistent/bind mounts,
published ports, extra hosts, privileged mode, host networking, or attachment
to another network.

`docker-compose.upgrade-rollback.yml` is a second isolated release-test
topology. It consumes only digest-pinned runtime images, retains representative
MongoDB and Qdrant state in three unique-project volumes across a candidate image
swap and exact rollback, and publishes no port or host attachment. Its driver
verifies both rendered configuration hashes, live image content identities,
service health identities, bounded product reads, state/schema fingerprints,
stable data containers, and zero project residue. The retained receipt contains
no service or registry address, fixture content, raw database/container
identifier, or secret. See
[Immutable-image upgrade and rollback rehearsal](UPGRADE_ROLLBACK_REHEARSAL.md).

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

Environment-specific automation and private adapters live outside this
repository. They may consume bounded product APIs. In an explicit full-profile
deployment, Core may also load a separately pinned absolute-path trusted
extension through its disabled-by-default versioned seam. Agent X never embeds
the private implementation, secret, mount, or deployment, and the seam is not
an operations extension framework. See [Trusted extensions](TRUSTED_EXTENSIONS.md).

Independent applications should prefer the versioned
[external consumer API](EXTERNAL_CONSUMERS.md). It exposes authenticated,
stateless routed inference and a sanitized effective-routing snapshot over
HTTP. Core never persists consumer transcripts, returns host URLs, accepts a
consumer-selected host, or treats caller identity metadata as lane authority.
Streaming is SSE and client disconnect cancels the Core-owned upstream request.
The API uses a route-scoped external-consumer token so applications do not need
the broader operator credential.

Nestor-style assistants may use the narrower fixed-operation
[Nestor consumer API](NESTOR_CONSUMER.md). It provides the same Core-owned
routing and real SSE cancellation while keeping persona, transcript, and speech
behavior in the separately deployed consumer. Both versioned consumer families
use the route-scoped external-consumer token for non-loopback Core calls.

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
  telemetry metadata, not identity. Both inference execution and rate limiting
  consume the same authenticated effective policy; neither owns a parallel
  caller-prefix list. The scoped `AGENTX_BENCHMARK_TOKEN` can promote only
  Benchmark/profiler families. Same-origin UI proof is a CSRF boundary, not
  machine identity, and grants credential-free mutations only across the local
  loopback UI boundary. `AGENTX_OPERATOR_UI_HOSTS` can admit remote hostnames
  for read/UI routing. A deployment may pair that allowlist with exact
  `AGENTX_TRUSTED_UI_PROXY_ADDRESSES` socket peers so its own reverse proxy can
  carry same-origin UI requests without trusting forwarded client metadata or
  a subnet; Host, Origin/Referer, and browser same-origin checks still apply.
  The operator
  token (normally injected by a trusted proxy) is the remote administrative
  path. Missing or
  invalid proof degrades to the automated lane and general rate bucket without
  rejecting inference. Protected Core APIs reject unknown Host values even
  when DNS resolves them to loopback, preventing DNS-rebinding authority.
  Standalone Core, Benchmark, and RAG listeners default to loopback. Compose
  explicitly binds the service processes to their isolated product network and
  publishes only host-loopback ports; internal-host and loopback-port proxy
  trust are enabled only inside that bounded topology.

Remote machine mutations use purpose-scoped credentials that are admitted
only to their exact route families and revalidated by the owning router.
Memory Review producers, schedule synchronizers/claimers, pipeline workers,
and alert-delivery reporters therefore have separate tokens. They cannot use
those credentials as general operator authority or cross into one another's
routes. Pipeline finalization is an additional action-variant boundary:
`status=done` cannot be authorized by the worker credential and remains a
trusted reviewer/operator transition.

## Cancellation lifecycle and proof

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

Product CI proves the Benchmark worker path against the isolated socket
topology above. The fail-closed schema-v1 receipt is bound to the exact build
revision and rendered Compose hash and contains these seven ordered assertions:
`socket-open-before-stop`, `socket-closed-within-budget`, `no-next-prompt`,
`batch-stopped`, `claim-released`, `service-identities-stable`, and
`isolated-topology`. Its privacy contract excludes addresses, raw prompts and
responses, fixture sentinels, database and batch identifiers, and secrets. The
retained artifact is named from the exact commit and Product CI run attempt;
release promotion requires that exact artifact. It is evidence for this
controlled cancellation scenario only and does not claim a real model-quality
result or expand the supported product boundary.

## Outbound network ownership

`config/outbound-http-sinks.json` schema v2 is the authority for product-owned
HTTP egress from long-running service processes. It inventories the 69
recognized direct/static physical constructors across Core, Benchmark, RAG,
and `shared/`, and separates an enforced logical operation from its acyclic
delegate and approved physical
transport sink ID. A migrated operation binds a literal operation ID, exact
method/path/search family, authority source, response mode, lifecycle deadline,
request/response byte caps, and a reviewed executable `transportAdapter`
expression before the shared executor performs I/O; the approved transport must
attest the connected peer rather than trusting URL validation alone.

The current staged migration has 46 enforced logical operations through eight
delegates and three approved peer-verifying transports: eight Core operations,
20 Benchmark operations, and 18 RAG operations. The other 66 physical sinks
remain explicitly classified as frozen `legacy-direct` migration debt (42 in
Core, 24 in Benchmark, and zero in RAG). Registry verification scans new shared
`.js`, `.cjs`, and `.mjs` runtime files, rejects unsafe graph sources and recognized direct/static
constructor aliases, and freezes each legacy sink's
ID/service/source/constructor/policy fingerprint, so the debt can only stay flat
or shrink.

The verifier is a bounded static CI guard, not a whole-program JavaScript
dataflow proof. Approved transport implementations, their reviewed executor
bindings, and sanctioned dependency-injection callers remain part of the
in-process trusted computing base. Exact binding metadata detects a changed
`transportAdapter` expression; full AST analysis or a central-import restriction
is the planned hardening for complex capability escapes.

Supported product CLIs and maintenance scripts are intentionally outside these
service-process totals. `config/maintenance-http-sinks.json` separately freezes
10 reviewed physical calls across 29 non-test sources: all have lifecycle
deadlines and bounded responses, nine reject redirects explicitly, and one
follows them explicitly. The two PowerShell launcher consumers share one
loopback-only, stream-bounded physical transport. Its CI verifier is
a direct/static inventory, not a call-graph proof or shared-executor guarantee.

This is not complete uniform outbound enforcement. The next tranche moves the
remaining buffered fan-outs behind the bounded executor; stream-sensitive and
recovery paths follow with their own cancellation and size contracts.

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
