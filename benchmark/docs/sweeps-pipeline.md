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
| `POST /plan` | Probes one configured inference host and reads stored profile evidence; starts no work. |
| `POST /run` without `execute: true` | Returns a dry-run plan; starts no work. |
| `POST /run` with `execute: true` | May start an exact-artifact profile queue and a benchmark batch, consuming inference resources and writing their normal evidence. |
| `POST /recommend` | Pure scoring over caller-supplied measured metrics; returns a recommendation and ledger draft. |
| `GET /staleness` | Reads stored profile evidence and returns advisory re-profile payloads. |

Even in execute mode, the pipeline never pulls models, edits routing, applies a
recommendation, or deletes evidence. The executor rejects an active benchmark
batch or an active profile queue for the target host, rechecks the batch lock
before launch, and runs preflight before starting a batch.

Treat `execute: true` as an explicit operational action. Inspect the dry-run
response first and confirm that the target host, exact model tags, levels,
context, judge, and expected workload are correct.

## Discover candidates

`GET /intake` searches model metadata and returns a prioritized intake queue.
The optional Markdown form is convenient for review:

```bash
curl -fsS "$BENCHMARK_BASE_URL/api/benchmark/sweeps/intake?families=qwen,gemma&limit=10&markdown=1"
```

The fit estimate is an analytical pre-filter. Installed inventory and measured,
exact-artifact profile evidence remain authoritative.

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
Benchmark host-profile registry. Useful optional fields include `prompt_ids`,
`judge_config`, `execution_config`, `vramLimitMiB`, `maxVramFraction`,
`description`, and `tags`.

The response classifies each candidate as ready, needing a profile, absent from
the host, identity-unqualified, or outside the measured VRAM limit. It also
returns ready-to-use `payloads.profileQueue` and `payloads.benchmark` values.
Analytical fit notes never override measured evidence.

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

Only add `"execute": true` after reviewing that response. The `phase` field is
the stable discriminator:

- `dry_run`: no work was started.
- `needs_profile`: profiling is required but was not started by the driver.
- `profiling`: a profile queue is still running; retry after it completes.
- `profile_failed`: profiling ended unsuccessfully.
- `preflight_failed`: the candidate did not clear benchmark admission.
- `benchmarking`: a batch was started; use the returned batch ID for status.
- `noop`: no benchmark-ready candidate remained after planning.

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
Applying it remains a separate deployment-owned decision with its own backup,
validation, health, smoke, and rollback evidence.

## Check stale evidence

`GET /staleness` reports stale or invalid exact-artifact evidence. Restrict it to
one configured host when needed:

```bash
curl -fsS "$BENCHMARK_BASE_URL/api/benchmark/sweeps/staleness?hostId=example-host"
```

The response may include suggested profile payloads. Suggestions are advisory;
the route does not launch them.

## Maintainer map

| Concern | Product source |
|---|---|
| HTTP contract | [`../routes/benchmark/sweeps.js`](../routes/benchmark/sweeps.js) |
| Candidate classification and plan payloads | [`../src/services/benchmark/sweepCoordinator.js`](../src/services/benchmark/sweepCoordinator.js) |
| Guarded execution | [`../src/services/benchmark/sweepRunner.js`](../src/services/benchmark/sweepRunner.js) |
| Lane weights and recommendation guards | [`../src/services/benchmark/recommendationEngine.js`](../src/services/benchmark/recommendationEngine.js) |
| Staleness analysis | [`../src/services/benchmark/stalenessCrawler.js`](../src/services/benchmark/stalenessCrawler.js) |
| Candidate intake | [`../src/services/benchmark/intakeScanner.js`](../src/services/benchmark/intakeScanner.js) |
