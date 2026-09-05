# BenchmarkTrustReceipt v2

`agentx.benchmark-trust-receipt/v2` is the current portable, privacy-safe evidence
contract for a Benchmark decision. It records what was compared and which
frozen evidence supports the decision. It does not run a campaign, approve a
result, route traffic, change a deployment pin, or promote a model.

The reader remains byte-compatible with already stored
`agentx.benchmark-trust-receipt/v1` records so append-only history and retention
do not break. It accepts the four preregistration keysets historically emitted
by v1 (2, 6, 8, or 9 exact fields), including the original minimal
`repeatCount` plus `analysisPlanFingerprint` form. V1 receipts are read-only
legacy evidence and can never become newly qualified. The v1 reader retains
the historical `paired-prompt-t-v1`, `paired-bootstrap-v1`, and
`paired-permutation-v1` methods, plus `bonferroni`, `holm-bonferroni`, and
`none` corrections and the historical zero minimum-effect margin. New issuers
must emit v2.

## Trust boundary

AgentX owns this pure contract and its deterministic validation. AIOps and a
human reviewer own the separate ratification attestation and every operational
decision that consumes it. Harnesses own execution and evidence capture.

The receipt contains only opaque campaign, source-batch, and candidate
identifiers plus SHA-256 fingerprints. Raw prompts, raw responses, provider
payloads, secrets, network addresses, host names, file paths, and private
environment identifiers are forbidden.

Generic Benchmark batch GET surfaces apply a Trust-specific allowlist: they
expose only opaque campaign/candidate/prompt ids, lifecycle counters and
numeric metrics. Generic result, facet, leaderboard, diagnostic and analytics
reads, including read-only POST diagnostics, exclude strict Trust rows entirely.
Generic batch comparison and explicit regression comparison reject strict
campaigns; automatic regression selection skips them. Full/heavy-text flags,
active/tag statistics, stop/recovery responses, retention reports and legacy
rerun responses cannot reveal Trust prompts, responses, judge prompts,
hints/templates, tags, run names, model/host/provider identities or private
execution settings. Trust timelines are similarly reduced, and a Trust batch
cannot be copied into a reusable Benchmark template.

Signed human-review rows retain the sealed prompt, response, rationale and
attestation only for current cryptographic verification and exact judge
qualification. Generic ground-truth lists and every legacy judge validation,
matrix, governance, or auto-calibration path fail closed on any attestation
marker. Retro-calibration and legacy governance also reject strict source
batches directly. A narrow request-local verifier scope may reload sealed rows
only while revalidating a supplied signed attestation; it does not weaken
generic public reads.

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

`claimScope` is separately either controlled-condition `capability` evidence or
exact-environment `deployment_fit` evidence. Both remain bound to the candidate
artifact, runtime, environment and execution identities in the receipt; neither
is a universal model claim. The exploratory archive is intentionally a view of
unqualified observations, not a third claim scope. Missing or incompatible
evidence is never converted to a zero, loss, winner, or equivalence claim.

There is deliberately no caller-supplied `qualified` or `qualifiedWinner`
field. `deriveBenchmarkQualification()` returns a qualified winner only when:

1. the receipt is structurally valid and its content identity matches;
2. evidence is complete and the paired statistical decision is `winner`;
3. both receipt and judge qualification are fresh at verification time;
4. a mandatory consumer-supplied verifier validates that the exact frozen
   analysis plan supports the prompt-independence assumption; unique prompt
   identifiers alone are not evidence of independent sampling;
5. a mandatory consumer-supplied verifier revalidates the separately signed
   variance-pilot attestation, its exact source/result inventory, key scope,
   validity and current revocation state;
6. the judge qualification is `qualified` and a mandatory consumer-supplied
   verifier confirms its exact qualification receipt, judge identity, rubric,
   corpus, sealed holdout, validity and current revocation state;
7. a valid, separate `agentx.benchmark-trust-ratification/v1` attestation binds
   that exact `receiptId` and confirms `ratified`; and
8. an AIOps/human verifier confirms the ratification authority against its live
   trust root and current revocation state. Product has no permissive default.

An equivalence set or inconclusive result is a valid and useful receipt, but it
does not manufacture a qualified leader.
The derived result always echoes the validated `claimScope` (or `null` for an
invalid scope) so a consumer can display the authority boundary with the
winner instead of silently extrapolating it.

## Bound evidence

The receipt binds the exact Product revision and Core/Benchmark/RAG image
digests; campaign, source batch, inference-profile, prompt-catalog, candidate-set
and result fingerprints; expected, observed and excluded result counts; the
judge identity, rubric, corpus, sealed holdout and qualification receipt; and
the statistical method, alpha, multiplicity correction, minimum effect and
decision artifact. The opaque `sourceBatchId` is the durable Product mapping
used by storage and retention to protect the exact referenced result batch; it
is not a private Mongo identifier.
The statistical preregistration binds an explicit `repeatCount`, a powered
alternative effect strictly above the minimum-effect superiority margin, the
required independent-prompt count, target power, the conservative maximum paired
standard deviation, immutable variance-basis, power-analysis and analysis-plan
fingerprints, plus the signed variance-pilot attestation id. The variance basis
is a content-addressed pre-campaign artifact from an independent pilot cohort:
it records the cohort,
sample size, provenance, method, confidence level, observed paired deviation
and its one-sided chi-square upper confidence bound. Product recomputes that
bound deterministically, requires it to exceed the observed deviation, and
binds the pilot to the exact candidate set, judge rubric and complete unordered
pair family. The pilot lists every pair canonically and the planning deviation
is derived from the maximum listed paired deviation, so a difficult pair cannot
be omitted behind an average. It also binds the repeat count, exact candidate
inference profiles and generation parameters, and a Product-recomputed prompt
policy. That policy fingerprints the campaign selection artifact, the exact
set of prompt-source fingerprints, and a cross-platform semantic fingerprint
of `buildPromptHints` and its normalization/template dependencies plus every
normalized field that can change candidate-visible
prompt text, including custom hints, answer/length contracts, thinking
instructions and templates. A separate Ed25519 attestation with the dedicated
`benchmark-variance-pilot-v1` key scope signs the variance-basis fingerprint,
the canonical pilot prompt inventory, the source receipt and result-inventory
fingerprints, and those comparability bindings. An opaque or invented cohort is
therefore insufficient for qualification. The strict launcher trusts the
configured pilot issuer's signed summary for admission and does not load the
private pilot rows; the mandatory consumer verifier must replay those exact
source/result inventories before qualification. The planned deviation must equal the recomputed bound. Product
then recomputes the required prompt count from the bounded score domain and
the frozen hypothesis. The variance pilot remains a signed comparability and
drift guard; it never narrows the distribution-free score range or required
sample size. An undersized prompt universe, a forged basis or power fingerprint,
non-finite evidence, a score outside `[0, 10]`, or campaign deviation above the
preregistered bound can produce only an inconclusive decision. Zero observed
paired variance is valid bounded evidence. A separate
ranking-policy fingerprint freezes the policy that interprets those
statistics. The only statistical method/correction accepted by v2 is
`paired-prompt-hoeffding-v1`: repeats are averaged within prompt, each paired
prompt-mean difference is bounded in `[-10, 10]`, and `bonferroni` covers every
unordered candidate pair. With `F = k(k - 1) / 2` candidate pairs, score range
`R = 20`, and family alpha `alpha`, the simultaneous two-sided radius is
`R * sqrt(log(2F / alpha) / (2n))`. An equivalence margin cannot exceed the
minimum effect. A top
equivalence set requires every internal pair to be equivalent and every member
to be strictly superior to every excluded candidate. Bootstrap, permutation,
Student-t, Holm and uncorrected (`none`) claims cannot be mixed into a v2
receipt. Their historical v1 forms remain readable for retention and audit
only, never for new qualification; any future issuer that reintroduces them
requires a new schema version and frozen hypotheses.
The power calculation tests the same superiority margin as the winner rule:
its signal is `poweredAlternativeEffect - minimumEffect`, never the powered
alternative against zero. The alternative is required, fingerprinted, and
scaled to microunits in the receipt; no implicit default is accepted. Product
uses a distribution-free family miss bound. For excess signal `g`, target
power `p`, pair family `F`, and range `R = 20`, the direct count is the ceiling
of `[R * (sqrt(log(2F/alpha)/2) + sqrt(log(F/(1-p))/2)) / g]^2`; Product verifies
that exact `n` meets the bound and `n - 1` does not. The score domain requires
every input score in `[0, 10]` and
`0 < minimumEffect < poweredAlternativeEffect <= 10`. These guarantees are
intentionally conservative. A narrow powered gap can require thousands of
independent prompts or exceed the launcher's prompt cap; that campaign remains
underpowered and cannot emit a winner. A more efficient assumption-dependent
method requires a future schema and its own frozen hypotheses.
Hoeffding's guarantee still assumes independent prompt-level observations.
Product can bind prompt identities and the analysis-plan fingerprint, but it
cannot infer independence from uniqueness. `deriveBenchmarkQualification()`
therefore requires `verifyPromptIndependence` to validate the exact frozen plan
against external signed or explicit human evidence; absence, rejection, or an
exception remains `prompt_independence_not_verified` and blocks qualification.
Qualification first takes canonical, recursively frozen snapshots of both the
receipt and ratification, and captures the verification time plus all four
verifier authorities before invoking any callback. Every external verifier
receives only those snapshots, and the returned winner and status are derived
from the same snapshots, so a callback cannot change the evidence identity,
clock, or another authority during verification.
`expectedResultCount` must equal candidates times prompts times
repeats. Complete evidence requires every preregistered cell and zero exclusions;
otherwise a winner is structurally impossible. A compact cell inventory binds
its artifact fingerprint, exact cell count, and minimum/maximum repeat
cardinality so a missing cell cannot be hidden by a duplicate elsewhere.

Every stored score is also bound to a normalized, content-addressed
`agentx.worker-receipt/v1`. Product recomputes its result fingerprint from the
exact candidate, prompt, repeat, response, score, rubric, and judge identity,
so a minimal receipt, a modified receipt, or reuse across rows fails closed.
This proves content integrity and row binding; issuer authority still comes
from the separately verified judge qualification attestation.

Excluded results require a manifest fingerprint and remain part of the full
inventory. Unknown schema versions, unknown keys, duplicate candidates,
non-finite numbers, bad fingerprints and contradictory decisions fail closed.

## Integration sequence

1. Before execution, Product server code commits a strict source context to a
   pending, empty batch. The server-owned commit timestamp proves precedence;
   caller-authored or post-start timestamps are not accepted.
2. A harness executes that context and persists the opaque preregistered
   candidate and prompt identities on every result row.
3. Product code builds and validates the immutable receipt from raw rows, not
   from a caller-supplied statistical evaluation.
4. Before persistence, the mandatory Product source verifier reloads the
   sealed Mongo rows and recomputes identities, inventory, exclusions,
   fingerprints, statistics and decision against the terminal source batch.
   Completion validates the canonical inventory both immediately before and
   after result sealing. Evidence changed in that window leaves an immutable,
   terminal failed batch rather than a completed or recoverably mutable one.
   A deployment-specific verifier may only add another check; it cannot replace
   Product verification. Product then keeps those exact rows immutable.
5. AIOps independently verifies the receipt, variance pilot, judge qualification
   and freshness against current roots and revocations.
6. A human reviewer issues the separate ratification attestation for the exact
   `receiptId`, or later issues a revocation.
7. A consumer derives the qualification state at read time. Promotion remains
   a separate guarded AIOps action.

The integrated foundation provides append-only persistence, bounded read
endpoints, and one disabled-by-default strict campaign launcher. It
intentionally provides no HTTP receipt issuance, ratification, routing, or
promotion behavior. The strict launcher accepts only a content-addressed
server-side CampaignSpec reference, requires the exact running Product image
manifest and isolated harness targets, atomically commits source context before
execution, and persists opaque cell identities plus private full
WorkerReceipts. The general Benchmark start API, legacy batches, and ordinary
batches remain deliberately ineligible for receipt issuance instead of
receiving inferred evidence.

The strict launcher also verifies a complete signed
`agentx.benchmark-judge-qualification-attestation/v1` against server-owned
Ed25519 roots, scoped key windows and a current version-pinned revocation
snapshot whose exact content identity is operator-pinned. Its exact 35-cell
category x difficulty inventory carries at least two validation and three
sealed holdout observations in every cell (70/105 overall), with coherent
cell, category and corpus totals. Each cell also carries signed MAE and
tolerance metrics and independently meets MAE <= 1.5 and tolerance >= 75%; a
category average cannot hide a failing difficulty. Category and overall
metrics must equal the canonical holdout-count-weighted aggregation of their
signed children, so contradictory summaries cannot manufacture qualification.
The attestation cannot outlive its signing
key. The signed rubric must equal the canonical scorer, prompt, scoring
dimensions/weights, invocation, result-contract, tool and policy artifact
executed by the runtime. That artifact retains fingerprints of the loaded
functions, scoring configuration and exact Product source modules, including
the judge executor that projects TASK/EXPECTED/scoring fields into the actual
judge prompt, so a receipt verifier can recompute the rubric binding. The
launcher freezes prompt-source fingerprints and exact
candidate/judge harness invocation parameters, and consumes each CampaignSpec
id once behind the Product operator credential. This
Product admission check does not replace the consumer-side
`verifyVariancePilot` and `verifyJudgeQualification` callbacks: consumers still
re-evaluate both current authorities, their exact private source inventories,
and revocation state when deriving qualification. Product treats a configured
qualification issuer's signed summary as launch authority; it does not claim
to recompute the raw holdout experiment during admission. Startup also rejects any CampaignSpec uniqueness index whose
partial filter is not exactly the Product-declared string-id filter.
