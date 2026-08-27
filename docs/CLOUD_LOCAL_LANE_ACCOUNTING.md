# Cloud and local lane accounting

Agent X compares local, free-cloud, and paid-cloud models without turning a
benchmark result into routing authority. The Benchmark service owns a
stateless `agentx.lane-comparison.v1` contract for planning comparisons,
normalizing evidence, and attributing the cost of already-observed provider
calls.

This is a portable product capability. It contains no provider credential,
private endpoint, household identity, or environment-specific model choice.

## Policy boundary

- Local, free-cloud, and paid-cloud observations remain separate cohorts.
- `family` and `kid` lanes reject every non-local candidate.
- Paid cloud is an ultimate tier. A paid plan requires an exact, short-lived
  operator declaration binding the campaign, candidates, call count, and
  nanodollar ceiling.
- The stateless approval check validates declaration scope; it is not an
  authenticated execution token. A future network runner must authenticate the
  operator again at its own boundary.
- Comparison never emits a universal winner, changes routing, contacts a
  provider, persists a result, or authorizes network access.
- Synthetic fixtures prove contract behavior only. They are never model
  performance evidence.

## Exact comparison contract

Every observation binds:

- lane, suite and suite version;
- exact fixture SHA-256 and grader version;
- response mode, output budget, and optional tool protocol;
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

## Offline proof

Run from `benchmark/`:

```text
npm run compare:cloud-lanes:offline
npx jest --config jest.unit.config.js --runInBand tests/unit/benchmark/cloudLaneAccounting.test.js tests/unit/benchmark/cloudLaneRoutes.test.js
```

The fixture command reports zero network calls and zero real spend. Its paid
receipt is synthetic arithmetic used only to prove attribution and tamper
detection.

## Executing a real comparison

A separate, reviewed runner may eventually execute an exact campaign. It must
freeze the same contract before call one, retain raw response evidence under
the benchmark retention policy, authenticate any paid approval, enforce its
call and spend ceilings, persist one receipt per paid call, and stop on pricing
or identity drift. Promotion remains a distinct operator decision after the
lane-specific report is reviewed.
