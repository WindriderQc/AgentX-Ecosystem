# Benchmark sweeps pipeline

The sweeps API turns installed-model and exact-artifact profile evidence into a
guarded, per-host benchmark plan. It can discover candidates, plan or execute a
sweep, rank measured candidates for a lane, and report stale evidence. It never
changes routing configuration.

Set the service URL explicitly when it differs from the portable Compose
default:

```bash
BENCHMARK_BASE_URL="${BENCHMARK_BASE_URL:-http://127.0.0.1:3181}"
```

All routes below are under `$BENCHMARK_BASE_URL/api/benchmark/sweeps`. Host IDs,
model tags, and judge settings are examples only; use values from the deployment
you are operating.

## Safety boundary

The routes have different side effects:

| Route | Effect |
|---|---|
| `GET /intake` | Reads public Hugging Face metadata; does not pull or run a model. |
| `POST /plan` | Reads the live inference host, artifact digest/Core registry identity, and stored profile evidence; starts no work. |
| `POST /run` without `execute: true` | Returns a dry-run plan; starts no work. |
| `POST /run` with `execute: true` | May start an exact-artifact profile queue and a benchmark batch, consuming inference resources and writing their normal evidence. Profiling can unload/load models temporarily. |
| `POST /recommend` | Pure scoring over caller-supplied measured metrics; returns a recommendation and ledger draft. |
| `GET /staleness` | Reads stored profile evidence and returns advisory re-profile payloads. |

Even in execute mode, the pipeline never pulls models, edits routing, applies a
recommendation, or deletes evidence. The executor rejects an active benchmark
batch or an active profile queue for the target host, rechecks the batch lock
before launch, and runs preflight before starting a batch. During profiling,
the profiler attempts to claim the host around its unload/load sequence. A
rejected claim aborts; if the Core claim call itself fails, standalone profiling
may proceed without that claim. A successful claim is released, and pinned host
dedication is restored on a best-effort basis, on both success and failure.

Treat `execute: true` as an explicit operational action. Inspect the dry-run
response first and confirm that the target host, exact model tags, levels,
context, judge, and expected workload are correct.

## Discover candidates

`GET /intake` searches model metadata and returns a prioritized intake queue.
The HTTP route parses parameter counts and MoE hints and ranks popularity from
Hugging Face downloads/likes. It does not supply host VRAM, context, or lane
inputs to the intake library, so current route records have an empty
`vramFitByHost`, a null `suggestedHost`, and a null `expectedLane`. Fit belongs
to the host-specific `/plan` step. The optional Markdown form is convenient for
review:

```bash
curl -fsS "$BENCHMARK_BASE_URL/api/benchmark/sweeps/intake?families=qwen,gemma&limit=10&markdown=1"
```

## Plan one host

`POST /plan` accepts one configured host and at least one exact model tag:

```bash
curl -fsS -X POST "$BENCHMARK_BASE_URL/api/benchmark/sweeps/plan" \
  -H 'Content-Type: application/json' \
  -d '{
    "hostId": "example-host",
    "candidates": ["namespace/example-model:q4_K_M"],
    "levels": [1, 2],
    "profileDepth": "standard",
    "execution_config": {"force_num_ctx": 8192},
    "run_name": "example exact-artifact sweep",
    "tags": ["operator-reviewed-sweep"]
  }'
```

`host` may replace `hostId` with the URL of a host already known to the
Benchmark host-profile registry. Accepted controls are `hostId`/`host`,
`candidates`, `levels`, `prompt_ids`, `profileDepth`, `judge_config`,
`execution_config`, `run_name`, `tags`, `description`, `vramLimitMiB`, and
`maxVramFraction`. `lane` is echoed for caller correlation but does not change
the plan. Omitting `profileDepth` uses `standard`.

Sweep inputs intentionally are not direct `/batch` parity. The coordinator
always creates a latency-mode batch; caller-supplied `execution_mode` and
`depth_config` are not sweep controls and are not forwarded. Use `levels` or
`prompt_ids` to select sweep coverage.

Each candidate has exactly one readiness value: `ready`, `needs_profile`,
`stale_profile`, `not_on_host`, `identity_unqualified`, or `filtered_vram`.
The response also returns ready-to-use `payloads.profileQueue` and
`payloads.benchmark` values. Its `estimate` is one analytical target-host
planning hint, never a prefilter or admission gate; live inventory, registry-
qualified exact-artifact identity, and measured profile VRAM remain
authoritative.

## Run the guarded plan

The same payload sent to `POST /run` is dry-run by default:

```bash
curl -fsS -X POST "$BENCHMARK_BASE_URL/api/benchmark/sweeps/run" \
  -H 'Content-Type: application/json' \
  -d '{
    "hostId": "example-host",
    "candidates": ["namespace/example-model:q4_K_M"],
    "levels": [1, 2],
    "profileDepth": "standard"
  }'
```

Only add the JSON boolean `"execute": true` after reviewing that response;
other truthy values stay dry-run. Execute mode also accepts `pollIntervalMs`
and `maxWaitMs` for the in-request profiling wait. The HTTP route always wires
the profile starter, so its `phase` field has these values:

- `dry_run`: no work was started.
- `profiling`: a profile queue is still running; retry after it completes.
- `profile_failed`: profiling ended unsuccessfully.
- `preflight_failed`: the candidate did not clear benchmark admission.
- `benchmarking`: a batch was started; use the returned batch ID for status.
- `noop`: no benchmark-ready candidate remained after planning.

The underlying `runSweep` library can also return `needs_profile` when embedded
without a profile-start dependency, but that phase is unreachable through this
HTTP adapter.

Conflict responses use HTTP 409 when another batch or target-host profile queue
holds the execution boundary.

## Build a lane recommendation

`POST /recommend` ranks caller-supplied measurements with lane-specific weights
and guards. It does not query or mutate routing:

```bash
curl -fsS -X POST "$BENCHMARK_BASE_URL/api/benchmark/sweeps/recommend" \
  -H 'Content-Type: application/json' \
  -d '{
    "lane": "daily",
    "host": "example-host",
    "incumbent": "namespace/model-a:q4_K_M",
    "candidates": [
      {"model":"namespace/model-a:q4_K_M","composite":78.2,"quality":7.7,"tokensPerSec":48.1,"latencyMs":2040,"failures":0},
      {"model":"namespace/model-b:q4_K_M","composite":82.5,"quality":8.0,"tokensPerSec":52.4,"latencyMs":2670,"failures":0}
    ],
    "ledger": {"target":"deployment-owned routing setting","evidenceRefs":["benchmark batch id"]}
  }'
```

Built-in lanes are `daily`, `lightweight`, `utility`, `generalist`, `deep`,
`master_brain`, and `deep_reflection`. The result is `promote`, `keep`, or
`inconclusive`, with the ranked candidates, guard evidence, and a ledger draft.
Every candidate requires a nonempty `model`. A `promote` result additionally
requires an explicit incumbent present in the candidate set and complete,
numeric `composite`, `latencyMs`, and `failures` evidence for both the winner
and incumbent. A missing incumbent or missing head-to-head evidence is
`inconclusive`, never a promotion. Applying a recommendation remains a separate
deployment-owned decision with its own backup, validation, health, smoke, and
rollback evidence.

Candidate identities must be unique after case and implicit `:latest`
normalization. Supplied metrics must be JSON numbers in their contract domains:
`quality` 0–10, `composite` 0–100, positive `latencyMs`, non-negative
`tokensPerSec`/`vramMiB`, and integer non-negative `failures`. Each weighted
dimension uses one metric basis across the whole cohort (`quality` otherwise
`composite`; `tokensPerSec` otherwise inverse `latencyMs`), never mixed units
row by row. Missing evidence for a positive-weight dimension or an exact
top-score tie cannot promote.

Custom `weights` may use only `quality`, `speed`, `reliability`, and `fit`; each
value is a JSON number from 0 through 1 and the vector must sum to 1. Custom
`guards` may use only `minCompositeMargin` (0–100), `maxLatencyRatio` (>0 and
finite), and boolean `requireZeroFailures`. The optional `ledger` must be an
object; `evidenceRefs` and `extraChanges` are arrays of strings. Weight, guard,
and ledger option objects reject unknown keys. Invalid documented shapes,
types, ranges, or duplicate identities return HTTP 400; additional candidate
metadata is preserved.

## Check stale evidence

`GET /staleness` reports stored stale flags and structurally invalid throughput
(negative or non-finite values). It does not impose a guessed physical
throughput ceiling. Restrict it to one configured host when needed:

```bash
curl -fsS "$BENCHMARK_BASE_URL/api/benchmark/sweeps/staleness?hostId=example-host"
```

Missing routed-model evidence is checked only when the caller supplies current
routing as URL-encoded `routedModelsByHost` JSON:

```bash
curl -fsS --get "$BENCHMARK_BASE_URL/api/benchmark/sweeps/staleness" \
  --data-urlencode 'routedModelsByHost={"example-host":["namespace/example-model:q4_K_M"]}'
```

The response includes a Maintenance-class `ledgerDraft` and may include
suggested profile payloads. Both are advisory; the route does not apply the
ledger draft or launch the suggestions.

## Maintainer map

| Concern | Product source |
|---|---|
| HTTP contract | [`../routes/benchmark/sweeps.js`](../routes/benchmark/sweeps.js) |
| Candidate classification and plan payloads | [`../src/services/benchmark/sweepCoordinator.js`](../src/services/benchmark/sweepCoordinator.js) |
| Guarded execution | [`../src/services/benchmark/sweepRunner.js`](../src/services/benchmark/sweepRunner.js) |
| Lane weights and recommendation guards | [`../src/services/benchmark/recommendationEngine.js`](../src/services/benchmark/recommendationEngine.js) |
| Staleness analysis | [`../src/services/benchmark/stalenessCrawler.js`](../src/services/benchmark/stalenessCrawler.js) |
| Candidate intake | [`../src/services/benchmark/intakeScanner.js`](../src/services/benchmark/intakeScanner.js) |
