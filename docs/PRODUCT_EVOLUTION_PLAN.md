# Agent X product evolution plan

This is the living product plan for turning Agent X into a dependable,
pleasant, evidence-backed local AI workspace. It applies only to the supported
product in this repository. Household automation, private operations, secrets,
and separately deployed assistants remain external consumers governed by
bounded contracts.

## North star

An operator should be able to answer three questions from any Agent X page
without cross-checking another dashboard:

1. **What can I do here?** The primary action is obvious and works with the
   current profile and installed capabilities.
2. **What is true right now?** Status, counts, timestamps, scope, provenance,
   and unavailable evidence are explicit and consistent.
3. **What happens next?** Success, degraded behavior, retry, rollback, and safe
   recovery are understandable before a consequential action is taken.

The product is ready only when these answers survive a clean installation,
optional Ollama absence, partial dependency failure, mobile layout, keyboard
navigation, upgrade, and restore rehearsal.

## Non-negotiable quality bars

| Dimension | Release bar |
| --- | --- |
| Truth | Zero contradictory claims inside one ecosystem snapshot or across canonical surfaces sampled from it. |
| Freshness | Health and release evidence are timestamped; the release gate rejects evidence older than its declared budget. |
| Identity | Core, Benchmark, and RAG report one version, profile, and build revision. |
| Working journeys | Every critical journey completes, fails safely, or presents a specific recovery path—never a decorative dead end. |
| Accessibility | No serious or critical Axe finding on critical pages; all primary flows work by keyboard with visible focus and semantic landmarks. |
| Responsive design | No document-level horizontal overflow at 375 px or 1440 px; information hierarchy survives both widths. |
| Security | Mutations require operator authority; destructive actions require exact typed confirmation; public projections use explicit allowlists. |
| Privacy and boundaries | No private address, secret, personal mount, adapter implementation, or raw external transcript ships in the default product. |
| Reproducibility | Release claims have a machine-readable receipt and deterministic contract/browser tests. |
| Optional inference | Ollama absence is honest and recoverable, not a release failure and never an implicit model download. |

## Workstreams

### 1. One product truth

Status: implementation and automated release verification complete; exact
container rehearsal remains in the release-engineering workstream.

- Keep `config/product-surfaces.json` as the canonical page inventory.
- Keep the ecosystem snapshot as the single cross-surface authority for
  service identity, availability, model counts, task counts, and evidence
  freshness.
- Preserve separate fields for operational state and evidence trust. A service
  may be degraded while its evidence remains current and trustworthy.
- Enforce the zero-contradiction budget in the full-profile release gate.
- Treat unknown, partial, stale, unavailable, and measured zero as different
  states throughout the UI and APIs.

### 2. Complete feature loops

Status: UI and service-contract foundations are implemented. Four
desktop/mobile action receipts now prove bounded Benchmark, Playground,
Prompts, and RAG failure/recovery loops. A separate isolated full-profile
socket receipt now proves Benchmark worker cancellation; the remaining action
matrix and live-dependency canaries are incomplete.
Destructive recovery remains disabled until a controlled offline rehearsal
proves it.

Each product capability owns an observable loop:

| Capability | Target loop | Proof still required |
| --- | --- | --- |
| Playground | Discover a usable model → send → stream/cancel → inspect route and evidence → recover from missing Ollama. | A deterministic desktop/mobile receipt proves duplicate-text exact-turn identity, honest Ask again, stable failure, and no-duplicate Retry. Explicit missing-model recovery is implemented and keyboard/browser-checked against the real failure shape without changing Standard routing. Live inference and cancellation latency remain. |
| Prompts | Browse local prompt inventory → edit with validation → save → verify the active revision; no CDN dependency. | A deterministic desktop/mobile receipt covers validation, a recoverable allocation conflict, save acknowledgement, reload, and exact server-assigned revision. A browser-to-live-Mongo canary remains. |
| Benchmark | Select exact artifacts → run → judge when ready → distinguish missing evidence → compare reproducible results. | Failed stop → retry → acknowledged stop is covered by an address-free desktop/mobile browser receipt. A separate live service/worker gate proves that a durably committed stop closes the controlled in-flight fixture socket within 1,000 ms, starts no second prompt, reaches a clean stopped projection, and releases its claim. A bounded real-model result, judge-unavailable state, and reproducible result comparison still require proof. |
| RAG | Ingest idempotently → see indexed source → retrieve with provenance → inspect context → delete with exact confirmation. | A deterministic desktop/mobile receipt covers relational upload validation, unavailable-embedding recovery, exact source/chunk inspection, and failed-delete retry. Duplicate ingest and grounded retrieval against a live vector store remain. |
| Pipeline | Create/observe work → show exact status and lane → expose heartbeat evidence → cancel safely → retain audit history. | Prove create-to-terminal and create-to-cancel transitions with retained receipts. |
| Cluster Schedule | Show one honest upcoming job projection → distinguish assignment metadata from observed hosts → expose empty evidence. | Canonical headline drift is covered; add an action journey when schedule mutation becomes product-owned. |
| Backup | Show effective cadence/retention/growth risk → paginate inventory → create/delete with typed confirmation → export durable recovery inputs → enable restore only for a controlled offline rehearsal → verify recovery. | The strict portable-v1 manifest and offline verifier are implemented. Fresh quiesced capture, atomic export, isolated restore, and post-restore journey checks remain. |
| Dreaming Review | Collect bounded evidence → flag stale/missing collectors → propose → approve one item → apply through its owner → audit/rollback. | Prove one rejected proposal, one approved/apply path, and owner-backed rollback. |

No tile or button counts as a feature merely because it renders. A feature is
working only when its end state and failure state are both covered by tests.
Surface-route coverage is necessary but does not satisfy this bar by itself.

### 3. Simple-to-expert experience

Status: critical-page foundation implemented; continuous usability work.

- Give every page one primary task and one dominant information hierarchy.
- Put advanced routing, evidence, and tuning behind deliberate disclosure.
- Use shared terms for model, host, task, run, result, source, observation, and
  evidence window; label any intentionally different scope beside the value.
- Preserve exact identifiers in accessible titles/details while showing
  readable labels in the main flow.
- Replace generic confirmations and silent mutation with specific preview,
  typed confirmation where destructive, progress, receipt, and recovery.
- Keep empty states actionable but honest: configure, retry, or learn why the
  capability is outside the active profile.

### 4. Evidence-first operations

Status: trust scorecard, release receipt, degraded/recovery receipt, browser
performance receipt, four deterministic browser action receipts, and
privacy-safe support and live-cancellation receipts implemented; broader live
action coverage and SLO history are next.

- Expand the evidence-trust scorecard from a point-in-time gate into a bounded
  trend: coverage, freshness, contradictions, and collection failures.
- Establish service-level objectives for required dependencies and critical
  user journeys without treating optional Ollama as required infrastructure.
- Attach provenance and observation time to every operational claim.
- Deduplicate alert occurrences while preserving first seen, last seen, and
  occurrence count; alerts close only from observed recovery or operator action.
- Retain release and restore receipts long enough to compare an upgrade with
  its previous known-good state.

### 5. External interoperability without product leakage

Status: versioned conformance registry and verifier implemented.

- Keep generic consumers, Nestor-style consumers, trusted extensions, private
  Data APIs, and AIOps observers as distinct contracts and allowlists.
- Keep external harnesses outside AgentX's identity, conversation, memory, and
  execution-loop ownership. Exchange only versioned WorkerEnvelope/WorkerReceipt
  contracts and bounded public evidence projections.
- Pass service addresses and credentials only at runtime; never place them in
  the registry, UI projection, fixture, or default Compose file.
- Require identity, freshness, provenance, bounds, timeout/cancellation, and
  degraded-state behavior from every consumer contract.
- Add a new adapter only after its healthy and degraded fixtures pass the
  standalone conformance verifier.

### 6. Release engineering and recovery

Status: deterministic gates, direct live demo/full profile rehearsals,
performance budgets, immutable-first image promotion, and a fresh local Docker
build/canary of both supported profiles are complete. An isolated full-profile
worker-cancellation gate now binds its seven live socket/state assertions to
the exact build and topology in a privacy-safe retained receipt. The portable
recovery-bundle contract and offline verifier are also complete. The fresh
capture path, immutable-digest upgrade/rollback, and controlled offline restore
rehearsals remain pending.

The release ladder is deliberately cumulative:

1. static contracts, syntax, dependency audit, and boundary scans;
2. full Core, Benchmark, and RAG unit/integration suites;
3. default and optional-Ollama Compose render verification;
4. clean first run with required dependency health;
5. registered surface verifier;
6. machine-readable release-evidence receipt;
7. desktop/mobile browser, accessibility, overflow, keyboard, and bounded action journeys;
8. degraded-dependency scenarios with linked outage/recovery receipts, plus a live cancellation receipt;
9. upgrade from the previous stable release and rollback by immutable digest;
10. MongoDB/Qdrant backup and restore drill with post-restore journey checks.

Items 1–8, including the live degraded-dependency and isolated worker-
cancellation receipts, plus deterministic desktop/mobile Benchmark,
Playground, Prompts, and RAG action receipts block Product CI today. Items
9–10 remain controlled release rehearsals until their
isolated upgrade and offline-restore fixtures are safe and deterministic enough
to become canary gates.

### 7. Mutation authority and outbound safety

Status: global Host/CSRF boundaries, scoped machine credentials, local-only
standalone listeners, bounded product-network trust, critical safe-method
splits, and Ollama outbound admission are implemented. The machine-readable
policy now classifies all 236 non-safe Core, Benchmark, and RAG route
declarations and Product CI fails closed on missing, stale, dynamic, or chained
entries. The staged outbound registry v2 now records the 69 recognized
direct/static physical HTTP constructors in the long-running product service
processes (including `shared/`) and models the migrated path as 46 enforced
logical operations, eight acyclic delegates, and three approved peer-verifying
transports. The operations comprise eight Core calls, 20 Benchmark calls, and
18 RAG calls. The other 66 physical sinks are frozen as explicit
`legacy-direct` migration debt: verification permits no new legacy direct sink
or reuse of a legacy fingerprint and still requires every constructor found by
the bounded in-scope scanner to be registered. RAG now has zero legacy-direct
sinks; Core has 42 and Benchmark has 24. Product CLI and maintenance-script
egress is governed separately by an exact static inventory of 10 physical calls
across 29 non-test sources; all 10 have lifecycle deadlines and bounded
responses. The two launcher consumers share one loopback-only, redirect-free,
stream-bounded PowerShell transport. This static inventory is not executor
enforcement and is not included in the service-process totals. The
action-level matrix now resolves the global boundary and
route-local credential/confirmation state for all 236 declarations: 235 are
enforced, no scoped-machine authorization gaps remain, and one retired adapter route
is disabled. All 40 irreversible delete/bulk/restore actions now require exact,
resource- or action-bound phrases; 13 reversible runtime controls and one
ephemeral maintenance action intentionally do not. Core exposes one accessible
shared confirmation dialog, while Benchmark and RAG preserve their own bounded
surface contracts. A shared
executor contract now enforces closed operation policy, opaque single-use
target admission, manual redirects, one request/response lifecycle deadline,
request and response byte caps, bounded streaming, cancellation, sanitized
errors, and mandatory connect-time peer-verification attestation. Those 46
logical operations now use that contract, but uniform outbound runtime
enforcement remains incomplete while the 66 frozen legacy-direct sinks remain.
The first identity tranche revalidates the scoped Benchmark credential on its
five Core contract/host-control routes, attaches that credential to the
Benchmark snapshot caller, and makes remote MCP ingress fail closed while
preserving explicit trusted-local, same-origin UI, and operator authorities.
The second tranche gives Memory Review producers, schedule workers, pipeline
workers, and alert-delivery reporters mutually isolated route families with
timing-safe, fail-closed credentials. The pipeline worker can discover only
the next task and can never authorize `status=done`; Memory Review exposes only
the synthesis input needed between finalization and candidate submission.

- Preserve the registry v2 graph of stable literal logical operations ->
  acyclic delegates -> approved physical transports. Each migrated operation
  binds authority resolution, response mode, deadline, request cap, and response
  cap; verification must continue rejecting unregistered constructors and any
  new `legacy-direct` sink.
- Treat the approved transport implementations, reviewed `transportAdapter`
  bindings, and any sanctioned dependency-injection callers as part of the
  in-process trusted computing base. The current CI scanner proves exact
  locations and recognized direct/static aliases, not complete JavaScript
  dataflow; full AST analysis or a central-import restriction is the next
  verifier hardening step.
- Migrate the remaining buffered fan-outs next, then the stream-sensitive and
  recovery paths with explicit consumer cancellation and endpoint-sized limits.

- Classify every route as observation, user mutation, destructive mutation, or
  scoped machine call; fail CI when an unclassified mutation is introduced.
- Keep browser same-origin checks as CSRF protection, never as remote machine
  identity. Remote administrative mutations require an operator credential or
  an authenticated proxy/session boundary.
- Admit each machine credential only to its declared route family and keep the
  route-local validator authoritative.
- Resolve caller-selected Ollama targets through one outbound admission policy:
  strict origin syntax, allowed ports, metadata/link-local rejection, no
  redirects, bounded body/time, and no persistence before validation.
- Keep every direct product-owned HTTP constructor in
  `config/outbound-http-sinks.json`. The registry is a coverage and design
  contract; only a shared executor can turn its redirect, deadline, body, and
  authority expectations into uniform runtime enforcement.
- Keep GET/HEAD observational. Any refresh that probes or writes evidence uses
  a protected action verb and produces an observation timestamp.

### 8. Supply-chain and artifact durability

Status: application images are built once at an immutable Git SHA and promoted
by digest; dependency-image and recovery-export hardening remain.

- Pin MongoDB, Qdrant, Ollama, and build/runtime base images by reviewed digest,
  with an explicit update cadence and compatibility receipt.
- Generate SBOM, provenance, dependency-vulnerability, and license artifacts
  from the same exact-SHA build and retain them beside the image manifest.
- Never republish moving release channels from automation. A future convenience
  channel, if reintroduced, must be an explicit operator promotion with a
  recorded previous digest and rollback command.
- Export recovery inputs plus checksums and schema/version metadata to an
  operator-selected destination outside the runtime volume before a release is
  called recoverable.

## Next execution sequence

1. **Finish outbound enforcement:** preserve the zero-gap 236-route mutation
   and authorization baseline plus the outbound registry v2's current
   69-constructor static service-process inventory. Keep the 46 migrated logical
   operations behind their three approved peer-verifying transports, admit no
   new legacy-direct sink, shrink the 66-sink service debt, and preserve the
   zero-gap 10-call governed maintenance inventory while migrating
   stream-sensitive and recovery paths.
2. **Prove critical actions:** extend the deterministic Benchmark, Playground,
   Prompts, and RAG receipts with live-dependency journeys, then cover Pipeline,
   Backup, and Dreaming Review with one safe failure and one recovery path each.
3. **Make recovery portable:** implement a checksummed export bundle, restore it
   in an isolated offline fixture, and verify identity plus representative
   Playground/RAG/Benchmark journeys after restore.
4. **Prove lifecycle safety:** install the previous immutable release, upgrade
   to the candidate by digest, compare evidence, then roll back without data or
   schema loss.
5. **Raise the experience bar:** add real p75 response/streaming/interaction
   budgets, task-based usability observation, and a shared accessible component
   system without weakening truth or evidence semantics.
6. **Harden the supply chain:** pin dependency images and attach SBOM,
   provenance, vulnerability, and license receipts to the exact candidate.

## Delivery horizons

### Horizon A — Trustworthy baseline

- Eliminate current contradictions and placeholder residue.
- Finish the canonical snapshot, trust scorecard, adapter conformance, and
  release receipt.
- Cover all critical demo pages at desktop/mobile widths.
- Make missing models, judges, databases, and evidence explicit and recoverable.

Exit: all automated gates through step 7 pass from a clean clone.

### Horizon B — Operationally excellent

- Keep the automated RAG outage/recovery and inference cancellation contracts
  green; extend them to bounded timeout and retry journeys as new dependencies
  are added.
- Page payload, JavaScript, asset-count, and DOM budgets now block critical
  browser journeys and produce retained receipts. Add stable server-response,
  streaming-start, and long-task responsiveness budgets next.
- Automate upgrade/rollback and isolated restore drills.
- Add action-level browser receipts for every critical mutation, including
  wrong-origin/wrong-token rejection and user-visible recovery guidance.
- Export durable recovery inputs outside the runtime volume before enabling a
  release restore claim.
- Keep privacy-safe support receipts address-free and bounded; add opt-in log
  attachments only after an equally strict redaction contract exists.
- Measure feature-loop completion and recovery success locally, opt-in only.

Exit: a release can prove normal, degraded, upgrade, rollback, and restore
behavior without manual dashboard interpretation.

### Horizon C — Delight and extensibility

- Run task-based usability studies for novice and expert operators, then tune
  information architecture from observed completion problems.
- Consolidate visual tokens and reusable interaction primitives into a tested
  design system with contrast, focus, reduced-motion, and compact-density modes.
- Add localization only after every date, number, status, and unit has an
  explicit formatting contract; never mix locales inside one page.
- Provide exportable, privacy-preserving benchmark and RAG evidence bundles.
- Grow external integrations through versioned contracts and conformance kits,
  not product-specific private code.

Exit: new capabilities inherit trust, accessibility, recovery, and visual
quality by construction instead of recreating them page by page.

## Product scorecard

Track these per release and show `unknown` until measured:

- contradiction count and contradiction-budget outcome;
- evidence coverage, current/stale/unknown observations, and oldest required
  observation;
- critical surfaces and journeys passed by profile and viewport;
- serious/critical accessibility findings;
- required dependency health and degraded-path pass rate;
- p75 Largest Contentful Paint, Interaction to Next Paint, and Cumulative
  Layout Shift on critical pages;
- successful feature-loop completion, safe failure, and recovery rate;
- benchmark coverage separated from quality and judge readiness;
- RAG duplicate-prevention, provenance coverage, and deletion verification;
- backup inventory growth, bounded retention, last successful restore drill,
  and recovery-point/recovery-time observations;
- escaped private-address, credential, or unsupported-scope findings (target 0).

## Decision rules

- A green tile without current evidence is not green.
- Missing optional capability is a setup state; missing required dependency is
  degraded or failed.
- Unrun work does not score zero and cannot lower a quality average.
- A count without scope and observation time is not a release claim.
- A historical record stays useful when its era and age are explicit.
- An external system may consume a bounded product contract, but it never
  silently expands the product runtime or source boundary.
- If a release cannot produce its evidence receipt, it is not ready to ship.

## Current verification note

The repository now contains the contracts and gates for the trustworthy
baseline plus the first operational-excellence slice. Static contracts, the
full Core, Benchmark, and RAG service suites, rendered Compose profiles, direct
live demo/full surface and release receipts, desktop/mobile browser gates,
direct browser performance receipts, and deterministic Benchmark, Playground,
Prompts, and RAG failure/recovery action receipts have passed. Product CI owns
an exact Compose RAG outage/recovery rehearsal, an isolated full-profile live
worker-cancellation gate, scoped recovery credential/storage checks, and
retained support/performance/action/cancellation receipts. The cancellation
gate observes a real Benchmark worker and socket lifecycle against a controlled
Ollama-compatible fixture; it does not claim real-model quality. These gates
prove surface and selected action integrity, but do not yet prove broader live
inference/vector-store behavior or every action loop. The remaining release
validation items include the rest of the action-level mutation journeys, a
supported quiesced recovery capture/export,
immutable-digest upgrade/rollback, and a controlled offline MongoDB/Qdrant
restore drill. The Windows Benchmark harness now reuses one awaited IPv4
listener and keep-alive client per affected suite, eliminating transient
loopback churn without increasing timeouts. The local Docker canary rebuilt all
three images from the working tree, passed clean demo startup, all 19 demo and
26 full registered surfaces, both local release-evidence rehearsals, 32 demo and 34 full
desktop/mobile browser checks, and all four action journeys in both profiles. It
also caught and fixed npm-10 lockfile incompatibility plus the Docker Desktop
loopback-forwarding/native-Fetch boundary. The latest destructive-action canary
also caught two cross-service UI regressions before release: Benchmark and RAG
copied the shared typed-confirmation controller but did not expose it through
their closed asset allowlists, and cancelling a confirmation opened from a
menu returned focus to the page instead of the persistent menu trigger. Both
now have regression coverage and passed a live exact-phrase, wrong-phrase,
cancel, and focus-restoration inspection without executing the destructive
operation. Benchmark also skips full-only claim recovery in the demo profile,
so its startup evidence no longer contains a manufactured disabled-route
warning. The latest machine-identity canary reports 235 enforced routes, zero
authorization gaps, and one retired route across all 236 mutation declarations.
Its 16 focused Core suites passed 187/187 tests and its three focused Benchmark
suites passed 13/13. Rendered Compose and live container inspection carried all
six purpose-scoped credentials to their intended services; safe full-profile
probes reached each intended handler with the exact credential and returned
403 with the wrong credential across Benchmark-to-Core, MCP, Memory Review,
schedule, pipeline, and alert-delivery lanes. That full-profile run passed all
26 registered surfaces and all four release gates with zero warnings and one
profile-aware skip. The rebuilt Models menu also exposes model-specific trigger
and menu names, expanded state, and menu/menuitem roles in the live accessibility
tree. Both launchers now wait for the
three published health endpoints after container health so a just-returned
`up` command is ready for browser and release gates. If a future workstation Docker
engine is unavailable, report that environment blocker explicitly; do not
weaken the gates, change global Docker settings, or reinterpret static Compose
rendering as a successful live run.
