# Benchmark Trust integration

This layer integrates the pure `BenchmarkTrustReceipt v1` contract with the
Benchmark service without granting Product any deployment, routing, or human
ratification authority. It is an implementation foundation, not campaign
acceptance.

## Ownership

| Concern | Owner | Product behavior |
|---|---|---|
| Receipt schema, canonical identity, structural validation | Product | `shared/benchmarkTrustReceipt.js` |
| Statistical decision artifact | Product | paired prompt means, exact repeat indexes, simultaneous Bonferroni Student-t intervals |
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
identity, rubric/policy, target, tools, execution profile, scoring
method/version, score-envelope fingerprint, and prompt fingerprints. Every row
must carry two complete, self-fingerprinted `agentx.worker-receipt/v1`
documents. The execution receipt is bound to that row's candidate, prompt,
repeat, response and success result. The judge receipt is bound to the same
row's response and score plus the frozen rubric and judge identity. Candidate
envelope sets are recomputed across the exact preregistered rows. A minimal or
modified receipt, a receipt with a different envelope, or reuse of one row's
receipt for another row fails closed.
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

Only bounded reads are registered:

- `GET /api/benchmark/trust-receipts/:receiptId`
- `GET /api/benchmark/trust-receipts?source_batch_id=batch_<32hex>&limit=N`

There is deliberately no HTTP issuance, ratification, revocation, promotion,
or routing endpoint in this change.

Receipt insertion and every destructive cleanup path share the standalone-
Mongo-safe `benchmark-trust-evidence-mutation-v1` mutex. The store holds it
while it verifies and inserts; Trust finalization uses the same mutex while it
seals results and finalizes the batch. Archive, prune, purge, global/failed
clear and reset hold it from protection discovery through deletion. Cleanup
may remove an eligible legacy or not-yet-finalized inventory. Once Trust
finalization wins, later cleanup sees the durable seals and preserves the
evidence even if receipt issuance is later rejected. The mutex has
no automatic stale expiry: a process crash leaves mutation blocked until a
human verifies that no owner is active and performs explicit recovery.

## Statistical gate

The independent unit is the prompt. Repeated attempts are averaged inside each
candidate-prompt cell. Every row must carry a unique `repeatIndex` from zero
through the preregistered `repeatCount - 1`; duplicate, missing, extra, or
invalid repeats fail the whole interval family closed.

Both `candidateIds` and `promptIds` are mandatory preregistration fields. The
statistics service never infers a decision-eligible universe from observed
rows; a missing universe produces an explicit inconclusive result.

The v1 decision uses paired prompt differences, two-sided Student-t intervals,
and a Bonferroni family over every unordered candidate pair. A winner exists
only when one candidate's simultaneous lower bound is strictly greater than
the preregistered minimum effect against every competitor. Otherwise the
result is an equivalence set, inconclusive, or not evaluated. The projection
to the shared receipt converts alpha to basis points, the minimum effect to
microunits, and derives the decision fingerprint from the normalized decision
artifact.

## Judge and human evidence

Courthouse approve and override actions remain useful review evidence, but the
current judge-visible, single-review flow is explicitly classified as either
`endorsed_judge_score` or `human_override_visible_judge`. Neither is eligible
as independent human ground truth. Only `independent_human_score` paired with
`blind_independent` or `blind_double_review`, and `adjudicated_human_score`
paired with `adjudicated`, enter the qualified-human loader. The model rejects
contradictory qualified provenance/protocol pairs before persistence. Those two
fields are one atomic evidence claim: query updates must write a complete valid
pair together, while update pipelines and provenance-bearing `$setOnInsert`
operations are rejected.

This foundation deliberately exposes no authority for importing new qualified
human evidence. Ordinary `save`, `create`, query-update, and `insertMany`
surfaces reject a qualified provenance/protocol pair, even when its fields are
internally consistent. Existing qualified rows remain readable for migration
and audit, but a future import path must verify an immutable human attestation
before it may write one. Self-declared reviewer, date, or source fields are not
an authority. Until that path exists, judge qualification must remain blocked
and the separate AIOps `verifyJudgeQualification` trust-root check is mandatory.

Judge drift consumes only that qualified-human loader. Missing samples or an
incomplete/missing baseline remain explicit `insufficient_data` or
`no_baseline` states and are never collapsed to `ok`.

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
4. Run the source-batch migration dry-run in staging and review its counts.
5. Apply the migration in staging, then rerun receipt/store/retention tests.
6. Freeze the judge, corpus splits, rubric, inference contract, ranking policy,
   repeat schedule, and candidate universe.
7. Produce independent or adjudicated human labels and a real judge
   qualification receipt.
8. Run a harness campaign and retain all fingerprinted evidence artifacts.
9. Have a human/AIOps authority verify and ratify the exact receipt.
10. Only then may a separate guarded promotion proposal be considered.

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
