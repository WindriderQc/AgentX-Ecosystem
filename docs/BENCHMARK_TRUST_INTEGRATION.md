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

Only bounded reads are registered:

- `GET /api/benchmark/trust-receipts/:receiptId`
- `GET /api/benchmark/trust-receipts?source_batch_id=batch_<32hex>&limit=N`

There is deliberately no HTTP issuance, ratification, revocation, promotion,
or routing endpoint in this change.

Before any automated issuer is added, it must serialize receipt insertion with
destructive retention. The present foundation has no issuance route, so that
cross-collection race is not reachable through the Product API; it must not be
made reachable without a standalone-Mongo-safe lock or equivalent protocol.

## Statistical gate

The independent unit is the prompt. Repeated attempts are averaged inside each
candidate-prompt cell. Every row must carry a unique `repeatIndex` from zero
through the preregistered `repeatCount - 1`; duplicate, missing, extra, or
invalid repeats fail the whole interval family closed.

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
as independent human ground truth. Only `independent_human_score` and
`adjudicated_human_score` enter the qualified-human loader.

The active calibration baseline is protected by a unique Mongo slot so two
concurrent ratifications cannot leave two active baselines on a standalone
Mongo deployment. This does not qualify a judge by itself.

## Retention and reset

Archive, prune, and dead-model purge resolve receipted opaque batch ids back to
their internal Mongo batches before deleting results. Receipted results,
timelines, embedded evidence arrays, and batch descriptions are preserved.
Dry-runs separate protected counts and expose only opaque source-batch ids.
A global reset fails with HTTP 409 while any append-only receipt exists.

The Mongo integration test proves this mapping with two real batches: the
unreceipted batch is archived while the receipted batch's result, timeline, and
metadata remain intact.

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
ratification verification. No receipt or statistical winner alone authorizes
routing or deployment.

## Rollback

Before deployment, rollback is a normal Product code revert. After migration,
opaque batch ids are harmless additive metadata and should remain; do not
delete or rewrite them. Append-only receipts must never be removed during a
rollback. Disable a not-yet-trusted consumer or issue a separate verified
revocation attestation instead.
