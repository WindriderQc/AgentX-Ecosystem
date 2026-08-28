# Cloud and local lane accounting

Agent X compares local, free-cloud, and paid-cloud models without turning a
benchmark result into routing authority. The Benchmark service owns a
stateless `agentx.lane-comparison.v1` contract for planning comparisons,
normalizing evidence, and attributing the cost of already-observed provider
calls.

This is a portable product capability. It contains no provider credential,
private endpoint, household identity, or environment-specific model choice.
Benchmark also ships a separate operator CLI and injected-transport library
for measured campaigns. The HTTP accounting routes remain pure and cannot
invoke that runner.

## Policy boundary

- Local, free-cloud, and paid-cloud observations remain separate cohorts.
- `family` and `kid` lanes reject every non-local candidate.
- Paid cloud is an ultimate tier. A paid plan requires an exact, short-lived
  operator declaration binding the campaign, candidates, call count, and
  nanodollar ceiling.
- The stateless approval check validates declaration scope; it is not an
  authenticated execution token. The execution library authenticates the
  operator again through a host-injected callback before transport preflight.
- Comparison never emits a universal winner, changes routing, contacts a
  provider, persists a result, or authorizes network access.
- Synthetic fixtures prove contract behavior only. They are never model
  performance evidence.

## Exact comparison contract

Every observation binds:

- lane, suite and suite version;
- exact fixture SHA-256 and grader version;
- response mode, output budget, temperature, seed, thinking mode, and optional
  tool protocol;
- provider, model, model/provider version, API version, and provenance source;
- local artifact digest or cloud price snapshot as applicable;
- quality, latency, availability, usable context, attempts, and timestamp.

Benchmark groups observations by the computed contract fingerprint. Results
with different fingerprints are shown in different groups and are never ranked
against each other. Within one exact group, each tier has its own candidate
leader. The report deliberately returns `universalWinner: null`.

## Paid-call attribution

Provider prices use integer nanodollars per million tokens. Input, output,
cache-read, and cache-write components are multiplied and rounded half-up to
the nearest nanodollar. The integer `totalCostNanodollars` is authoritative;
`totalCostUsd` is a fixed nine-decimal display string.

Each receipt includes provider/model/version identity, effective price time,
source, component arithmetic, and a SHA-256 fingerprint. Paid observations are
rejected when the receipt is missing, altered, or belongs to another campaign,
lane, tier, or provider identity. A configured zero-dollar fallback is not
accepted as paid provenance: the caller must supply the actual effective price
snapshot.

## API

All routes are under `/api/benchmark`:

| Method | Route | Effect |
|---|---|---|
| `POST` | `/cloud-lanes/plan` | Normalize a campaign and expose its cohort and approval gates. |
| `POST` | `/cloud-lanes/approval-check` | Validate an immutable paid-plan declaration; always returns `networkAuthorized: false`. |
| `POST` | `/cloud-lanes/attribute` | Attribute one already-observed provider call. |
| `POST` | `/cloud-lanes/compare` | Produce an exact-contract, cohort-separated report. |

These routes are pure calculations. A caller cannot use them to send prompts,
load models, mutate route configuration, or spend money.

## Measured campaign runner

`benchmark/src/services/benchmark/cloudLaneCampaignRunner.js` is an
operator-invoked execution boundary. It is deliberately not mounted as an HTTP
route. A measured run:

1. normalizes and fingerprints every fixture, message, tool definition,
   grader expectation, and input/cache token ceiling;
2. recomputes the plan fingerprint and requires
   `estimatedCalls = candidates × fixtures × attempts`;
3. calls a host-supplied `authorizeExecution` authenticator before any
   transport preflight or provider call;
4. preflights every candidate and aborts the whole campaign on provider,
   model, version, API, context, artifact-digest, or price drift;
5. sends the same frozen generation contract to every candidate;
6. checks token ceilings, grades the response, and emits one fingerprinted
   execution receipt per call; and
7. returns the raw provider response, normalized usage, attribution receipt,
   measured observations, and cohort-separated comparison in one fingerprinted
   evidence artifact.

Transport failures that do not produce provider evidence abort the campaign.
An HTTP provider rejection can be recorded as `ok: false` availability
evidence when the transport can still bind its identity and usage. Execution
receipts bind the response fingerprint, attribution fingerprint, and execution
authorization fingerprint. They do not authorize a later route change.

Built-in deterministic graders use version `agentx-builtins-v1` and support
exact text, contains-all, exact/subset JSON, and tool-call checks. A custom
grader must be injected as a callback carrying the exact `graderVersion` from
the contract.

### Provider transports

The supplied adapters cover exact Ollama chat and OpenRouter chat-completions:

- Ollama preflight checks `/api/tags`, `/api/version`, and `/api/show` for the
  exact model artifact, runtime API version, and context window.
- OpenRouter preflight reads the current official model catalog and checks the
  canonical model version, context window, token prices, and advertised
  generation parameters. Provider credentials exist only in runtime memory.
- Other OpenAI-compatible services can use the generic adapter only with an
  injected current-model metadata resolver. An unverified `/models` response
  is not enough to establish version, context, and price provenance.

Every real cloud candidate, including a free candidate, requires a current
immutable price snapshot. Free calls are accepted only when all four rates and
the resulting attributed cost are exactly zero.

### Paid boundary

The library supports paid accounting but fail-closes unless all of these are
present:

- the existing short-lived approval bound to the exact plan, candidates, call
  count, and nanodollar ceiling;
- a separate authenticated runner authorization bound to that approval
  fingerprint and the same ceilings;
- current non-zero price provenance; and
- enough remaining approved spend for the worst-case frozen token ceilings
  before each call.

Actual spend and call counts are checked again after every call. The portable
CLI intentionally has no paid-execution flag; a deployment must supply a
reviewed authenticated host integration. Planning a paid campaign remains
safe and performs no network activity.

## Offline proof

Run from `benchmark/`:

```text
npm run compare:cloud-lanes:offline
npm run campaign:cloud-lanes -- --campaign data/cloud-lane-campaign.example.json --fixtures data/cloud-lane-campaign-fixtures.example.json
npx jest --config jest.unit.config.js --runInBand tests/unit/benchmark/cloudLaneAccounting.test.js tests/unit/benchmark/cloudLaneRoutes.test.js
```

Both commands report zero network calls and zero real spend. The first command's
paid receipt is synthetic arithmetic used only to prove attribution and tamper
detection. The second validates a full campaign plan without constructing a
transport.

## Executing a local/free comparison

Copy and replace every placeholder in:

- `benchmark/data/cloud-lane-campaign.example.json`;
- `benchmark/data/cloud-lane-campaign-fixtures.example.json`; and
- `benchmark/data/cloud-lane-transports.example.json`.

Run the plan-only command after editing fixtures. A mismatch fails closed and
reports the newly computed fixture fingerprint to place in the campaign. Capture current artifact/API/context evidence for local
models and current canonical version/context/zero-price evidence for cloud
models. Keep API keys out of JSON and expose only the named environment
variable at runtime.

Then run:

```text
npm run campaign:cloud-lanes -- \
  --campaign path/to/campaign.json \
  --fixtures path/to/fixtures.json \
  --transports path/to/transports.json \
  --output path/to/new-evidence.json \
  --execute-free
```

The output path must be new; the CLI refuses to overwrite earlier evidence.
The explicit flag plus the authenticated local OS session authorize only local
and free-cloud execution. The complete raw evidence is written to the output
file while stdout contains a secret-free summary. Promotion remains a distinct
operator decision after the lane-specific report is reviewed.

## External worker evidence is separate

Existing model campaigns continue to use their exact generation and lane
contracts. Imported harness evidence uses the additive
[worker envelope and receipt contract](WORKER_HARNESS_CONTRACTS.md) and
`POST /api/benchmark/worker-evidence/compare`.

The worker endpoint validates envelope-bound receipts without changing a
campaign, candidate schema, runner, stored model result, lane leader, or route.
Portable comparisons freeze the envelope, model, API, prompt, tools, and
policies while requiring distinct harness identities. Native-ceiling evidence
preserves separate exact model+harness tuples and does not declare a universal
winner across unlike tuples.
