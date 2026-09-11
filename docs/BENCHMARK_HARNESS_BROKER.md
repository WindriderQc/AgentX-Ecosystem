# Benchmark harness broker

Status: supported optional Benchmark contract, disabled by default.

## Ownership and topology

Agent X supplies the benchmark target, envelope, receipt, scoring, cohort and
UI contracts. AIOps governs their operation. OpenClaw and Hermès execute.

Product contains no provider endpoint, provider key, private model list,
harness profile or executable path. An AIOps-owned broker exposes a
secret-free catalog over the trusted internal network. Benchmark receives
only that origin:

```text
BENCHMARK_HARNESS_ENABLED=false
AGENTX_BENCHMARK_HARNESS_URL=
```

With the flag absent or false, catalog discovery returns disabled with no
targets, Product health remains independent of the broker, and the established
Ollama path is unchanged.

## Versioned API

The broker exposes these routes on the internal network:

- `GET /health`
- `GET /v1/benchmark/targets`
- `POST /v1/benchmark/spend-grants`
- `POST /v1/benchmark/execute`

Catalog rows are normalized `BenchmarkTarget v1` objects. Their stable
identity includes tier, exact provider/model version, harness and adapter pins,
profile fingerprint, API version, context, capabilities, price snapshot and
catalog fingerprint. The Product accepts legacy `host + models` and
`judge_host + judge_model` fields by normalizing them as local Ollama targets.

Each execution carries `WorkerEnvelope v1`. A successful response carries the
bounded output plus a `WorkerReceipt v1` whose request, prompt, output,
selection, profile, policy and runtime fingerprints are verified. Missing
receipts, fallback, actual-model drift, profile drift, stale catalog identity,
budget overruns and output mismatches fail closed.

## Execution modes

`isolated_model` is one turn with no tools, memory, delivery, fan-out,
filesystem access or session reuse. It may be a candidate or judge and is
eligible for a model quality cohort only when `fallbackUsed:false` and its
receipt validates.

Harness targets belong in the existing Benchmark test selection and execution
flow. The target catalog, per-test broker calls, response scoring, usage, cost
and receipt metadata remain available for `isolated_model` targets, using a
local or cloud provider.

`native_agent` uses the same target picker, questions, batch execution, judge
and `BenchmarkResult` storage. Select a harness such as OpenClaw in Benchmark
and run the existing prompt set. Results and comparison cards label agents
with tools and display aggregate input/output tokens, model turns and tool
calls from the execution receipt. Native targets cannot be judges, and their
results are excluded from model-only rankings. Campaign kind is derived from
the selected targets, including mixed model/agent batches.

Local harnesses execute serially after direct-model and cloud targets. Judging
starts after that local phase, so a native runtime that routes to the same
host cannot overlap a direct model or the judge. The broker receives only the
host claims and workload admission identities already owned by this batch;
cloud targets receive none. A trusted runtime adapter can carry these identities
to Core, which matches the actual routed host and revalidates the existing claim
and workload before dispatch. Expired or unrelated claims remain invalid.

Reference scoring uses the question's existing `judge_criteria`, falling back
to deduplicated reference sentences when no criteria are supplied. Each
criterion is assessed independently. Criteria, similarity and contradiction
checks request a short evidence statement before their final verdict. Statements
and verdicts are stored and shown under **Reference checks** in the result
inspector. Confidence compares similarity and coverage on the same scale;
counts and percentages are not independent 0–10 dimensions. Substantial
disagreement still requires review. Scorer `2.11.0` versions this change;
historical results retain their original scorer and verdicts. Passing a specific
reference check does not qualify a judge against an independent calibration set.

The standalone Harnesses page and campaign APIs remain removed, including
`/harnesses`. Existing campaign data is untouched. Local catalog freshness is
renewed when the broker reobserves runtime/profile pins; cloud price snapshots
retain their expiry. Missing usage is not evidence of zero consumption.
Runtime availability and successful scoring do not establish judge calibration.

## Spend and ranking

A paid target requires a signed `SpendGrant` bound to one batch id and its
frozen batch-contract fingerprint, the exact target fingerprints, an expiry,
maximum calls, maximum tokens, maximum manual
estimated cost and a fingerprint of that frozen plan. Benchmark asks for
explicit approval before asking the AIOps broker to issue the grant; the
signing key never enters Product. A resume requires a new approval and grant
before the batch returns to running. Broker reservations are
serialized and durable so concurrent cells cannot overspend one grant.

Manual prices are integer nanodollars per call or per million input/output
tokens, with source and effective date. They are displayed as estimates, never
as provider billing. A paid target without a declared price is invalid.

The main leaderboard defaults to including cloud targets. When cloud is
visible, a rank exists only inside one exact `qualityCohortFingerprint` covering
prompt contents, scoring version, judge identity, generation settings and
profile contract. Other and historical rows remain visible as non-comparable.
Disabling **Cloud models** sends `includeCloud=false` to server-side ranks,
statistics, charts and exports and restores the local-only latency composite.

## Activation and rollback

Activation is an AIOps operation, not a Product default:

1. keep the Product flag false and verify Product health;
2. validate the owner-only broker catalog, absolute executable paths, runtime
   pins, isolation attestations, manual prices and service authentication;
3. render Compose and scan endpoints, mounts and injected variables;
4. run the broker contract tests and the full Product Benchmark tests;
5. smoke one free OpenRouter target through OpenClaw;
6. approve one minimal paid call;
7. use Hermès as an isolated strict-JSON judge;
8. run a mixed Ollama/cloud cohort and prove `includeCloud=false` exclusion.

Rollback sets `BENCHMARK_HARNESS_ENABLED=false`, stops the AIOps broker and
restores the prior harness/runtime pins. The additive target, receipt, cost and
cohort fields remain readable and ignorable.
