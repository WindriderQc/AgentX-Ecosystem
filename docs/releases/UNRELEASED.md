# Agent X Ecosystem — Unreleased

Status: working-tree and `main` hardening after v0.1.1. These changes have no
new version, release tag, or published release manifest yet and are not part of
v0.1.1.

## LAN simplification (2026-09-07)

The platform is a private-LAN home prototype (see `SECURITY.md`). The
following were removed from Product rather than kept behind flags:

- Express rate limiting (all limiters and 429 responses).
- The public-exposure guard, the same-origin/Origin/Referer/Sec-Fetch-Site
  operator guard, `shared/apiHostGuard` (untrusted-host and cross-site
  mutation rejection), and trusted-UI-proxy attestation
  (`AGENTX_TRUSTED_UI_PROXY_ADDRESSES`, `AGENTX_TRUST_LOOPBACK_PROXY_UI`,
  `AGENTX_TRUST_INTERNAL_SERVICE_HOSTS`, `AGENTX_OPERATOR_UI_HOSTS`).
- `CORS_ORIGINS`; CORS is now open.
- Every product token: operator/admin, benchmark, pipeline, MCP, runtime
  bridge, OpenClaw bridge, recovery, Codex usage, memory review, schedule,
  alert delivery, platform event, and external consumer. A caller may declare
  its identity with the plain `X-AgentX-Caller` header (attribution only).
- The trusted-extension `security` contract; extensions no longer receive a
  `security` object.
- The pipeline worker/operator authority split; any caller may set
  `status=done`.
- The `e2e/` Playwright suite, `scripts/` (every `verify-*`/`assemble-*` CI
  gate and its `config/*.json` registry: action-authorization matrix,
  mutation-route policy, outbound and maintenance HTTP sinks), the
  live-cancellation, recovery-drill, and upgrade-rollback Compose files, and
  the clean-first-run, live-cancellation, and benchmark-trust-portability CI
  jobs.

Product CI is now per-service `npm test` plus a Compose render;
`publish-images` builds the three images on green `main` and prints their
digests. The Core maintenance lease and Benchmark workload admission remain,
without any token.

## Signal evidence and honest surfaces (product review remediation, 2026-09-06)

- New Signal Evidence Contract v1 (`shared/signalEvidence.js`, bundled for the
  browser as `/dist/signal-evidence.js`): one shape for every rendered rate,
  average, count, delta and ranking with explicit evidence states, sample
  size, provenance, freshness and a deterministic rendering projection. A zero
  is printed only when measured, an empty denominator never yields a
  percentage, a ranking names a best only with two comparable candidates and
  no tie, and freshness is unknown without a timestamp.
- Activity: classifier time, RAG adoption, RAG-versus-non-RAG delta and the
  cost-efficiency ranking render contract signals (`—` / Not observed, Low
  sample with n, no Best without a comparator); the inference summary,
  rag-stats and costs routes publish additive `signals` blocks and return
  `null` rather than `0` on empty denominators.
- Playground: the Council button is an explicit `Open in Council` handoff
  (anchor navigation, in-chat feedback, `source=playground`), and private
  reasoning renders only when Thinking is forced, inside a closed disclosure.
- Council participant turns and synthesis are recorded as inference
  telemetry (`caller: council`, `core-council-v1`, correlation by roundtable
  id) without prompt, response or reasoning. RAG `POST /search` records
  bounded search events and `GET /telemetry/search/summary` reports them
  under the contract.
- Navigation parity: validated deployment launchers are republished in
  `GET /api/config` (`navigation.trustedRuntimeNavItems`, with optional
  `owner` and `description`), Benchmark and RAG render the same
  `External runtimes` entries as Core, and the portal lists them with an
  honest empty state. Frozen Planning moves under `History & reference`.
- RAG status reports corpus `freshness` (fresh, stale or unknown) from its
  ingest history under a declared rule; Activity and Nerve Center render it
  separately from readiness. Nerve Center distinguishes an unreachable
  Benchmark from a reachable one whose drift endpoint failed and shows the
  functional judge readiness. Dreaming Review cross-checks the active
  `memory_review_no_eligible_evidence` alert and shows cadence facts.
- Pipeline: a previewed, confirmed, cancellable `Mark superseded` action
  closes a task in favour of its replacement with an immutable resolution and
  audit entries on both tasks; superseded tasks cannot be re-queued without an
  explicit reopen. Models category filters classify capability evidence as
  evidence, declared, not eligible or unknown, and never present unknown as
  incapable.

## Product trust and experience

- Core now coordinates deployment maintenance and every Benchmark workload
  through one generation-fenced, mutually exclusive lease record. Redacted
  status, idempotent retry, TTL recovery, and identity-bound heartbeat/release
  receipts close deploy-vs-benchmark races.
- Benchmark host release now restores and verifies the exact pre-claim Ollama
  resident set, including digest, artifact/VRAM size, context, and expiry,
  before clearing the fence, and returns an identity-bound restoration receipt.
- Inference analytics now groups consumer traffic by the server-attested
  `consumerContract` field and no longer returns caller-controlled
  `callerDetail` aggregate values. The external-consumer route supplies its
  own bounded contract label so attribution never depends on a body claim.
- Product health now carries version, profile, revision, and observation time;
  the full-profile ecosystem snapshot reconciles readiness, freshness,
  identity consistency, source coverage, and a zero-contradiction budget.
- Benchmark stop failure is now truthful and recoverable: the live view and
  polling remain active, the same control can retry, and only a terminal API
  acknowledgement moves the page to idle. The hero consumes the same active
  batch array contract as the cockpit.
- Benchmark now commits a conditional, durable `stopped` transition before it
  aborts registered batch requests. It repeats the abort after
  best-effort result reconciliation, while conditional completion/crash
  finalization prevents a stale runner from overwriting a stop that won the
  terminal race.
- Core caller cancellation now spans host-gate admission, the upstream fetch,
  and response-body consumption. Cancelled local waiters are removed, shared
  admission polling is abortable, a just-won shared slot is released, and a
  disconnected caller cannot trigger degraded fallback or a later response.
- Benchmark setup invalidates verified host/model state whenever the endpoint
  changes, aborts superseded probes, ignores out-of-order responses, and emits
  stable failure codes. A stale successful probe can no longer enable Save.
- Playground streaming now distinguishes request-body completion from a real
  downstream disconnect, includes the current prompt exactly once, owns abort
  state until the active attempt settles, and renders one assistant turn for
  one terminal `done` receipt. RAG search now follows canonical overall and
  MongoDB readiness instead of enabling itself from partial dependency checks.
- Persisted Playground replies now offer honest **Ask again** behavior, while
  failed or cancelled attempts expose **Retry** without duplicating the user
  bubble. Exact source IDs are validated against the caller-owned persisted
  pair before inference and echoed as bounded JSON/SSE provenance.
- When a configured routed model is absent, Playground now offers an explicit,
  keyboard-accessible switch to an installed Manual model. The choice is saved
  locally, the composer regains focus, and the server-owned Standard route is
  left unchanged; no silent fallback is introduced.
- Benchmark evidence distinguishes unrun coverage from scored quality, while
  RAG and operational projections avoid inventing unavailable evidence or
  exposing deployment topology.
- Prompt creation validates normalized names and bounded field types, preserves
  intentional system-prompt formatting, and retries only unique-index version
  races before returning a recoverable conflict.
- RAG upload validation now matches the API text and overlap contracts. Failed
  deletion remains inline and retryable, chunk previews use semantic keyboard
  controls, and capped inventory labels no longer imply whole-corpus counts.
- Provider-neutral WorkerEnvelope/WorkerReceipt v1 contracts now bind logical
  work, budgets, policies, exact harness/model/API/environment identity, and
  deterministic evidence fingerprints. Benchmark can compare imported
  portable or native-ceiling receipts without executing a harness, retaining a
  transcript, changing routes, or promoting a candidate.

## Evidence and recovery

- Backups use a dedicated persistent recovery volume. Configuration archives
  contain only an explicit secret-free product allowlist.
- MongoDB and Qdrant restore remain disabled by default with
  `OFFLINE_RESTORE_REQUIRED`. Existing archives are recovery inputs, not proof
  of a coherent or successfully restorable recovery set.
- A strict `agentx.recovery-bundle/v1` directory contract now binds exact
  product/profile/revision, source image and dependency versions, quiesced
  writer state, fixed config sources, and streamed artifact hashes without
  claiming that capture or restore has succeeded.

## Outbound safety

- Benchmark validates every selected Ollama origin before use or persistence,
  rejects metadata/link-local/unspecified/multicast targets and unsafe DNS
  answers, does not follow redirects, and bounds inventory bodies while the
  request timeout remains active.
- Judge validation now resolves the requested host/model through the configured
  ready-judge authority before any Ollama call. Credentials, paths, fragments,
  query strings, unconfigured hosts, and arbitrary ports fail before outbound
  I/O with stable malformed, unavailable-model, and unreachable responses.

## Test reliability

- Benchmark's affected Windows suites now use one explicitly ready IPv4 test
  server and one keep-alive client per suite with exact teardown. This removes
  transient Supertest loopback churn without increasing timeouts or changing
  product behavior.
- Core, Benchmark, and RAG lockfiles are synchronized with the npm 10 clean
  installer used by the Node 20 images. A clean local Docker build no longer
  fails on omitted optional peer records.
- Both launchers now wait for all three loopback-published health endpoints
  after Compose reports container health, avoiding an immediate post-recreate
  race with Docker Desktop's port forwarding.
- The shared exact-confirmation browser controller is now present in the closed
  Core, Benchmark, and RAG asset allowlists, with Docker-copy and live-serving
  regression tests. A live model-deletion inspection proved the exact
  resource-and-host phrase, wrong-phrase rejection, disabled submit control,
  safe cancellation, and focus restoration to the originating menu trigger;
  no destructive request was sent.
- The rebuilt Models menu now gives each action trigger and menu a model-specific
  accessible name, exposes expanded state, and publishes menu/menuitem roles in
  the live browser accessibility tree.
- Benchmark no longer invokes the full-profile host-claim recovery API during
  demo startup. The profile capability is unit-tested and the fresh demo log
  records an intentional skip instead of a misleading disabled-route warning.

## Still required before the next release

- Choose a new version after v0.1.1, update Core, Benchmark, and RAG package and
  lockfile versions together, and create the matching tag-specific release
  note. Do not reuse the v0.1.1 tag or notes.

