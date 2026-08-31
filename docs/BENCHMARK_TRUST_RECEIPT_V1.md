# BenchmarkTrustReceipt v1

`agentx.benchmark-trust-receipt/v1` is the portable, privacy-safe evidence
contract for a Benchmark decision. It records what was compared and which
frozen evidence supports the decision. It does not run a campaign, approve a
result, route traffic, change a deployment pin, or promote a model.

## Trust boundary

AgentX owns this pure contract and its deterministic validation. AIOps and a
human reviewer own the separate ratification attestation and every operational
decision that consumes it. Harnesses own execution and evidence capture.

The receipt contains only opaque campaign, source-batch, and candidate
identifiers plus SHA-256 fingerprints. Raw prompts, raw responses, provider
payloads, secrets, network addresses, host names, file paths, and private
environment identifiers are forbidden.

## Content identity

`receiptId` is the lowercase SHA-256 digest of the stable serialization of the
normalized receipt body, excluding `receiptId` itself. Candidate identities and
equivalence-set members are sorted before hashing. Equivalent input ordering
therefore produces one identity, while any material change produces another.

The `candidateSetFingerprint` independently binds the sorted candidate ID,
artifact, runtime, and logical-environment fingerprints. Per-candidate result
sets remain separately bound by `resultSetFingerprint`.

## Independent axes

The system keeps four result axes independent. The immutable evidence receipt
stores the first three:

- evidence: `complete`, `incomplete`, `incompatible`, or `invalid`;
- decision: `winner`, `equivalence_set`, `inconclusive`, or `not_evaluated`;
- freshness: `fresh`, `stale`, or `expired`.

Ratification is the fourth axis: `unratified`, `ratified`, or `revoked`. It is
derived at read time from a separate verified attestation and current revocation
state. It is never predeclared inside the immutable evidence receipt.

`claimScope` is separately either portable `capability` evidence or private
`deployment_fit` evidence. Missing or incompatible evidence is never converted
to a zero, loss, winner, or equivalence claim.

There is deliberately no caller-supplied `qualified` or `qualifiedWinner`
field. `deriveBenchmarkQualification()` returns a qualified winner only when:

1. the receipt is structurally valid and its content identity matches;
2. evidence is complete and the paired statistical decision is `winner`;
3. both receipt and judge qualification are fresh at verification time;
4. the judge qualification is `qualified` and a mandatory consumer-supplied
   verifier confirms its exact qualification receipt, judge identity, rubric,
   corpus, sealed holdout, validity and current revocation state;
5. a valid, separate `agentx.benchmark-trust-ratification/v1` attestation binds
   that exact `receiptId` and confirms `ratified`; and
6. an AIOps/human verifier confirms the ratification authority against its live
   trust root and current revocation state. Product has no permissive default.

An equivalence set or inconclusive result is a valid and useful receipt, but it
does not manufacture a qualified leader.

## Bound evidence

The receipt binds the exact Product revision and Core/Benchmark/RAG image
digests; campaign, source batch, inference-profile, prompt-catalog, candidate-set
and result fingerprints; expected, observed and excluded result counts; the
judge identity, rubric, corpus, sealed holdout and qualification receipt; and
the statistical method, alpha, multiplicity correction, minimum effect and
decision artifact. The opaque `sourceBatchId` is the durable Product mapping
used by storage and retention to protect the exact referenced result batch; it
is not a private Mongo identifier.
The statistical preregistration binds an explicit `repeatCount` and immutable
analysis-plan fingerprint. A separate ranking-policy fingerprint freezes the
policy that interprets those statistics. The only statistical
method/correction accepted by v1 is
`paired-prompt-t-v1`: repeats are averaged within prompt, paired Student-t
intervals use prompt as the independent unit, and `bonferroni` covers every
candidate pair. Bootstrap, permutation, Holm and uncorrected (`none`) claims
require a future schema version and cannot be mixed into a v1 receipt.
`expectedResultCount` must equal candidates times prompts times
repeats. Complete evidence requires every preregistered cell and zero exclusions;
otherwise a winner is structurally impossible. A compact cell inventory binds
its artifact fingerprint, exact cell count, and minimum/maximum repeat
cardinality so a missing cell cannot be hidden by a duplicate elsewhere.

Excluded results require a manifest fingerprint and remain part of the full
inventory. Unknown schema versions, unknown keys, duplicate candidates,
non-finite numbers, bad fingerprints and contradictory decisions fail closed.

## Integration sequence

1. A harness freezes inputs and produces the complete evidence artifacts.
2. Product code builds and validates the immutable receipt.
3. Before persistence, an explicit source-evidence verifier recomputes the
   inventory and fingerprints against a terminal source batch. Product then
   seals those exact result rows against update or deletion.
4. AIOps independently verifies the receipt, judge qualification and freshness.
5. A human reviewer issues the separate ratification attestation for the exact
   `receiptId`, or later issues a revocation.
6. A consumer derives the qualification state at read time. Promotion remains
   a separate guarded AIOps action.

The integrated foundation provides append-only persistence and bounded read
endpoints only. It intentionally provides no HTTP issuance, campaign runner,
ratification, routing, or promotion behavior.
