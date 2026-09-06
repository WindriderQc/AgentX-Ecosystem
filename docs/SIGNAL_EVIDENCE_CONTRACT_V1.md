# Signal Evidence Contract v1

Status: canonical product contract. Implementation: `shared/signalEvidence.js`
(CommonJS, dependency-free) and its browser bundle
`core/public/dist/signal-evidence.js` built from
`core/src/frontend/signal-evidence.js`. Tests: `shared/signalEvidence.test.js`.

## Why

A product surface may only print a number when that number was measured.
Before this contract, Agent X pages could render absence as `0`, an empty
denominator as `100%`, a single candidate as `Best ★`, and a timestamp-less
source as fresh. The same phenomenon could be healthy on one page and an
alert on another. The contract gives every rate, average, count, delta and
ranking one portable shape with an explicit evidence state, sample size,
provenance and freshness, and one deterministic rendering projection.

## Shape

```json
{
  "schema": "agentx.signal-evidence.v1",
  "id": "analytics.rag.usage_rate",
  "kind": "ratio",
  "scope": { "from": "…", "to": "…" },
  "unit": "percent",
  "state": "insufficient_sample",
  "value": 100,
  "lastValue": null,
  "sample": { "n": 1, "numerator": 1, "denominator": 1, "minimum": 5 },
  "freshness": { "state": "fresh", "observedAt": "…", "ingestedAt": null, "ttlMs": 300000, "ageMs": 12 },
  "source": "conversations",
  "reason": "below_minimum_sample",
  "detail": null,
  "drilldown": "/api/analytics/rag-stats",
  "contributors": [],
  "contradictions": [],
  "comparison": null
}
```

| Field | Meaning |
|---|---|
| `id` | Stable lowercase identifier (`[a-z0-9._:-]`). Two surfaces that speak about the same phenomenon use the same id. |
| `kind` | `count`, `ratio`, `average`, `difference`, `ranking`, or `measure`. |
| `scope` | Subject or window the signal covers. Free-form JSON. |
| `unit` | `percent`, `points`, `ms`, `usd`, `count`, or a producer unit. Drives formatting only. |
| `state` | Evidence state (below). |
| `value` | Printable number. Present only in value-bearing states. |
| `lastValue` | The last measured value when the signal is `stale`. |
| `sample` | `n` observations backing the value, plus `numerator`, `denominator` and the declared `minimum`. |
| `freshness` | Derived only from real timestamps: `fresh`, `stale`, `unknown`, or `not_applicable`. |
| `source` | Producer or collection name. Never a URL. |
| `reason` | Machine reason for a non-observed state (`empty_denominator`, `no_observations`, `needs_both_cohorts`, `no_comparator`, `ttl_exceeded`, …). |
| `detail` | Human sentence. Must not carry an absolute location. |
| `drilldown` | Relative path only. Absolute or protocol-relative URLs are dropped. |
| `contributors` | `{ id, state, detail? }` of the signals a parent aggregates, so a degraded contributor stays visible. |
| `contradictions` | `{ signalId, source?, detail? }` when another surface disagrees; forces the `contradicted` state. |
| `comparison` | For rankings: `{ state, direction, best, comparable, of, minimumCandidates, ranked[] }`. |

## Evidence states

| State | Value printed | Meaning |
|---|---|---|
| `observed` | yes | Measured on a real sample (zero included) or as a census count. |
| `insufficient_sample` | yes, with warning | Measured, but `sample.n` is below `sample.minimum`. The UI prints the value beside `Low sample` and the n. |
| `missing` | no (`—`) | Nothing to measure: empty denominator, no observations. Labelled `Not observed`. |
| `stale` | no (`—`, last value aside) | The observation is older than its TTL. |
| `unavailable` | no | The producer or a dependency did not answer. |
| `disabled` | no | The collector or feature is deliberately off. |
| `not_applicable` | no | The signal has no meaning here (for example a price for local inference). |
| `partial` | yes, with warning | Some contributors are missing; the value covers a subset. |
| `contradicted` | yes, with warning | Another surface reports a conflicting state. |

Rendering tones follow `docs/UX_DOCTRINE.md`: `observed` is ready (green);
`insufficient_sample`, `stale`, `partial` and `contradicted` need attention
(amber); `missing`, `unavailable`, `disabled` and `not_applicable` are unknown
(neutral gray, `Not observed`). `Unknown` is never converted to green or to a
zero.

## Invariants

1. `0` is printed only when zero was measured: a ratio or average with
   `sample.n = 0` becomes `missing`; a census count of zero stays `observed`.
2. An empty denominator never yields a percentage.
3. A ranking names a `best` only with at least two comparable candidates and
   no tie at the top. A lone candidate is `no_comparator`; unpriced or
   otherwise incomparable candidates carry `rank: null`.
4. A difference needs both cohorts measured; otherwise it is `missing` with
   `needs_both_cohorts` and both contributors listed.
5. Freshness is `unknown` without an observation timestamp, never `fresh`.
6. An observation older than its TTL becomes `stale`; its number moves to
   `lastValue` and is rendered as history, not as current.
7. A contradiction from another surface overrides an observed value.
8. `drilldown` is a relative path; `detail`, `reason` and `source` carry no
   absolute location. `parseSignal` rejects anything that breaks these rules,
   so a forged client payload cannot be rendered as attested evidence.
9. Serialization has a fixed key order and round-trips through JSON.

## Producers (v1 slice)

| Route | Signals |
|---|---|
| `GET /api/analytics/inference/summary` | `signals.avgClassificationMs`, `signals.avgTotalForClassifiedMs`, `signals.classificationOverheadPct`. Raw `totals.*` fields are `null` (not `0`) when no call was classified, matching the Nerve Center routing summary. |
| `GET /api/analytics/rag-stats` | `signals.ragUsageRate`, `signals.ragPositiveRate`, `signals.noRagPositiveRate`, `signals.ragFeedbackDelta`. Minimum sample 5 (`CHAT_LANE_MIN_SAMPLE`). Raw rates are `null` on an empty denominator. |
| `GET /api/analytics/costs` | `signals.costEfficiencyRanking` over priced rows (`cost.total > 0` and `tokens.total > 0`); each breakdown row carries `priced`. |
| `GET /api/rag/telemetry/search/summary` (RAG service) | `signals.searches` (census count), `emptyRate`, `failureRate` (minimum sample 5), `avgDurationMs`, `avgResultsPerAnsweredSearch`, `lastSearch` (freshness from the last recorded event). Backed by the bounded `ragsearchevents` collection written by `POST /search`: query length, options, result count, top score, duration and status only; never the query text or a passage. |

## Server-attested inference attribution (v1 slice 2)

Every AgentX-routed inference call lands in `inferencelogs` through
`recordInference`, and the attribution is generated by the server, never
copied from a request body:

| Lane | `caller` | `callerDetail` | `consumerContract` | Correlation |
|---|---|---|---|---|
| Playground chat (Quick, Standard, Deep, Manual) | `chat` | `chat-<userId>` or `chat` | — | `taskType` (`quick_chat`, `general_chat`, `deep_reasoning`, or none for Manual), `autoRouted` (Standard classifies), and `routeDecision` (recommended versus served route, model and host) |
| Council participant turn | `council` | `council:turn:<agentId>:round<n>` | `core-council-v1` | `correlationId` = roundtable id, `taskType` = `council_deliberation` |
| Council synthesis | `council` | `council:synthesis:synthesizer` | `core-council-v1` | same roundtable id |

A Council session whose page shows six turns plus a synthesis therefore
matches seven `inferencelogs` rows sharing one `correlationId`. Prompts,
responses and private reasoning never enter telemetry. The Playground button
`Open in Council` is an explicit handoff (`/council?question=…&source=playground`):
it never convenes a session or sends a chat turn; the Council page records the
`playground-handoff` source when the operator convenes.

Raw numeric fields are kept for backward compatibility; the `signals` block
is additive. Renderers prefer the attested signal and rebuild it locally with
the same rules only when an older payload carries none, so a rollback of the
server without the client (or the reverse) stays honest.

## Renderers

`formatSignal(signal)` returns `{ text, label, tone, state, detail, sample,
drilldown }`. `text` is the formatted value or the shared placeholder `—`.
Surfaces set `data-signal-state`, `data-signal-tone` and `data-signal-sample`
on the value element and put `label` in an adjacent note, so a compact tile
keeps its provenance and a secondary surface (for example the Activity
cockpit summary) can read the same state instead of parsing text.

## Extending

Add producers one vertical slice at a time. Reuse `ratioSignal`,
`averageSignal`, `countSignal`, `differenceSignal` and `rankingSignal`; use
`buildSignal` directly only for a producer-declared state (`unavailable`,
`disabled`, `not_applicable`, `partial`). Declare a `minimum` sample and a
`ttlMs` from a named constant, never an inline number. When two surfaces
disagree, attach a `contradictions` entry rather than choosing one.
