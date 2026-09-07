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
| Security | Destructive actions require exact typed confirmation; public projections use explicit allowlists. |
| Privacy and boundaries | No private address, secret, personal mount, adapter implementation, or raw external transcript ships in the default product. |
| Reproducibility | Release claims are backed by deterministic contract tests. |
| Optional inference | Ollama absence is honest and recoverable, not a release failure and never an implicit model download. |

## Workstreams

### 1. One product truth

Status: implemented.

- Keep `config/product-surfaces.json` as the canonical page inventory.
- Keep the ecosystem snapshot as the single cross-surface authority for
  service identity, availability, model counts, task counts, and evidence
  freshness.
- Preserve separate fields for operational state and evidence trust. A service
  may be degraded while its evidence remains current and trustworthy.
- Enforce the zero-contradiction budget in the ecosystem snapshot.
- Treat unknown, partial, stale, unavailable, and measured zero as different
  states throughout the UI and APIs.

### 2. Complete feature loops

Status: UI and service-contract foundations are implemented.
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

Status: trust scorecard implemented; broader live action coverage and SLO
history are next.

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

Status: versioned consumer contracts implemented.

- Keep generic consumers, Nestor-style consumers, trusted extensions, private
  Data APIs, and AIOps observers as distinct contracts and allowlists.
- Keep external harnesses outside AgentX's identity, conversation, memory, and
  execution-loop ownership. Exchange only versioned WorkerEnvelope/WorkerReceipt
  contracts and bounded public evidence projections.
- Pass service addresses and credentials only at runtime; never place them in
  the registry, UI projection, fixture, or default Compose file.
- Require identity, freshness, provenance, bounds, timeout/cancellation, and
  degraded-state behavior from every consumer contract.

### 6. Release engineering and recovery

Status: Product CI runs each service's unit/integration suite and renders the
default and optional-Ollama Compose files; a green `main` commit publishes
immutable `sha-<commit>` images. Upgrade/rollback and restore rehearsals are
manual operator work.

### 7. Outbound safety

- Resolve caller-selected Ollama targets through one outbound admission policy:
  strict origin syntax, allowed ports, metadata/link-local rejection, no
  redirects, bounded body/time, and no persistence before validation.
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

1. **Make recovery portable:** implement a checksummed export bundle, restore it
   in an isolated offline fixture, and verify identity plus representative
   Playground/RAG/Benchmark journeys after restore.
2. **Prove lifecycle safety:** install the previous immutable release, upgrade
   to the candidate by digest, compare evidence, then roll back without data or
   schema loss.
3. **Raise the experience bar:** add real p75 response/streaming/interaction
   budgets, task-based usability observation, and a shared accessible component
   system without weakening truth or evidence semantics.
4. **Harden the supply chain:** pin dependency images and attach SBOM,
   provenance, vulnerability, and license receipts to the exact candidate.

## Delivery horizons

### Horizon A — Trustworthy baseline

- Eliminate current contradictions and placeholder residue.
- Finish the canonical snapshot and trust scorecard.
- Cover all critical demo pages at desktop/mobile widths.
- Make missing models, judges, databases, and evidence explicit and recoverable.

Exit: Product CI passes from a clean clone.

### Horizon B — Operationally excellent

- Keep the automated RAG outage/recovery and inference cancellation contracts
  green; extend them to bounded timeout and retry journeys as new dependencies
  are added.
- Add server-response, streaming-start, and long-task responsiveness budgets.
- Automate upgrade/rollback and isolated restore drills.
- Export durable recovery inputs outside the runtime volume before enabling a
  release restore claim.
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

