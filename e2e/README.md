# Agent X release evidence gates

This package validates the critical surfaces for one supported profile declared
in `config/product-surfaces.json` with Chromium at 1440 px and 375 px. It checks:

- successful rendering without unresolved server-template markers;
- an exact canonical URL, surface marker, profile marker, main landmark, and
  navigation identity;
- no uncaught page errors, failed document/script/style/font/image requests, or
  runtime requests outside the three configured product origins;
- the named critical-surface budget from `config/product-surfaces.json`, using
  unique successful first-party document/script/style/font/image responses,
  decoded response-body bytes, decoded JavaScript bytes, request count, and DOM
  node count after the page readiness marker;
- no document-level horizontal overflow;
- no serious or critical WCAG 2.0/2.1/2.2 A/AA Axe violations; and
- the Playground disclosure/dialog and Courthouse tab-list keyboard journeys.

Every registered page for the selected profile also has a desktop compositor
gate. The gate waits for the canonical readiness marker and local fonts, then
requires a non-empty full-page screenshot to complete within five seconds.
This deliberately includes non-critical pages: shared navigation, backgrounds,
long tables, and extension-neutral layout changes can otherwise escape the
critical-surface journeys while still making browser capture or printing hang.

Release runs use no retries, so a flaky first attempt remains a failing gate.
The checks do not require Ollama or seeded product data. Start the normal demo
services first, then run:

```bash
cd e2e
npm ci
npx playwright install --with-deps chromium
npm test
```

Action-level evidence is a separate fail-closed gate. It drives real rendered
pages and client code at both supported widths through four bounded journeys:

- Benchmark stop failure, retry, acknowledged stop, and recovery to idle;
- Prompts validation, a recoverable version-allocation conflict, save, reload,
  and exact server-assigned revision identity;
- Playground duplicate-text history, exact older-turn provenance for Ask again,
  a stable failed response, and Retry of the same visible user identity without
  appending a duplicate bubble;
- RAG relational upload validation, failed ingestion and retry, exact source
  inspection, keyboard chunk disclosure, and failed deletion plus retry.

```bash
npm run test:actions
```

These journeys use deterministic API contracts and write the Benchmark receipt
to `test-results/agentx-browser-actions-<profile>.json` plus Prompts,
Playground, and RAG receipts with `prompts-`, `playground-`, and `rag-` before
the profile. Receipts deliberately
contain route templates and invariant results, never service origins, raw
responses, fixture identifiers, or secrets. They prove browser/API behavior;
by design, those four browser receipts do not claim to exercise live
inference, embedding, vector-store, or worker-cancellation latency. Additional
action journeys remain explicitly tracked in `docs/PRODUCT_EVOLUTION_PLAN.md`.

## Live cancellation evidence

Worker cancellation has a separate full-profile gate because a mocked route or
browser acknowledgement cannot prove that an in-flight upstream socket was
actually closed. `docker-compose.live-cancellation.yml` creates a fresh,
test-only topology containing only MongoDB, the deterministic Ollama socket
fixture, real Core, and real Benchmark. The four containers share one internal
network. The topology publishes no ports, uses no persistent volume or bind
mount, and has no host-gateway path. It is independent of the normal
`agentx-ecosystem` Compose project and never represents an external adapter or
deployment runtime.

Only this test topology sets Core's watchdog interval to one hour. Because the
CI job itself is capped at 35 minutes, no scheduled watchdog probe can enter
the fixture generation lane before or during the causal observation. This does
not disable the watchdog or change the normal demo/full Compose runtime.

The driver starts a two-prompt Benchmark batch, observes the first `/api/chat`
request after headers while its socket is still open, and then stops the batch.
Its receipt fails closed unless these seven ordered assertions all pass:

1. `socket-open-before-stop`;
2. `socket-closed-within-budget` (at most 1,000 ms);
3. `no-next-prompt` (one first-prompt start, zero second-prompt starts, and no
   generation start after cancellation during at least 2,500 ms of quiescence);
4. `batch-stopped` (idle current test, cleared active slot, and zero result,
   checkpoint, completion, or failure count for this scenario);
5. `claim-released` within the bounded settle window;
6. `service-identities-stable` for exact full-profile Core and Benchmark
   version/revision identities before and after the stop; and
7. `isolated-topology`, bound to the rendered Compose SHA-256.

The schema-v1 receipt has evidence mode `live-isolated-socket`. It retains the
exact 40-character build revision, bounded hashes and measurements, assertion
outcomes, and closed failure codes. Validation rejects service addresses, IP
addresses, raw prompts or responses, fixture sentinels, MongoDB identifiers,
batch identifiers, and secret material. Product CI runs this topology under a
unique Compose project, validates the receipt before upload, tears down that
exact project, and verifies that none of its containers, volumes, or networks
remain. Before the scenario, it verifies both the rendered configuration and
the four healthy running containers for the exact service set, internal network,
zero persistent/bind mounts, zero published ports, and absence of
host/privileged escape paths.
The `live-cancellation` job in `.github/workflows/ci.yml` is the
canonical invocation. It retains the commit-bound JSON for 30 days as
`agentx-live-cancellation-evidence-<commit>-<run-attempt>`; release promotion
requires that exact artifact from the selected successful Product CI run. The
receipt is not part of either product image.

## Immutable upgrade and rollback evidence

The separate digest-only lifecycle rehearsal starts an exact previous image
set, seeds bounded MongoDB and Qdrant product state, replaces only the three
product services with an exact candidate set, and restores the previous set.
Every phase rechecks service identity and bounded Core, Benchmark, RAG, and
vector-state reads. It publishes no ports and removes its unique project,
network, containers, and data volumes before its privacy-safe receipt can pass.
Its schema-v2 receipt uses strict in-band health identity by default. The sole
`legacy-oci-bound` exception requires the exact one-entry v0.1.1 policy,
historical manifest bytes, and closed previous-release wrapper; candidate
identity remains strictly in-band. The reusable policy/wrapper validators are
exported by `upgrade-rollback-baseline.js` for lifecycle jobs.
See [the upgrade/rollback rehearsal contract](../docs/UPGRADE_ROLLBACK_REHEARSAL.md)
for inputs, assertions, and evidence limits.

The performance limits are deliberately runner-speed independent: this gate
does not use transfer encoding, cache state, LCP, INP, or wall-clock timing as
a blocking signal. Every critical surface must reference a manually reviewed,
positive-integer budget in the registry. Do not regenerate limits from the
latest observation; raise one only when the added product value and payload
tradeoff have been reviewed.

Each browser run writes an address-free machine-readable receipt to
`test-results/agentx-browser-performance-<profile>.json`. It contains only
surface/service identity, profile, Playwright project and viewport, the named
limits, aggregate observations, and any limit violations. It never records
configured service origins or resource URLs. Run its focused deterministic
unit tests with:

```bash
npm run test:unit
```

The default URLs are Core `http://127.0.0.1:3180`, Benchmark
`http://127.0.0.1:3181`, and RAG `http://127.0.0.1:3182`. Override them with
`AGENTX_E2E_CORE_URL`, `AGENTX_E2E_BENCHMARK_URL`, and
`AGENTX_E2E_RAG_URL` when the same product profile is exposed elsewhere.
The profile defaults to `demo`; set `AGENTX_E2E_PROFILE=full` when the running
services use the full product profile.
