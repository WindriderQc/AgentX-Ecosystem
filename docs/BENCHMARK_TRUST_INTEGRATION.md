# Benchmark Trust integration

This layer integrates the pure `BenchmarkTrustReceipt v2` contract with the
Benchmark service without granting Product any deployment, routing, or human
ratification authority. It is an implementation foundation, not campaign
acceptance.

The v2 reader preserves immutable v1 receipts for read and retention only;
legacy receipts can never be newly qualified. The strengthened launcher emits
`agentx.benchmark-trust-campaign-spec/v2` (`schemaVersion: 2`), commits
`agentx.benchmark-trust-source-context/v3`, and fingerprints
`agentx.benchmark-trust-analysis-plan/v2`. Earlier CampaignSpec and source
context identities are rejected rather than silently reinterpreted.
Historical v1 receipt methods (`paired-prompt-t-v1`, `paired-bootstrap-v1`,
`paired-permutation-v1`), corrections (`bonferroni`, `holm-bonferroni`,
`none`), and a zero minimum-effect margin remain accepted only by the v1
reader so existing content identities can be audited and retained. They are
not accepted for v2 emission and cannot produce a qualified verdict.

## Ownership

| Concern | Owner | Product behavior |
|---|---|---|
| Receipt schema, canonical identity, structural validation | Product | `shared/benchmarkTrustReceipt.js` |
| Statistical decision artifact | Product | paired prompt means, exact repeat indexes, simultaneous distribution-free Bonferroni-Hoeffding intervals |
| Receipt persistence and evidence retention | Product | append-only Mongo store and read-only API |
| Exact execution and evidence capture | Harness | must freeze prompts, repeats, candidates, artifacts, exclusions, and decision bytes |
| Judge selection and qualification campaign | AIOps + harness | Product only binds the resulting qualification receipt fingerprint |
| Ratification, revocation, promotion, routing, deployment | Human + AIOps | separate attestation and guarded operational action |

## Durable source-batch mapping

Portable receipts never contain a MongoDB `_id`. Each new `BenchmarkBatch`
receives an immutable random `trust_batch_id` with the form
`batch_<32 lowercase hex>`. `receipt.execution.sourceBatchId` must match that
field before the receipt store accepts the receipt.

Legacy batches require the explicit additive migration:

```text
npm run migrate:benchmark-trust-batches -- --dry-run
npm run migrate:benchmark-trust-batches
```

The migration validates existing values and duplicates before writing, assigns
only missing values with a conditional update, retries random unique-index
collisions, and installs the unique partial index. Its summary reports counts
only; it does not print Mongo or opaque identifiers. It is not run by service
startup and must pass an operator review before apply.

## Append-only storage

`BenchmarkTrustReceipt` verifies the shared contract and canonical
serialization before insert. Indexed fields are verified projections of the
payload. A unique `receiptId` arbitrates concurrent writers; a duplicate is
idempotent only when the existing canonical payload verifies exactly. Model
updates, replacements, deletes, document deletes, and bulk writes are blocked.

Storage also requires a terminal source batch and an exact full source
inventory equal to `expectedResultCount`. Product's canonical source verifier
loads the sealed Mongo rows itself and recomputes the frozen candidate/prompt
universe, repeats, exclusions, result-set and cell fingerprints, judge/score
binding, statistical projection, decision, and server-derived freshness. A
caller cannot replace this verifier. An optional
`verifyExternalSourceEvidence` callback may add an environment-specific gate,
but it is evaluated only after canonical verification and must return literal
`true`; it is an additional AND, never an approval override.
Execution and score bindings are not adjacent opaque claims. Before execution,
the source context freezes each candidate Worker identity, tools, policies,
execution profile and complete envelope-set fingerprint, plus the exact judge
identity, qualification identifiers, target, tools, policies, execution
profile, scoring method/version, and prompt fingerprints. Every row must carry
the complete private `agentx.worker-receipt/v1` returned by the harness for
candidate execution and judging. Product verifies the real harness semantics:
the candidate receipt prompt fingerprint is the fingerprint of the exact text
sent to the candidate and its result fingerprint is the candidate output; the
judge receipt uses the exact judge prompt and raw judge output. Candidate
envelope sets are recomputed across the exact preregistered rows. A minimal or
modified receipt, a receipt with a different envelope, or reuse of one row's
receipt for another row fails closed. Public receipt projections remain
available for diagnostics, while full receipts are private server evidence.
WorkerReceipt v1 is content-addressed integrity evidence, not an issuer
signature. A consumer must still verify the separate judge qualification
attestation against its current trust root; Product does not infer issuer
authority from a self-consistent WorkerReceipt.
Complete evidence additionally requires a `completed` batch. The model-owned
Trust finalizer first seals every exact source result, verifies the sealed
inventory, and then atomically marks the batch terminal with one server
`completed_at`/`updated_at`/`trust_evidence_finalized_at` timestamp and
`trust_evidence_sealed`. Receipt issuance accepts only that durable finalized
state. Consequently a rejected issuance leaves the finalized evidence
protected for review; it does not unseal it. Subsequent model updates,
replacements, deletes, document saves/deletes and bulk writes fail
with the batch/result sealed-evidence error. New result saves and `insertMany`
share the evidence mutex and reject sealed target batches; query upserts,
update pipelines, replacements, and any attempt to change an existing result's
`batch_id` are rejected. Corrections or human rejudging must create a new batch
and therefore a new receipt identity.
For a batch with frozen Trust context, ordinary terminal transitions are also
rejected. Only the model-owned Trust finalizer can set the terminal status and
server completion timestamp while holding the same evidence mutex used by
result insertion. This closes both insert-versus-completion and
update-versus-counter races: results are sealed before final counters are read,
later writes fail, and verification requires every result creation timestamp
to be server-created after both durable start timestamps, with its durable
update timestamp no earlier than creation and neither timestamp later than
completion. Caller-supplied Trust result creation times are rejected. Legacy
batches without Trust context keep their ordinary lifecycle. Model
`insertMany` cannot inject source context or its server commit timestamp,
query upserts cannot materialize a batch context through filter equality, and
aggregate pipelines containing `$merge` or `$out` are rejected recursively for
both batches and results.
If the final batch CAS loses a race after result sealing, Product deliberately
does not guess at a rollback: the partial sealed inventory remains protected
and requires explicit operator review. It cannot become receipt-qualified.
The source verifier runs after sealing, before receipt insertion. Mutations
that finish first are therefore included in verification; mutations that race
after the seal cannot match the model's mandatory unsealed predicate.

Freshness is derived rather than asserted. `createdAt` is the durable server
completion time, a future completion is invalid, and `validUntil` is the
earliest of the preregistered stale cutoff and the judge validity cutoff. The
longer expiry interval only distinguishes a late-stored receipt as `expired`;
it cannot extend qualification beyond `stale`.

For Benchmark trust receipts, only bounded reads are registered:

- `GET /api/benchmark/trust-receipts/:receiptId`
- `GET /api/benchmark/trust-receipts?source_batch_id=batch_<32hex>&limit=N`

There is deliberately no HTTP receipt issuance, ratification, revocation,
promotion, or routing endpoint in this change. The separately described strict
launch endpoint starts only a preregistered campaign; it cannot issue or qualify
a receipt.

## Consumer fail-closed bridge

Historical consumers remain useful for inspection, but they cannot upgrade
their own metrics into Trust authority:

- `/api/benchmark/recommend` keeps every Phase 0 row at low confidence and
  ignores caller-supplied qualified-winner fields;
- `/api/benchmark/sweeps/recommend` treats caller-supplied metrics as
  exploratory observations and downgrades an otherwise promotable result to
  `inconclusive` until a receipt and ratification are verified;
- the Efficiency Map exposes an exploratory trust verdict and awards no medal,
  even if its browser input contains forged qualified-winner fields;
- Core Planning refuses to turn a Phase 0 generalist score into progress,
  including when the upstream payload claims `qualified: true`;
- legacy Model Registry scores remain visible observations, but do not sort
  category catalogs, break routing-priority ties, or crown a model.

This bridge does not create the missing positive authority path. The current
Phase 0 cohort projection still returns `qualified: false`, and the Product
still has no ratification issuer or deployment action. A later AIOps-owned
verifier must bind a separate human attestation before any consumer can receive
a positive qualified-winner verdict.

Receipt insertion and every destructive cleanup path share the standalone-
Mongo-safe `benchmark-trust-evidence-mutation-v1` mutex. The store holds it
while it verifies and inserts; Trust finalization uses the same mutex while it
seals results and finalizes the batch. Archive, prune, purge, global/failed
clear and reset hold it from protection discovery through deletion. Cleanup
may remove an eligible legacy or not-yet-finalized inventory. Once Trust
finalization wins, later cleanup sees the durable seals and preserves the
evidence even if receipt issuance is later rejected. The mutex has a renewable
liveness lease but is never stolen automatically. A process crash leaves
mutation blocked until an operator verifies that the recorded owner is dead
and invokes explicit recovery with the exact observed owner token and
acquisition timestamp. A concurrent renewal changes that timestamp and makes
recovery fail closed; this avoids unsafe overlap after an event-loop pause.

## Strict launch runtime (disabled by default)

The general Benchmark start API remains an ordinary, non-qualifying surface.
The only source-context-producing path is:

- `POST /api/benchmark/trust-batches/:specId/start`

The request body must be empty. `specId` is the lowercase SHA-256 identity of a
canonical `agentx.benchmark-trust-campaign-spec/v2` body with `schemaVersion: 2` stored as
`<specId>.json` below the absolute server-owned
`BENCHMARK_TRUST_CAMPAIGN_SPEC_DIR`. Callers cannot submit a source context,
candidate identity, judge identity, prompt bytes, policy, clock, or Product
manifest through this route.

The route additionally requires the existing Product operator credential
(`AGENTX_OPERATOR_TOKEN`, with the legacy `AGENTX_ADMIN_TOKEN` fallback) as a
Bearer token or `x-agentx-operator-token`. Same-origin or loopback admission
alone cannot consume the one-shot CampaignSpec.

The path is fail-closed unless `BENCHMARK_TRUST_CAMPAIGNS_ENABLED=true`, the
running Product profile is explicitly `full` (the profile that starts Trust
crash recovery), and the service exposes the exact immutable Product manifest through
`AGENTX_PRODUCT_REVISION`, `AGENTX_CORE_IMAGE_DIGEST`,
`AGENTX_BENCHMARK_IMAGE_DIGEST`, and `AGENTX_RAG_IMAGE_DIGEST`. That manifest
must equal the content-addressed spec. V2 accepts only local or free, available,
`isolated_model` harness targets with candidate capability and one isolated
harness judge with judge capability. Local models remain behind that harness
and its exact Worker identity; direct Ollama execution, native agents,
paid targets, duplicate targets/prompts, expired judge authority, target drift,
and Worker identities not bound to the exact target all fail before launch.
For v2, the candidate artifact digest is the exact model digest attested by the
Worker identity; a separate self-declared artifact digest is not accepted.

The judge authority is not a status string. `judgeAuthority` contains one
canonical `agentx.benchmark-judge-qualification-attestation/v1`, signed with
Ed25519 by a server-trusted qualification authority. Product verifies its
signature, current validity, key validity window, key scope, current revocation
snapshot and exact Worker identity before launch. The signed evidence covers
all seven categories and five difficulty levels and enforces the frozen MAE,
tolerance, review precision/recall and rank-correlation thresholds. Every one
of the 35 category x difficulty cells carries at least two validation and three
sealed holdout observations; difficulty sums must equal category totals and
category sums must equal the 70/105-or-larger corpus totals. The signed rubric
fingerprint must equal the canonical runtime rubric derived from the actual
scorer version/components, loaded prompt/scorer/parser functions, scoring
dimensions and weights, invocation parameters, result contract, tools and
execution policies. The exact Product source-module digests are also bound.
That canonical rubric is retained in the source context so
receipt verification can recompute the binding rather than trust a label.
Trust roots and revocations are loaded
only from `BENCHMARK_JUDGE_QUALIFICATION_TRUST_ROOTS_JSON` and
`BENCHMARK_JUDGE_QUALIFICATION_REVOCATIONS_JSON`. The revocation document is
content-addressed and versioned; its version must be at least the operator pin
in `BENCHMARK_JUDGE_QUALIFICATION_MIN_REVOCATION_VERSION`, and its exact
content identity must equal
`BENCHMARK_JUDGE_QUALIFICATION_REVOCATION_SNAPSHOT_ID`. An attestation cannot
outlive the trusted signing key's `notAfter` boundary.

At launch, Product validates the signed qualification structure and coherent
aggregates and treats the configured issuer as the qualification authority; it
does not load the private raw holdout inventory. That is intentionally a trust
boundary, not a claim that a signature recreates the experiment. No receipt can
be derived as qualified until the consumer-side `verifyJudgeQualification`
callback independently replays the exact qualification receipt, holdout, and
current authority state.

Product resolves the current harness catalog again, resolves the exact Mongo
prompt documents, computes opaque candidate/prompt identities, builds every
real candidate envelope for every preregistered repeat, and derives the private
source context. A single evidence-lock transition then commits that context,
the server commit time, `status=running`, and `started_at` to an empty pending
batch. The execution lock is acquired afterward. Strict result creation
requires the mapped opaque cell ids, a full private candidate WorkerReceipt,
and a server timestamp after both durable starts. Judging may append one private
judge WorkerReceipt exactly once. Stop, crash recovery, stale-claim recovery,
and process shutdown all use the Trust finalizer so partial evidence is sealed
and remains non-qualifying instead of falling back to the legacy lifecycle.
At service restart, a fixed boot-time cutoff identifies only strict campaigns
owned by the prior runtime. Failed finalization is retried by a deferred sweep;
those campaigns are never re-claimed as live work and campaigns created after
the cutoff are never touched.
Core acquires, refreshes, and releases host claims with an atomic owner-and-state
compare-and-swap. Each acquisition has a cryptographic UUID `claimGeneration`
in addition to `batchId`; heartbeat and release must match both values. This
prevents an old process from mutating a later acquisition even when the same
batch id is reused. Previously unseen hosts are first seeded neutrally behind a
materialized unique `hostUrl` index, then claimed with the same status-aware
CAS, so a concurrent ready state is preserved as `prevStatus`. Concurrent
claimants cannot both win, and a stale release or heartbeat cannot overwrite a
newer owner. A refused release remains a reported failed recovery item for
deferred reconciliation instead of being counted as released. During an
operator stop, local ownership remains
visible until every cancelled request drains and the runner completes its claim
teardown; a repeated stop cannot trigger an early direct release.

Each `specId` has a unique durable batch reservation and is consumable exactly
once, even when preregistration fails. Cleanup marks an abandoned reservation
failed without deleting it. Finalization is retry-safe across a crash after
result sealing, but `completed` is allowed only for the exact preregistered
result count when every result succeeded and carries its private judge
WorkerReceipt. The CampaignSpec also freezes one source fingerprint per prompt
and the exact candidate/judge harness invocation. Product rejects prompt or
parameter drift, assisted WorkerReceipts, judge-output/score disagreement,
in-place human review of strict results, excessive JSON depth, more than 16
targets, more than 500 prompts, or more than 10,000 execution cells.

The signed variance pilot is additionally bound to a canonical prompt-policy
artifact recomputed by Product. It covers the campaign selection artifact, the
exact set of selected prompt-source fingerprints, the cross-platform semantic
prompt-transformation fingerprint, and every normalized setting consumed by
`buildPromptHints`. Recalculating prompt authorities and `specId` after
replacing a prompt or changing a custom hint, response contract, thinking
instruction, or template cannot reuse the earlier pilot or power basis.

Generic batch, active/stuck, stream and timeline GETs use a strict public
projection for Trust campaigns. Querying full/heavy text still returns only
opaque ids, states and numeric metrics; candidate/judge text, prompt templates
and infrastructure identities remain private. Product also refuses to export a
Trust batch into the generic reusable-template store.

Enabling this endpoint does not establish a trusted judge, usable human corpus,
campaign acceptance, receipt ratification, or deployment authority. Those
remain external gates and the endpoint must stay disabled until their exact
server-side artifacts and trust roots are installed.

## Statistical gate

The independent unit is the prompt. Repeated attempts are averaged inside each
candidate-prompt cell. Every row must carry a unique `repeatIndex` from zero
through the preregistered `repeatCount - 1`; duplicate, missing, extra, or
invalid repeats fail the whole interval family closed.
The launcher rejects the CampaignSpec before execution unless `alpha` is
exactly representable in basis points and both the minimum and powered effects
are exactly representable in score microunits, matching the final receipt
projection.
Unique prompt ids and a prompt-catalog fingerprint do not prove independent
sampling. A statistical receipt may record the conditional result under its
frozen analysis plan, but `deriveBenchmarkQualification()` additionally
requires a consumer-supplied `verifyPromptIndependence` callback to validate
that exact plan against external signed or explicit human evidence. Missing or
rejected verification blocks qualification with
`prompt_independence_not_verified`.

Both `candidateIds` and `promptIds` are mandatory preregistration fields. The
statistics service never infers a decision-eligible universe from observed
rows; a missing universe produces an explicit inconclusive result.

The v2 decision uses paired prompt differences bounded in `[-10, 10]`,
two-sided Hoeffding intervals, and a Bonferroni family over every unordered
candidate pair. Every raw score outside `[0, 10]`, including a finite epsilon
outside either boundary, fails the complete interval family closed. A winner exists
only when one candidate's simultaneous lower bound is strictly greater than
the preregistered minimum effect against every competitor. Otherwise the
result is an equivalence set, inconclusive, or not evaluated. The projection
to the shared receipt converts alpha to basis points, the minimum effect to
microunits, and derives the decision fingerprint from the normalized decision
artifact.

Power is planned against that same superiority hypothesis, not against zero.
The CampaignSpec must freeze a distinct `poweredAlternativeEffect` strictly
above `mde`; the required prompt count is computed from
`poweredAlternativeEffect - mde`. The alternative remains bound in the
analysis plan, power fingerprint, and receipt preregistration. Omitting it,
placing it at or below the decision margin, or changing it after planning
fails closed. Both values must remain in the actual score domain:
`0 < mde < poweredAlternativeEffect <= 10`. For `F = k(k - 1) / 2` candidate
pairs, score-difference range `R = 20`, family alpha `alpha`, target power `p`,
and powered excess `g = poweredAlternativeEffect - mde`, required sample size is
the smallest integer meeting the distribution-free family bound, beginning at
the ceiling of
`[R * (sqrt(log(2F/alpha)/2) + sqrt(log(F/(1-p))/2)) / g]^2`.
The variance pilot stays bound as a signed comparability/drift guard but never
narrows `R` or the power count. This method is deliberately conservative: a
narrow gap can require thousands of independent prompts or exceed the campaign
prompt cap, in which case the only honest result is underpowered/inconclusive.
Student-t or another assumption-dependent method requires a future receipt
schema and cannot be asserted by v2.

## Judge and human evidence

Courthouse approve and override actions remain useful review evidence, but the
current judge-visible, single-review flow is explicitly classified as either
`endorsed_judge_score` or `human_override_visible_judge`. Neither is eligible
as independent human ground truth. Only `independent_human_score` paired with
`blind_independent` enters the signed v1 qualified-human loader. A v1
attestation has one issuer and cannot honestly prove double review or
adjudication; those protocols require a future composite contract that binds
every reviewer and lineage edge. The model rejects contradictory qualified
provenance/protocol pairs before persistence. Those two
fields are one atomic evidence claim: query updates must write a complete valid
pair together, while update pipelines and provenance-bearing `$setOnInsert`
operations are rejected.

Ordinary `save`, `create`, query-update, and `insertMany` surfaces reject a
qualified provenance/protocol pair, even when its fields are internally
consistent. The only Product admission path is the exact signed package sent
to `POST /api/benchmark/judge/ground-truth/import-attested`. It verifies an
`agentx.benchmark-human-evidence-attestation/v1` Ed25519 signature against
server-loaded public trust roots, current server-loaded revocations, and the
attestation validity interval. A `verified: true` request field, a request-
supplied public key, or a request-supplied verification clock has no authority.

The import is disabled by default. It requires both
`BENCHMARK_HUMAN_EVIDENCE_TRUST_ROOTS_JSON` and
`BENCHMARK_HUMAN_EVIDENCE_REVOCATIONS_JSON`, plus the pinned minimum revocation
version in `BENCHMARK_HUMAN_EVIDENCE_MIN_REVOCATION_VERSION` and exact snapshot
identity in `BENCHMARK_HUMAN_EVIDENCE_REVOCATION_SNAPSHOT_ID`; malformed,
missing, future, stale, content-mismatched, rolled-back or underscoped
configuration fails closed before a source read or write. Each public key has
an issuance window and explicit `benchmark-human-evidence-v1` scope. Product
contains and accepts no reviewer private key or shared signing secret.

Every attestation binds one exact Mongo result id, portable source-batch id,
canonical source-result fingerprint, prompt and response fingerprints,
category, exact judge identity, judge score, blind-independent review protocol,
human score/rationale, pseudonymous reviewer, issuance, expiry, and
nonce. Product reloads the source itself, requires a successful sealed result
inside a completed and fully sealed Trust batch, verifies the complete frozen
batch through the canonical source projector, and derives prompt, response,
category, judge identity, and judge score from those immutable bytes. It never
copies those machine fields from the request. The signed review timestamp must
follow both the source-result update and exact batch finalization.

Admission is one raw service-owned append after model validation. The attestation
fingerprint and issuer/key/nonce projections have unique partial indexes; an
exact replay is idempotent, while a reused nonce, changed stored bytes, or
different content conflicts. Attestation projections and payload are immutable
through ordinary model surfaces. Qualified-human loaders select only attested
rows and reverify the current signature, expiry, and revocation state before
each drift computation. Expired or revoked rows are excluded; missing trust
configuration or stored-byte disagreement fails the load closed. Historical
qualified rows without this attestation remain available for audit but are no
longer decision-eligible. Two simultaneously valid attestations for the same
source result also fail closed instead of double-weighting one response; a
replacement therefore requires current revocation of the superseded evidence.
Public list/problematic and import responses omit reviewer, source-result,
issuer, key and nonce metadata; the private signed payload remains available
only to the verifier.

For a canonical 175-review judge-qualification corpus, Product also exposes a
portable offline packet builder. The input
`agentx.benchmark-blind-review-source-bundle/v1` must contain exactly two
validation and three holdout sealed results for every one of the seven
categories and five difficulty levels. Source result IDs and fingerprints must
be unique, and each response must still match its sealed response fingerprint.

The same builder accepts
`agentx.benchmark-blind-review-source-bundle/v2` for a dedicated, zero-cost
local judge-calibration capture that deliberately precedes judge
qualification. This avoids requiring a qualification attestation in order to
collect the evidence needed to qualify that judge. V2 binds exact Product and
collector revisions, the judge target and model digest, the Product runtime
rubric fingerprint, every judge WorkerReceipt, and a zero-cost/no-fallback
capture profile in the operator-only manifest. It is calibration evidence, not
a Trust campaign result and not an importable substitute for a sealed Mongo
source result.

`node benchmark/scripts/prepare-blind-review-packet.js --input FILE
--output-dir NEW_DIRECTORY` emits a reviewer packet, a separate operator-only
control manifest and a blank response template. Split, source, candidate,
model, host, judge identity and judge score never enter the reviewer packet.
For v2, the packet preserves the Product category-specific dimension names,
descriptions, integer weights, and approved 0-10 scoring anchors; each response
row contains only the dimensions for its own category.
The new output directory must not exist. The builder has no campaign, provider,
network, key-generation, signing, import or overwrite capability. It therefore
cannot make an unexecuted corpus sealed or a human review qualified; it only
prepares the blind boundary around already sealed source results or completed
local calibration captures.

This import proves admission of one human label only. It does not qualify a
judge, ratify a Benchmark receipt, promote a winner, or authorize routing. The
separate AIOps `verifyJudgeQualification` trust-root check remains mandatory.

Judge drift consumes only that qualified-human loader. Missing samples or an
incomplete/missing baseline remain explicit `insufficient_data` or
`no_baseline` states and are never collapsed to `ok`.

The coverage and gap diagnostics use the same live signed-human loader as
judge qualification. Qualified coverage counts unique signed prompt
fingerprints per category x difficulty cell, not candidate repeats or multiple
results from the same prompt; conflicting cell assignments fail closed. Raw,
expired, revoked or forged rows remain visible only through explicit
`all_count`/retro fields; they cannot increase qualified coverage, satisfy a
cell target or make the hard-scope view ready.

The active calibration baseline is protected by an identity-scoped unique
Mongo slot so two concurrent ratifications cannot leave two active baselines
for one exact judge on a standalone Mongo deployment. Activation fields are
immutable through ordinary creates, saves, updates, replacements, pipelines,
upserts, `insertMany`, and `bulkWrite`; only the model-owned ratification
transition may change them. Baseline content is append-only by label: an exact
replay is idempotent, while different metrics or provenance under the same
label and judge identity fail with a conflict before any bytes change. This
does not qualify a judge by itself. Ratification validates a complete unique
seven-category inventory, finite bounded correlations, and sufficient integer
sample counts before it materializes anything or deactivates the prior baseline.

## Retention and reset

Archive, prune, and dead-model purge resolve receipted opaque batch ids back to
their internal Mongo batches before deleting results. Receipted results,
timelines, embedded evidence arrays, and batch descriptions are preserved.
Dry-runs separate protected counts and expose only opaque source-batch ids.
A global reset fails with HTTP 409 while any append-only receipt or any sealed
batch/result marker exists. Archive, prune, purge, and clear also treat sealed
markers as protected even when an interrupted issuance has not inserted its
receipt; this preserves partially sealed crash-recovery state for manual review.
The result-wide and failed-result cleanup paths also resolve and verify every
stored receipt before deletion, then exclude all linked batches. A tampered
payload or indexed projection aborts cleanup before any result is removed. The
destructive retention guard verifies the complete append-only receipt ledger;
it never selects receipts through an unverified index projection first.
The same lock serializes reset and retention with receipt creation, while the
sealed-result model guard prevents score, exclusion or review mutations from
rewriting already receipted evidence.

The Mongo integration tests prove this mapping with real batches, reject
pending or count-mismatched sources, forged WorkerReceipts and negative
external verification, preserve receipted rows through cleanup, block
score/exclusion/delete rewrites, reject post-receipt insert/upsert/reparent
attempts, preserve partially sealed states, and exercise concurrent insertion,
finalization, issuance and global cleanup.

## Required order and stop conditions

1. Review and merge the Product integration onto the current Product main.
2. Pass the Linux and Windows `benchmark-trust-portability` matrix.
3. Build an immutable Product image set; do not update AIOps pins yet.
4. Run the source-batch migration dry-run in staging and review its counts;
   verify the unique `trust_campaign_spec_id` index before enabling launch.
5. Apply the reviewed migration/index in staging, then rerun receipt/store,
   retention and one-shot launch tests.
6. Freeze the judge, corpus splits, rubric, inference contract, ranking policy,
   repeat schedule, and candidate universe.
7. Produce signed blind-independent human labels and a real signed judge
   qualification attestation.
8. Install the reviewed content-addressed CampaignSpec and enable the strict
   launcher only for the bounded acceptance window.
9. Run a harness campaign and retain all fingerprinted evidence artifacts.
10. Have a human/AIOps authority verify and ratify the exact receipt.
11. Only then may a separate guarded promotion proposal be considered.

Stop immediately on an unqualified or expired judge, incomplete cell matrix,
repeat-index mismatch, missing source-batch mapping, noncanonical receipt,
failed Windows/Linux gate, missing independent human provenance, or failed
judge/ratification/source-evidence verification. Also stop on a partially
sealed inventory or an existing trust-evidence mutation lock whose owner cannot
be proven inactive. No receipt or statistical winner alone authorizes routing
or deployment.

## Rollback

Before deployment, rollback is a normal Product code revert. After migration,
opaque batch ids are harmless additive metadata and should remain; do not
delete or rewrite them. Append-only receipts must never be removed during a
rollback. Disable a not-yet-trusted consumer or issue a separate verified
revocation attestation instead.
