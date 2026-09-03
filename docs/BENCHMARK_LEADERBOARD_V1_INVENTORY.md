# Benchmark leaderboard V1 field inventory

This inventory records the presentation-only leaderboard refactor. The API,
ranking order, scoring formulas, trust decisions, qualification rules and
routing behavior are unchanged.

## Surface map

| Area | Before | V1 initial row | V1 model sheet |
| --- | --- | --- | --- |
| Rank | First cell of a three-line card | First compact column | Repeated in the sheet header |
| Model identity | Card header | Primary row label | Sheet heading |
| Readiness | Inline badge | Inline badge | Repeated beside evidence state |
| Deleted / unranked state | Separate header badges | Consolidated into the row evidence line | Full badges with explanations |
| Score and score axis | Large number at card right | Graphic radial score | Larger radial score and axis label |
| Trend | Beside the card score | Detail only | Beside the sheet score |
| Provider and tier | Card source line | Compact source line | Provenance rail |
| Host name and exact host | Host metadata was implicit in the card | Friendly host in the row | Friendly name plus exact host URL |
| Harness name and version | Card source line | Detail only | Provenance rail |
| Pricing kind / source | Card source line | Detail only | Provenance rail and cost cell |
| Judge identity | Gavel tooltip | Detail only | Named provenance cell |
| Evidence state | Text beside Manual Chat | One consolidated row state | Full evidence badge and cohort fingerprint |
| Category champion badges | Badges column | Detail only | Capability profile |
| Best / watch category | Pills in badges column | Encoded by the seven-lane graphic | Named pills in capability profile |
| Seven category scores | Seven horizontal bars | Seven compact vertical bars; missing stays empty | Seven labelled horizontal bars with missing reason |
| Average / p95 latency | Timing column | Detail only | Runtime profile |
| Benchmark / host TTFT | Timing column and host metadata | Benchmark TTFT summary | Runtime profile |
| Throughput | Speedometer | Numeric `tok/s` summary | Full speedometer |
| Tests | Stats footer | Coverage summary fallback | Evidence ledger |
| Prompt levels | Stats footer | Detail only | Evidence ledger |
| Context sizes | Stats footer | Detail only | Evidence ledger |
| Hard coverage / penalty | Stats footer | Coverage summary | Evidence ledger with tooltip explanation |
| Evidence confidence / penalty | Stats footer | Row evidence state | Evidence ledger with provenance explanation |
| Partial scope | Stats footer badge | Consolidated into the row evidence line | Dedicated evidence cell |
| Uncertainty | Stats footer | Compact value or explicit unknown | Evidence ledger with method and sample explanation |
| Judge calibration | Stats footer | Detail only | Evidence ledger |
| Needs review | Stats footer | Detail only | Evidence ledger; remains distinct from reviewed count |
| Low-confidence count | Stats footer | Detail only | Evidence ledger; unknown remains an em dash |
| Success rate | Stats footer | Detail only | Evidence ledger |
| Provider cost | Stats footer | Detail only | Evidence ledger with attribution tooltip |
| Performance coefficient | Stats footer | Detail only | Evidence ledger |
| Courthouse | Header icon link | Detail only | Labelled action |
| Efficiency Map | Header icon link | Detail only | Labelled action |
| Manual Chat | Header action and evidence text | Detail only | Labelled manual action plus no-routing disclaimer |

## Page-level information

The initial surface now starts with filters, one compact evidence notice and
the scan-first model list. On narrow screens the filters collapse into a native
`details` control so the first model is visible without scrolling through every
filter group.

The fleet summary, podium, scoring explanation and category heatmap remain
available under **Cohort visuals & scoring**. The former trust and hard-coverage
alerts are merged into one compact evidence notice. Its disclosure retains the
qualification limitation, compatible-cohort status, excluded legacy/stale
batch count, hard-level human coverage and links to evidence collection and
Courthouse calibration.

## Verification record

- Focused Benchmark UI contracts: 4 suites, 40 tests.
- Desktop Chromium viewport: 1440 x 900; compact list and complete model sheet
  captured with representative local, cloud, partial and deleted evidence.
- Mobile Chromium viewport: 375 x 667; first model visible with filters
  collapsed; model sheet is internally scrollable with no page overflow.
- Native dialog behavior: mouse/keyboard activation, Escape close and focus
  return to the originating row verified.
- Missing category and confidence values remain unavailable/unknown, never
  measured zero.

The browser fixture was synthetic and used only to exercise presentation
states. It is not benchmark evidence and does not assert a qualified winner.
