# Agent X Ecosystem — Unreleased

Status: working-tree and `main` hardening after v0.1.1. These changes have no
new version, release tag, or published release manifest yet and are not part of
v0.1.1.

## Product trust and experience

- Product health now carries version, profile, revision, and observation time;
  the full-profile ecosystem snapshot reconciles readiness, freshness,
  identity consistency, source coverage, and a zero-contradiction budget.
- The checked-in surface registry defines supported demo/full pages and their
  performance budgets. Release checks cover registered pages, desktop/mobile
  browser journeys, keyboard interaction, accessibility, overflow, asset
  budgets, and dynamic page states.
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
- Separately operated consumers have bounded, versioned conformance contracts
  for identity, provenance, freshness, authentication, timeouts, cancellation,
  degraded behavior, and ownership.
- Default Compose now passes the deployment-owned external-consumer credential
  only to Core, and conformance probes authenticate both generic and Nestor
  contract families without sending that credential to unrelated reads.
- Provider-neutral WorkerEnvelope/WorkerReceipt v1 contracts now bind logical
  work, budgets, policies, exact harness/model/API/environment identity, and
  deterministic evidence fingerprints. Benchmark can compare imported
  portable or native-ceiling receipts without executing a harness, retaining a
  transcript, changing routes, or promoting a candidate.

## Evidence and recovery

- Release, browser-performance, browser-action, privacy-safe support,
  degraded-state, recovery, and live-cancellation receipts are deterministic
  and fail closed.
  Product CI retains the exact release and resilience receipt sets plus
  address-free Benchmark, Playground, Prompts, and RAG action receipts at desktop and
  mobile widths.
- A separate Product CI gate runs real full-profile Core and Benchmark with
  ephemeral MongoDB and a deterministic Ollama socket fixture on one internal
  network. It publishes no ports, uses no persistent volume, bind mount, or
  host gateway, and is independent of the supported deployment Compose project.
  Both rendered configuration and the exact four healthy runtime containers
  are checked for that boundary before the scenario runs.
  Its exact-build, rendered-topology-bound receipt requires seven ordered
  assertions: socket open before stop, socket close within 1,000 ms, no next
  prompt, stopped batch projection, released claim, stable service identities,
  and isolated topology. Validation excludes addresses, raw prompt/response
  data, fixture sentinels, database/batch identifiers, and secrets before the
  exact-commit/run-attempt JSON artifact is retained for 30 days and required
  by release promotion.
- Backups use a dedicated persistent recovery volume and an ephemeral
  Core-to-RAG credential. Configuration archives contain only an explicit
  secret-free product allowlist.
- MongoDB and Qdrant restore remain disabled by default with
  `OFFLINE_RESTORE_REQUIRED`. Existing archives are recovery inputs, not proof
  of a coherent or successfully restorable recovery set.
- A strict `agentx.recovery-bundle/v1` directory contract and network-free
  verifier now bind exact product/profile/revision, source image and dependency
  versions, quiesced writer state, fixed config sources, and streamed artifact
  hashes without claiming that capture or restore has succeeded.

## Release integrity

- Release promotion is bound to the exact checked-out commit, its successful
  Product CI run, and the still-available non-empty release/resilience
  artifacts for that run attempt.
- Immutable `sha-<full-commit>` images are serialized per service and commit,
  built only when absent, and verified against their registry digest. A release
  reuses those images rather than rebuilding them.
- Explicit release tags are digest-guarded and verified after creation. The
  workflow does not move `test` or `latest`; any pre-existing moving tag may be
  stale. The attached three-image digest manifest remains the deployment
  authority because registry promotion is not a cross-repository transaction.

## Authority and outbound safety

- Core, Benchmark, and RAG now enforce case-normalized Host boundaries,
  cross-site mutation rejection, local-only standalone listeners, and narrowly
  scoped machine credentials. Compose enables internal/proxy trust only inside
  its loopback-published product topology.
- Product regression evidence now covers the deployment-owned remote operator
  UI host through an exact HTTPS same-origin reverse-proxy request while proving
  that the identical allowlist never admits cross-site browser traffic.
- Reverse-proxied operator UI traffic can now bind to an exact configured socket
  peer, including IPv4-mapped Docker gateway addresses, without trusting
  forwarded client addresses, subnets, wildcards, or cross-site requests.
- Benchmark prompt synchronization, host/judge refresh, and batch repair are
  explicit protected actions. Their GET projections no longer seed, probe with
  inference, emit events, or persist reconciliation writes.
- Benchmark validates every selected Ollama origin before use or persistence,
  rejects metadata/link-local/unspecified/multicast targets and unsafe DNS
  answers, does not follow redirects, and bounds inventory bodies while the
  request timeout remains active.
- Judge validation now resolves the requested host/model through the configured
  ready-judge authority before any Ollama call. Credentials, paths, fragments,
  query strings, unconfigured hosts, and arbitrary ports fail before outbound
  I/O with stable malformed, unavailable-model, and unreachable responses.
- A checked-in mutation policy classifies all 236 non-safe Core, Benchmark, and
  RAG route declarations. Product CI rejects missing or stale classifications,
  dynamic mutation paths, and unsupported chained declarations.
- A separate action-authorization matrix audits the exact same 236 routes and
  distinguishes global same-origin/operator admission from scoped machine
  credentials, route-local validators, and exact typed confirmation. Its
  current receipt is 235 enforced, zero scoped-machine gaps, and one
  retired 410 route. Destructive actions are consequence-tiered: all 40
  irreversible delete/bulk/restore actions now require exact action- or
  resource-bound phrases, while 13 reversible controls and one ephemeral cache
  clear intentionally do not. Core's visible destructive actions use one shared
  accessible confirmation dialog; Benchmark and RAG preserve bounded local UI
  contracts and reject absent or inexact phrases before side effects.
- The first machine-identity tranche closes all five Benchmark-to-Core
  boundary-only gaps with route-local validation on contract resolution,
  claim, heartbeat, release, and reload, and adds the token to Benchmark's
  contract-snapshot caller. Remote MCP ingress now also fails closed when its
  scoped token is absent or wrong, uses timing-safe comparison, and retains
  separately proven local UI, loopback, and operator paths.
- The remaining machine lanes now use mutually isolated, timing-safe
  credentials for Memory Review production, cluster schedule sync/claims,
  pipeline worker lifecycle, the legacy task-creation alias, and alert-delivery
  receipts. Each token is admitted only to its route family and revalidated
  before side effects. The bounded worker reads needed for a complete flow are
  explicit: Memory Review synthesis input and Pipeline next-task discovery.
  Pipeline worker scope cannot confirm `status=done`, even when a loopback
  proxy carries the request; reviewer/operator authority remains separate.
- The Nestor v1 inference and memory-search mutations now reuse the documented
  external-consumer token at both Core's exact path admission boundary and the
  mounted router validator. Public-host wrong tokens fail before the contract;
  isolated local router tests retain their dependency-free contract shape.
- Docker Desktop's explicit loopback-published topology now admits headerless
  local tooling even though the container observes the VM gateway address.
  `Sec-Fetch-Mode` alone is not treated as browser identity because native
  Node/Undici fetch emits it; Origin, Referer, or Sec-Fetch-Site still trigger
  the same-origin boundary, and cross-site browser requests remain blocked.
- The checked-in outbound registry is now schema v2 and records the 69
  recognized direct/static physical HTTP constructors in the long-running
  Core, Benchmark, RAG, and shared service runtime. It enforces a three-layer
  graph of logical operations, acyclic delegates, and approved physical
  transports, rejects unregistered constructors and recognized direct/static
  aliases, and permits no new `legacy-direct` sink or reused legacy fingerprint.
  Exact delegate metadata also pins each executable `transportAdapter`
  expression. The 66 existing legacy-direct sinks are frozen migration debt:
  42 in Core, 24 in Benchmark, and zero in RAG.
  Approved transports, sanctioned injection callers, and complex flows beyond
  the bounded static scanner remain part of the in-process trusted computing
  base pending AST analysis or a central-import restriction. Supported
  CLI/script egress remains a separately governed review scope.
- The shared outbound executor now serves 46 enforced logical operations
  through eight delegates and three approved peer-verifying transports: eight
  Core, 20 Benchmark, and 18 RAG operations. It
  provides closed policies, opaque single-use admission receipts,
  exact method/path/search families, immutable request snapshots and response
  consumption state, authority/hop-by-hop header ownership, request/response
  caps, manual redirects, one full-lifecycle deadline, bounded Node/Web
  streaming, cancellation, redacted typed errors, and connect-time peer
  attestation. Migration is intentionally incomplete.
- A separate maintenance-egress registry now freezes 10 physical calls across
  29 non-test CLI, verification, and launcher sources. Every call has a full
  lifecycle deadline and bounded response; nine reject redirects and one
  follows them explicitly. CI fails on new, missing, stale, unsafe, or
  unclassifiable calls;
  the receipt intentionally claims static inventory rather than executor
  enforcement.

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
- Fresh local images passed clean demo startup, all 19 demo and 26 full
  registered surfaces, demo/full local release-evidence rehearsals, 32 demo and 34 full
  desktop/mobile browser checks, and all four action journeys in both profiles.
- The zero-gap machine-identity canary passed 187/187 focused Core tests and
  13/13 focused Benchmark tests. Rendered Compose and live container inspection
  carried all six purpose-scoped credentials; safe full-profile probes reached
  each intended handler with the exact token and rejected the wrong token with
  403 across Benchmark-to-Core, MCP, Memory Review, schedule, pipeline, and
  alert-delivery lanes. The same run passed 26/26 registered surfaces and all
  four release gates with zero warnings and one profile-aware skip.
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
- Run the release-evidence gate for demo and full profiles with
  `--expected-revision` set to the exact 40-character candidate commit, then
  retain the browser, performance, support, degraded, and recovery receipts.
- Complete immutable-digest upgrade and rollback rehearsal plus the controlled
  offline restore rehearsal before claiming those outcomes. Exact local
  container evidence remains required; static contracts alone are not a
  successful restore or deployment rehearsal.
- Extend the current action receipts across the remaining live Playground,
  Benchmark, Pipeline, Backup, and Dreaming Review flows, including live
  real-model inference/vector-store canaries and checksummed recovery inputs
  exported outside the runtime volume.
- Continue the outbound v2 migration with the remaining buffered fan-outs,
  then the stream-sensitive and recovery paths. Preserve the frozen
  legacy-direct baseline and the action matrix's zero-gap machine-identity
  gate, and add the remaining
  cross-site, wrong-token, wrong-host, redirect, oversized-body, and
  response-deadline regressions.
